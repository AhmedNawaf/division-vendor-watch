import type { Client } from "@libsql/client";
import { evaluateWatch } from "../core/evaluate.js";
import { createNodeClient } from "../db/node-client.js";
import {
  clearDeliveryFailures,
  getDeliveryState,
  getSourceMeta,
  getVendorCache,
  getWatchlist,
  listSubscriberIds,
  loadAlertedSet,
  markUndeliverable,
  recordAlerts,
  recordDeliveryFailure,
  saveDmChannelId,
  saveVendorCache,
  setSourceMeta,
} from "../db/store.js";
import {
  DiscordUndeliverableError,
  sendDirectMessages,
  type SendDmResult,
} from "../discord/send-dm.js";
import { RateLimiter } from "../discord/rate-limiter.js";
import { parseVendorData } from "../parser/parse-vendor-page.js";
import { computeWeeklyReset, type WeeklyReset } from "../source/reset-schedule.js";
import { fetchVendorData, type PayloadType, type RawVendorData } from "../source/vendor-source.js";
import type { VendorItem } from "../types/vendor.js";
import type { Logger } from "../run.js";

/** source_meta key holding the per-payload Last-Modified stamps for conditional requests. */
export const LAST_MODIFIED_KEY = "source:lastModified";

export interface FanoutConfig {
  vendorUrl: string;
  requestTimeoutMs: number;
  /** Discord bot token used to open and post DM channels. */
  botToken: string;
  databaseUrl: string;
  databaseAuthToken?: string;
  /** Preview only: evaluate and log per user, but send nothing and write nothing. */
  dryRun: boolean;
  resetTimeZone?: string;
  showReasons?: boolean;
  /** Sustained Discord request rate. Default 5/s, far below Discord's 50/s ceiling. */
  requestsPerSecond?: number;
  /** Gap between users, spreading the batch out. Default 1000ms. */
  perUserDelayMs?: number;
}

export interface FanoutDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Injectable clock for deterministic reset computation in tests. */
  now?: () => Date;
  /** Injectable DB client (tests pass an in-memory one); otherwise a Node client is created. */
  client?: Client;
  /** Injectable delivery, so tests don't hit Discord. Defaults to the real DM sender. */
  sendDm?: (
    userId: string,
    messages: string[],
    cachedChannelId?: string,
  ) => Promise<SendDmResult | void>;
  /** Shared limiter; injected in tests so pacing doesn't slow the suite. */
  limiter?: RateLimiter;
}

export interface FanoutResult {
  totalItems: number;
  subscribers: number;
  /** Users who received at least one DM this run. */
  usersAlerted: number;
  messagesSent: number;
  /** Users whose delivery failed (their fingerprints were NOT recorded, so they retry next run). */
  usersFailed: number;
  /** Users skipped because they are permanently undeliverable. */
  usersSkipped: number;
  /** Create DM calls made. Should fall to 0 in steady state as channel ids get cached. */
  channelsOpened: number;
  dryRun: boolean;
  /** True when the stock came from the cache rather than a fresh fetch. */
  degraded: boolean;
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ResolvedStock {
  items: VendorItem[];
  /** Warning to surface in alert headers when the data is not a fresh primary fetch. */
  sourceNotice?: string;
  /** True when items came fresh off the network and are worth caching. */
  fresh: boolean;
  lastModified?: Partial<Record<PayloadType, string>>;
}

function collectLastModified(raw: RawVendorData): Partial<Record<PayloadType, string>> {
  const out: Partial<Record<PayloadType, string>> = {};
  for (const payload of raw.payloads) {
    if (payload.lastModified) out[payload.type] = payload.lastModified;
  }
  return out;
}

function parseStoredLastModified(stored: string | null): Partial<Record<PayloadType, string>> {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Partial<Record<PayloadType, string>>;
  } catch {
    return {};
  }
}

/**
 * Resolve this week's vendor stock, preferring a fresh primary fetch and degrading in the order
 * that keeps alerts truthful:
 *
 *  1. Primary source, conditionally (`If-Modified-Since`) so an unchanged week costs three 304s.
 *  2. On 304 — our cached copy for *this* reset week. We still evaluate it, because watchlists
 *     change independently of the stock: a user who added a rule yesterday must still be matched.
 *  3. On failure — the same cached copy, flagged as degraded.
 *
 * Cache reads are scoped to `weeklyReset.date` throughout. Serving a *previous* week's stock
 * would generate alerts for items nobody can buy any more, which is worse than alerting nothing.
 */
async function resolveStock(
  config: FanoutConfig,
  deps: FanoutDeps,
  client: Client,
  weeklyReset: WeeklyReset,
  log: Logger,
): Promise<ResolvedStock> {
  const sourceLogger = { info: (m: string) => log.info(m), warn: (m: string) => log.warn(m) };

  const baseOptions = {
    vendorUrl: config.vendorUrl,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl: deps.fetchImpl,
    logger: sourceLogger,
  };

  const stored = parseStoredLastModified(await getSourceMeta(client, LAST_MODIFIED_KEY));

  let raw: RawVendorData;
  try {
    raw = await fetchVendorData({ ...baseOptions, ifModifiedSince: stored });
  } catch (err) {
    const cached = await getVendorCache(client, weeklyReset.date);
    if (!cached) throw err;
    log.warn(
      `Vendor source unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        `falling back to this week's cached stock from ${cached.fetchedAt}.`,
    );
    return {
      items: cached.items,
      fresh: false,
      sourceNotice: "Vendor source unavailable — using this week's cached stock.",
    };
  }

  if (raw.notModified) {
    const cached = await getVendorCache(client, weeklyReset.date);
    if (cached) {
      log.info(`Source unchanged; evaluating ${cached.items.length} cached item(s).`);
      return { items: cached.items, fresh: false };
    }
    // 304 with nothing cached for this week (fresh database, or the cache was cleared):
    // our stamps are useless, so take the full copy.
    log.warn("Source returned 304 but no cached stock for this week; refetching in full.");
    raw = await fetchVendorData(baseOptions);
  }

  const reset = parseVendorData(raw);
  return { items: reset.items, fresh: true, lastModified: collectLastModified(raw) };
}

/**
 * The weekly multi-user fan-out (runs under Node / GitHub Actions, not the Worker): fetch the
 * vendor stock once, then evaluate it against every subscriber's watchlist and DM their new
 * matches. Fingerprints are recorded per user only after a successful delivery, so a failed DM
 * is retried on the next run rather than silently dropped.
 */
export async function runFanout(config: FanoutConfig, deps: FanoutDeps = {}): Promise<FanoutResult> {
  const log = deps.logger ?? noopLogger;
  const client = deps.client ?? createNodeClient(config.databaseUrl, config.databaseAuthToken);

  const weeklyReset = computeWeeklyReset((deps.now ?? (() => new Date()))());
  log.info(`Fetching vendor data from ${config.vendorUrl}`);
  const stock = await resolveStock(config, deps, client, weeklyReset, log);
  log.info(`${stock.items.length} item(s) in stock for reset week ${weeklyReset.date}`);

  if (!config.dryRun && stock.fresh) {
    // Shared, non-tenant state: cache the stock so a later failure has something to serve
    // and `/preview` can render without re-fetching.
    await saveVendorCache(client, weeklyReset.date, stock.items);
    if (stock.lastModified && Object.keys(stock.lastModified).length > 0) {
      await setSourceMeta(client, LAST_MODIFIED_KEY, JSON.stringify(stock.lastModified));
    }
  }

  const subscriberIds = await listSubscriberIds(client);
  log.info(`${subscriberIds.length} subscriber(s) to evaluate`);

  const limiter =
    deps.limiter ?? new RateLimiter({ requestsPerSecond: config.requestsPerSecond ?? 5 });
  const spacer = deps.sleep ?? realSleep;

  const deliver =
    deps.sendDm ??
    ((userId: string, messages: string[], cachedChannelId?: string) =>
      sendDirectMessages(
        userId,
        messages,
        {
          botToken: config.botToken,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
          timeoutMs: config.requestTimeoutMs,
          limiter,
        },
        cachedChannelId,
      ));

  let usersAlerted = 0;
  let messagesSent = 0;
  let usersFailed = 0;
  let usersSkipped = 0;
  let channelsOpened = 0;
  let delivered = 0;

  for (const userId of subscriberIds) {
    const watchlist = await getWatchlist(client, userId);
    if (!watchlist) continue;

    const delivery = await getDeliveryState(client, userId);
    if (delivery?.undeliverableReason) {
      // Permanently refused before: attempting again just earns another 403 every week, and
      // enough of those across a fleet is an IP-ban risk. Skip until they interact with us.
      usersSkipped += 1;
      continue;
    }

    const alerted = await loadAlertedSet(client, userId, weeklyReset.date);
    const evaluation = evaluateWatch({
      items: stock.items,
      watchlist,
      weeklyReset,
      isAlreadyAlerted: (fingerprint) => alerted.has(fingerprint),
      resetTimeZone: config.resetTimeZone,
      showReasons: config.showReasons,
      sourceNotice: stock.sourceNotice,
    });

    if (config.dryRun) {
      log.info(
        `[dry-run] user ${userId}: ${evaluation.matches.length} match(es), ` +
          `${evaluation.newAlerts.length} new`,
      );
      continue;
    }

    if (evaluation.newAlerts.length === 0) continue;

    // Spread the batch out. A weekly digest is not second-sensitive, and a steady trickle
    // looks nothing like the burst that gets bots quarantined.
    if (delivered > 0) await spacer(config.perUserDelayMs ?? 1000);

    try {
      const result = await deliver(userId, evaluation.messages, delivery?.dmChannelId);
      await recordAlerts(
        client,
        userId,
        weeklyReset.date,
        evaluation.newAlerts.map((alert) => alert.fingerprint),
      );
      if (result?.channelId && result.channelId !== delivery?.dmChannelId) {
        // Cache the channel so subsequent runs never touch the Create DM endpoint again.
        await saveDmChannelId(client, userId, result.channelId);
      }
      if (result?.openedChannel) channelsOpened += 1;
      if (delivery?.failureCount) await clearDeliveryFailures(client, userId);
      usersAlerted += 1;
      delivered += 1;
      messagesSent += evaluation.messages.length;
      log.info(`Delivered ${evaluation.messages.length} message(s) to user ${userId}`);
    } catch (err) {
      // Isolate failures: one user's blocked DMs must not stop the rest of the fan-out.
      usersFailed += 1;
      delivered += 1;
      if (err instanceof DiscordUndeliverableError) {
        // Permanent: record it so we stop trying every week.
        const reason = err.message;
        await markUndeliverable(client, userId, reason);
        log.warn(`User ${userId} marked undeliverable: ${reason}`);
      } else {
        await recordDeliveryFailure(client, userId);
        log.error(
          `Delivery failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    totalItems: stock.items.length,
    subscribers: subscriberIds.length,
    usersAlerted,
    messagesSent,
    usersFailed,
    usersSkipped,
    channelsOpened,
    dryRun: config.dryRun,
    degraded: stock.sourceNotice !== undefined,
  };
}
