import { loadWatchlist } from "./config/load-watchlist.js";
import { evaluateWatch } from "./core/evaluate.js";
import { formatAlerts } from "./discord/format-alert.js";
import { sendDiscordMessages } from "./discord/send-webhook.js";
import { ConfigError } from "./errors.js";
import { parseVendorData } from "./parser/parse-vendor-page.js";
import { fetchVendorData } from "./source/vendor-source.js";
import { computeWeeklyReset } from "./source/reset-schedule.js";
import { AlertHistory } from "./storage/alert-history.js";

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

  const watchlist = await loadWatchlist(config.watchlistPath);
  const history = await AlertHistory.load(config.alertHistoryPath);

  const evaluation = evaluateWatch({
    items: reset.items,
    watchlist,
    weeklyReset,
    isAlreadyAlerted: (fingerprint) => history.has(fingerprint),
    resetTimeZone: config.resetTimeZone,
    showReasons: config.showReasons,
  });
  const { matches, newAlerts, messages } = evaluation;

  log.info(`Next weekly reset: ${evaluation.resetStamp}`);
  log.info(`${matches.length} item(s) matched the watchlist`);
  log.info(`${newAlerts.length} new match(es) not yet alerted`);

  if (config.dryRun) {
    // Preview every current match regardless of history — dedup only matters for real sends.
    if (matches.length === 0) {
      log.info("DRY_RUN enabled — nothing in stock matched the watchlist.");
    } else {
      log.info(
        `DRY_RUN enabled — previewing all ${matches.length} current match(es) ` +
          `(${newAlerts.length} not yet alerted; nothing sent or written):`,
      );
      const previews = formatAlerts(matches, {
        resetDate: evaluation.resetStamp,
        showReasons: config.showReasons ?? true,
      });
      for (const message of previews) log.info(`\n${message}`);
    }
    return {
      totalItems: reset.items.length,
      totalMatches: matches.length,
      newMatches: newAlerts.length,
      messagesSent: 0,
      dryRun: true,
    };
  }

  if (newAlerts.length === 0) {
    return {
      totalItems: reset.items.length,
      totalMatches: matches.length,
      newMatches: 0,
      messagesSent: 0,
      dryRun: config.dryRun,
    };
  }

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
  for (const { fingerprint } of newAlerts) history.add(fingerprint, sentAt);
  await history.save();
  log.info(`Recorded ${newAlerts.length} fingerprint(s) to history`);

  return {
    totalItems: reset.items.length,
    totalMatches: matches.length,
    newMatches: newAlerts.length,
    messagesSent: messages.length,
    dryRun: false,
  };
}
