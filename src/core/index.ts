/**
 * The reusable domain core: everything below is pure/tenant-agnostic and safe to import
 * from any delivery surface (the current CLI app, the future Cloudflare Worker, the weekly
 * GitHub Actions fan-out). It deliberately excludes single-tenant glue — file-based watchlist
 * loading, webhook delivery, on-disk history, and CLI/env wiring stay in the app layer.
 */

// Domain types & errors
export * from "../types/vendor.js";
export * from "../errors.js";

// Source: fetch the vendor page + JSON endpoints
export {
  fetchVendorData,
  discoverPayloadUrls,
  type RawVendorData,
  type RawVendorPayload,
  type PayloadType,
  type VendorSourceOptions,
} from "../source/vendor-source.js";

// Parser: raw payloads -> normalized items
export { parseVendorData, parseAttribute, type ParseOptions } from "../parser/parse-vendor-page.js";

// Matcher: items x rules -> matches
export { matchItems, evaluateRule, type ItemMatch, type RuleMatch } from "../matcher/match-items.js";

// Rule schema (a watchlist is one tenant's ruleset)
export {
  parseWatchlist,
  watchRuleSchema,
  watchlistSchema,
  type WatchRule,
  type Watchlist,
} from "../config/load-watchlist.js";

// Reset schedule
export {
  computeWeeklyReset,
  formatReset,
  DEFAULT_RESET_TIMEZONE,
  RESET_WEEKDAY_UTC,
  RESET_HOUR_UTC,
  RESET_MINUTE_UTC,
  type WeeklyReset,
} from "../source/reset-schedule.js";

// Formatting: matches -> Discord messages
export {
  formatAlerts,
  formatItemBlock,
  DISCORD_MAX_MESSAGE_LENGTH,
  type FormatOptions,
} from "../discord/format-alert.js";

// Dedup fingerprint (storage-agnostic; the AlertHistory file class stays in the app layer)
export { computeFingerprint } from "../storage/alert-history.js";

// Tenant-agnostic orchestration
export {
  evaluateWatch,
  type EvaluateOptions,
  type EvaluateResult,
  type NewAlert,
} from "./evaluate.js";
