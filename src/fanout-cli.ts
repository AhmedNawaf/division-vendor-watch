import { ConfigError, isAppError } from "./errors.js";
import { runFanout, type FanoutConfig } from "./fanout/run-fanout.js";
import type { Logger } from "./run.js";

const DEFAULT_VENDOR_URL = "https://rubenalamina.mx/the-division-weekly-vendor-reset/";

const logger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

function parseBoolean(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseBooleanDefaultTrue(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function readConfig(): FanoutConfig {
  const timeoutRaw = process.env.REQUEST_TIMEOUT_MS;
  const timeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 15_000;
  const dryRun = parseBoolean(process.env.DRY_RUN);

  const databaseUrl = process.env.TURSO_DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError("TURSO_DATABASE_URL is not set — the fan-out needs the subscriber database.");
  }
  const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
  if (!dryRun && !botToken) {
    throw new ConfigError(
      "DISCORD_BOT_TOKEN is not set. Set it, or run with DRY_RUN=true to preview without sending.",
    );
  }

  return {
    vendorUrl: process.env.VENDOR_URL || DEFAULT_VENDOR_URL,
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
    botToken,
    databaseUrl,
    databaseAuthToken: process.env.TURSO_AUTH_TOKEN || undefined,
    dryRun,
    showReasons: parseBooleanDefaultTrue(process.env.SHOW_REASONS),
    resetTimeZone: process.env.RESET_TIMEZONE || "Asia/Riyadh",
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  const result = await runFanout(config, { logger });
  logger.info(
    `Done. items=${result.totalItems} subscribers=${result.subscribers} ` +
      `alerted=${result.usersAlerted} sent=${result.messagesSent} failed=${result.usersFailed} ` +
      `skipped=${result.usersSkipped} channelsOpened=${result.channelsOpened} ` +
      `dryRun=${result.dryRun} degraded=${result.degraded}`,
  );
  // A partial failure (some users' DMs failed) should surface as a non-zero exit for CI visibility.
  if (result.usersFailed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (isAppError(err)) {
    logger.error(`[${err.code}] ${err.message}`);
    if (err.context) logger.error(`context: ${JSON.stringify(err.context)}`);
  } else if (err instanceof Error) {
    logger.error(`Unexpected error: ${err.message}`);
  } else {
    logger.error(`Unexpected error: ${String(err)}`);
  }
  process.exitCode = 1;
});
