import { DiscordDeliveryError } from "../errors.js";

export interface SendWebhookOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  /** Retries for transient failures (network/5xx). Rate-limit waits are separate. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable delay, so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on consecutive 429 waits before giving up. */
  maxRateLimitRetries?: number;
}

const DEFAULTS = {
  maxRetries: 3,
  timeoutMs: 15_000,
  maxRateLimitRetries: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  return Math.min(DEFAULTS.baseBackoffMs * 2 ** attempt, DEFAULTS.maxBackoffMs);
}

/** Extract the rate-limit wait (ms) from a Discord 429 response. */
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
 * Deliver a single message to a Discord webhook.
 * - Retries transient network/5xx failures with exponential backoff.
 * - Honors 429 rate limits via retry_after.
 * - Fails fast on permanent 4xx (validation) errors.
 * Never includes the webhook URL in errors or logs.
 */
export async function sendDiscordMessage(
  content: string,
  options: SendWebhookOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULTS.maxRateLimitRetries;

  if (!options.webhookUrl || !/^https:\/\//i.test(options.webhookUrl)) {
    throw new DiscordDeliveryError("A valid https Discord webhook URL is required");
  }

  let transientAttempts = 0;
  let rateLimitAttempts = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (transientAttempts >= maxRetries) {
        throw new DiscordDeliveryError(
          `Network error delivering to Discord after ${transientAttempts + 1} attempts`,
          { attempts: transientAttempts + 1 },
          { cause: err },
        );
      }
      await sleep(backoffMs(transientAttempts));
      transientAttempts += 1;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok || res.status === 204) return;

    if (res.status === 429) {
      if (rateLimitAttempts >= maxRateLimitRetries) {
        throw new DiscordDeliveryError(
          `Discord rate limit not cleared after ${rateLimitAttempts} waits`,
          { status: 429 },
        );
      }
      const waitMs = await readRetryAfterMs(res);
      await sleep(waitMs);
      rateLimitAttempts += 1;
      continue;
    }

    if (res.status >= 400 && res.status < 500) {
      // Permanent validation error — retrying will not help.
      throw new DiscordDeliveryError(`Discord rejected the message with HTTP ${res.status}`, {
        status: res.status,
      });
    }

    // 5xx — transient server error.
    if (transientAttempts >= maxRetries) {
      throw new DiscordDeliveryError(
        `Discord server error HTTP ${res.status} after ${transientAttempts + 1} attempts`,
        { status: res.status, attempts: transientAttempts + 1 },
      );
    }
    await sleep(backoffMs(transientAttempts));
    transientAttempts += 1;
  }
}

/** Deliver several messages in order, with a small spacing delay to be gentle on rate limits. */
export async function sendDiscordMessages(
  messages: string[],
  options: SendWebhookOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  for (let i = 0; i < messages.length; i += 1) {
    await sendDiscordMessage(messages[i]!, options);
    if (i < messages.length - 1) await sleep(300);
  }
}
