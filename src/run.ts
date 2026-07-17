import { loadWatchlist } from "./config/load-watchlist.js";
import { formatAlerts } from "./discord/format-alert.js";
import { sendDiscordMessages } from "./discord/send-webhook.js";
import { ConfigError } from "./errors.js";
import { matchItems, type ItemMatch } from "./matcher/match-items.js";
import { parseVendorData } from "./parser/parse-vendor-page.js";
import { fetchVendorData } from "./source/vendor-source.js";
import { computeWeeklyReset, formatReset, DEFAULT_RESET_TIMEZONE } from "./source/reset-schedule.js";
import { AlertHistory, computeFingerprint } from "./storage/alert-history.js";

export interface RuntimeConfig {
  vendorUrl: string;
  watchlistPath: string;
  alertHistoryPath: string;
  requestTimeoutMs: number;
  dryRun: boolean;
  webhookUrl?: string;
  /** Include the per-item "Reason:" section in alerts. Defaults to true. */
  showReasons?: boolean;
  /** IANA time zone used to display the reset stamp. Defaults to Asia/Riyadh. */
  resetTimeZone?: string;
}

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface RunDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Injectable clock for deterministic reset computation in tests. */
  now?: () => Date;
}

export interface RunResult {
  totalItems: number;
  totalMatches: number;
  newMatches: number;
  messagesSent: number;
  dryRun: boolean;
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export async function runVendorWatch(
  config: RuntimeConfig,
  deps: RunDeps = {},
): Promise<RunResult> {
  const log = deps.logger ?? noopLogger;

  log.info(`Fetching vendor data from ${config.vendorUrl}`);
  const raw = await fetchVendorData({
    vendorUrl: config.vendorUrl,
    timeoutMs: config.requestTimeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  const reset = parseVendorData(raw);
  log.info(
    `Parsed ${reset.items.length} items` +
      (reset.updatedAt ? ` (source last updated ${reset.updatedAt})` : ""),
  );

  const weeklyReset = computeWeeklyReset((deps.now ?? (() => new Date()))());
  const resetStamp = formatReset(
    weeklyReset.nextInstant,
    config.resetTimeZone ?? DEFAULT_RESET_TIMEZONE,
  );
  log.info(`Next weekly reset: ${resetStamp}`);

  const watchlist = await loadWatchlist(config.watchlistPath);
  const matches = matchItems(reset.items, watchlist);
  log.info(`${matches.length} item(s) matched the watchlist`);

  const history = await AlertHistory.load(config.alertHistoryPath);
  const newMatches: { match: ItemMatch; fingerprint: string }[] = [];
  for (const match of matches) {
    const fingerprint = computeFingerprint(match.item, weeklyReset.date);
    if (!history.has(fingerprint)) newMatches.push({ match, fingerprint });
  }
  log.info(`${newMatches.length} new match(es) not yet alerted`);

  const formatOpts = { resetDate: resetStamp, showReasons: config.showReasons ?? true };

  if (config.dryRun) {
    // Preview every current match regardless of history — dedup only matters for real sends.
    if (matches.length === 0) {
      log.info("DRY_RUN enabled — nothing in stock matched the watchlist.");
    } else {
      log.info(
        `DRY_RUN enabled — previewing all ${matches.length} current match(es) ` +
          `(${newMatches.length} not yet alerted; nothing sent or written):`,
      );
      for (const message of formatAlerts(matches, formatOpts)) log.info(`\n${message}`);
    }
    return {
      totalItems: reset.items.length,
      totalMatches: matches.length,
      newMatches: newMatches.length,
      messagesSent: 0,
      dryRun: true,
    };
  }

  if (newMatches.length === 0) {
    return {
      totalItems: reset.items.length,
      totalMatches: matches.length,
      newMatches: 0,
      messagesSent: 0,
      dryRun: config.dryRun,
    };
  }

  const messages = formatAlerts(newMatches.map((m) => m.match), formatOpts);

  if (!config.webhookUrl) {
    throw new ConfigError(
      "DISCORD_WEBHOOK_URL is not set. Set it, or run with DRY_RUN=true to preview alerts.",
    );
  }

  await sendDiscordMessages(messages, {
    webhookUrl: config.webhookUrl,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    timeoutMs: config.requestTimeoutMs,
  });
  log.info(`Delivered ${messages.length} message(s) to Discord`);

  // Only persist fingerprints after a fully successful delivery.
  const sentAt = new Date().toISOString();
  for (const { fingerprint } of newMatches) history.add(fingerprint, sentAt);
  await history.save();
  log.info(`Recorded ${newMatches.length} fingerprint(s) to history`);

  return {
    totalItems: reset.items.length,
    totalMatches: matches.length,
    newMatches: newMatches.length,
    messagesSent: messages.length,
    dryRun: false,
  };
}
