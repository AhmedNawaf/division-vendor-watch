import { DiscordDeliveryError } from "../errors.js";
import type { RateLimiter } from "./rate-limiter.js";

/**
 * Deliver messages to a user via **direct message**, using the Discord bot API (the multi-user
 * bot path). This differs from `send-webhook.ts`: it authenticates with a bot token and is a
 * two-step flow — open (or reuse) the DM channel for the user, then post to it.
 *
 * The bot token is a secret and is never included in errors or logs.
 */
export interface SendDmOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  /** Retries for transient failures (network/5xx). Rate-limit waits are separate. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable delay, so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on consecutive 429 waits before giving up. */
  maxRateLimitRetries?: number;
  /** API base, injectable for tests. Defaults to the Discord v10 API. */
  apiBase?: string;
  /** Shared pacing across the whole run; also where global 429 pauses are applied. */
  limiter?: RateLimiter;
}

/** Discord error codes we treat as permanent — retrying these only earns invalid requests. */
const CANNOT_SEND_TO_USER = 50007;
const UNKNOWN_CHANNEL = 10003;

/**
 * A refusal that will not resolve by retrying: the user blocked the bot, closed DMs, or does
 * not exist. The caller should stop attempting them rather than burn a 403 every week —
 * Discord bans an IP after 10,000 invalid (401/403/429) requests in 10 minutes, so repeated
 * doomed retries are an availability risk, not just noise.
 */
export class DiscordUndeliverableError extends DiscordDeliveryError {
  override readonly code = "DISCORD_UNDELIVERABLE";
}

function discordErrorCode(detail: string | undefined): number | undefined {
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as { code?: number };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULTS = {
  maxRetries: 3,
  timeoutMs: 15_000,
  maxRateLimitRetries: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  apiBase: "https://discord.com/api/v10",
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  return Math.min(DEFAULTS.baseBackoffMs * 2 ** attempt, DEFAULTS.maxBackoffMs);
}

const DM_CHANNELS_PATH = "/users/@me/channels";

/** A global 429 is signalled by the `X-RateLimit-Global` header or `global: true` in the body. */
async function isGlobalRateLimit(res: Response): Promise<boolean> {
  if (res.headers.get("x-ratelimit-global")) return true;
  if (res.headers.get("x-ratelimit-scope") === "global") return true;
  try {
    const body = (await res.clone().json()) as { global?: boolean };
    return body.global === true;
  } catch {
    return false;
  }
}

async function readRetryAfterMs(res: Response): Promise<number> {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (!Number.isNaN(seconds)) return Math.ceil(seconds * 1000);
  }
  try {
    const body = (await res.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number") return Math.ceil(body.retry_after * 1000);
  } catch {
    // ignore malformed body; fall through to a default wait
  }
  return 1000;
}

/**
 * Discord's error body, trimmed for an error context. Never contains our token — this is the
 * server's own response — but it is truncated so a stray HTML error page can't flood the logs.
 */
async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST to a Discord API endpoint with retry + 429 handling, returning the parsed JSON body.
 * Fails fast on permanent 4xx. Never leaks the token.
 */
async function discordPost(
  path: string,
  payload: unknown,
  options: SendDmOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULTS.maxRateLimitRetries;
  const apiBase = options.apiBase ?? DEFAULTS.apiBase;

  if (!options.botToken) {
    throw new DiscordDeliveryError("A Discord bot token is required to send direct messages");
  }

  let transientAttempts = 0;
  let rateLimitAttempts = 0;

  for (;;) {
    // Pace every request through the shared limiter, so one user's messages can't burst.
    if (options.limiter) await options.limiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bot ${options.botToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (transientAttempts >= maxRetries) {
        throw new DiscordDeliveryError(
          `Network error calling Discord after ${transientAttempts + 1} attempts`,
          { attempts: transientAttempts + 1, path },
          { cause: err },
        );
      }
      await sleep(backoffMs(transientAttempts));
      transientAttempts += 1;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        return undefined;
      }
    }

    if (res.status === 429) {
      if (rateLimitAttempts >= maxRateLimitRetries) {
        throw new DiscordDeliveryError(
          `Discord rate limit not cleared after ${rateLimitAttempts} waits`,
          { status: 429, path },
        );
      }
      const waitMs = await readRetryAfterMs(res);
      // A *global* 429 means stop everything, not just this route. Continuing to send on other
      // routes during a global limit is what escalates a 429 into an IP-level ban.
      if (await isGlobalRateLimit(res)) {
        options.limiter?.pauseFor(waitMs);
      }
      await sleep(waitMs);
      rateLimitAttempts += 1;
      continue;
    }

    if (res.status >= 400 && res.status < 500) {
      // Discord explains itself in the body (e.g. code 50007 "Cannot send messages to this
      // user"). Keeping it is the difference between a debuggable failure and a bare 403.
      const detail = await readErrorDetail(res);
      const errorCode = discordErrorCode(detail);
      const context = { status: res.status, path, detail, discordCode: errorCode };

      // Create DM answers 400 (not 403) when the recipient blocked the bot or closed DMs,
      // so a 400 on that route is a permanent refusal rather than a malformed request.
      const permanent =
        errorCode === CANNOT_SEND_TO_USER ||
        (res.status === 400 && path === DM_CHANNELS_PATH) ||
        res.status === 403;

      if (permanent) {
        throw new DiscordUndeliverableError(
          `Discord will not deliver to this user (HTTP ${res.status}${
            errorCode ? `, code ${errorCode}` : ""
          })`,
          context,
        );
      }

      throw new DiscordDeliveryError(`Discord rejected the request with HTTP ${res.status}`, context);
    }

    if (transientAttempts >= maxRetries) {
      throw new DiscordDeliveryError(
        `Discord server error HTTP ${res.status} after ${transientAttempts + 1} attempts`,
        { status: res.status, attempts: transientAttempts + 1, path },
      );
    }
    await sleep(backoffMs(transientAttempts));
    transientAttempts += 1;
  }
}

/** Open (or reuse) the DM channel for a user, returning its channel id. */
async function openDmChannel(userId: string, options: SendDmOptions): Promise<string> {
  const channel = (await discordPost(DM_CHANNELS_PATH, { recipient_id: userId }, options)) as {
    id?: string;
  };
  if (!channel?.id) {
    throw new DiscordDeliveryError("Discord did not return a DM channel id", { userId });
  }
  return channel.id;
}

export interface SendDmResult {
  /** The channel used. Persist it — reusing it is what keeps us off the Create DM endpoint. */
  channelId: string;
  /** True when we had to call Create DM (no usable cached channel). */
  openedChannel: boolean;
}

/**
 * Deliver several messages to one user's DM, in order.
 *
 * Pass `cachedChannelId` from a previous run to skip the Create DM call entirely. Discord's own
 * docs warn that opening many DMs quickly can get a bot blocked from opening new ones, and DM
 * channel ids are stable, so reuse is both cheaper and materially safer. If a cached id has gone
 * stale (`10003 Unknown Channel`) we reopen once and report the new id.
 */
export async function sendDirectMessages(
  userId: string,
  messages: string[],
  options: SendDmOptions,
  cachedChannelId?: string,
): Promise<SendDmResult> {
  if (messages.length === 0) {
    return { channelId: cachedChannelId ?? "", openedChannel: false };
  }
  const sleep = options.sleep ?? defaultSleep;

  let channelId = cachedChannelId;
  let openedChannel = false;
  if (!channelId) {
    channelId = await openDmChannel(userId, options);
    openedChannel = true;
  }

  for (let i = 0; i < messages.length; i += 1) {
    try {
      await discordPost(`/channels/${channelId}/messages`, { content: messages[i] }, options);
    } catch (err) {
      const stale =
        !openedChannel &&
        err instanceof DiscordDeliveryError &&
        discordErrorCode((err.context as Record<string, unknown> | undefined)?.detail as string) ===
          UNKNOWN_CHANNEL;
      if (!stale) throw err;

      // The cached channel no longer resolves; reopen once and retry this message.
      channelId = await openDmChannel(userId, options);
      openedChannel = true;
      await discordPost(`/channels/${channelId}/messages`, { content: messages[i] }, options);
    }
    if (i < messages.length - 1) await sleep(300);
  }

  return { channelId, openedChannel };
}
