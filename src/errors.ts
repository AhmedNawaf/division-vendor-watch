/**
 * Base class for all expected, actionable failures in this app. Anything that
 * extends AppError carries an exit-code-worthy `code` and never leaks secrets.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  /** Extra context safe to print to logs (never contains secrets). */
  readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.context = context;
  }
}

/** The vendor source could not be fetched or returned something unusable. */
export class VendorSourceError extends AppError {
  readonly code = "VENDOR_SOURCE_ERROR";
}

/** The fetched data could not be parsed, or failed structural validation. */
export class ParserError extends AppError {
  readonly code = "PARSER_ERROR";
}

/** The watchlist configuration is missing or invalid. */
export class ConfigError extends AppError {
  readonly code = "CONFIG_ERROR";
}

/** Delivering a message to Discord failed. */
export class DiscordDeliveryError extends AppError {
  readonly code = "DISCORD_DELIVERY_ERROR";
}

/** Reading or writing the alert history failed. */
export class StorageError extends AppError {
  readonly code = "STORAGE_ERROR";
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
