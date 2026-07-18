import { isAppError } from "./errors.js";
import { runVendorWatch, type Logger, type RuntimeConfig } from "./run.js";

const DEFAULT_VENDOR_URL = "https://rubenalamina.mx/the-division-weekly-vendor-reset/";

const logger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

function parseBoolean(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/** Parse a boolean env var that defaults to true when unset or empty. */
function readConfig(): RuntimeConfig {
  const timeoutRaw = process.env.REQUEST_TIMEOUT_MS;
  const timeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 15_000;

  return {
    vendorUrl: process.env.VENDOR_URL || DEFAULT_VENDOR_URL,
    watchlistPath: process.env.WATCHLIST_PATH || "config/watchlist.json",
    alertHistoryPath: process.env.ALERT_HISTORY_PATH || "data/alert-history.json",
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
    dryRun: parseBoolean(process.env.DRY_RUN),
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    resetTimeZone: process.env.RESET_TIMEZONE || "Asia/Riyadh",
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  const result = await runVendorWatch(config, { logger });

  logger.info(
    `Done. items=${result.totalItems} matches=${result.totalMatches} ` +
      `new=${result.newMatches} sent=${result.messagesSent} dryRun=${result.dryRun}`,
  );
}

main().catch((err: unknown) => {
  if (isAppError(err)) {
    logger.error(`[${err.code}] ${err.message}`);
    if (err.context) {
      // Context is curated to be secret-free and helps debug parser/source failures.
      logger.error(`context: ${JSON.stringify(err.context)}`);
    }
  } else if (err instanceof Error) {
    logger.error(`Unexpected error: ${err.message}`);
  } else {
    logger.error(`Unexpected error: ${String(err)}`);
  }
  process.exitCode = 1;
});
