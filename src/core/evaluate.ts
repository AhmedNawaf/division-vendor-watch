import type { Watchlist } from "../config/load-watchlist.js";
import { formatAlerts } from "../discord/format-alert.js";
import { matchItems, type ItemMatch } from "../matcher/match-items.js";
import {
  DEFAULT_RESET_TIMEZONE,
  formatReset,
  type WeeklyReset,
} from "../source/reset-schedule.js";
import { computeFingerprint } from "../storage/alert-history.js";
import type { VendorItem } from "../types/vendor.js";

export interface NewAlert {
  match: ItemMatch;
  fingerprint: string;
}

export interface EvaluateOptions {
  /** Parsed vendor items for the current reset (fetched once, shared across tenants). */
  items: VendorItem[];
  /** The tenant's watchlist rules. */
  watchlist: Watchlist;
  /** The resolved weekly reset (its `date` keys fingerprints, `nextInstant` is displayed). */
  weeklyReset: WeeklyReset;
  /**
   * Dedup predicate — returns true if this fingerprint was already alerted for this tenant.
   * Inject a file-backed check for the CLI or a per-user DB check for the multi-user bot.
   */
  isAlreadyAlerted: (fingerprint: string) => boolean;
  resetTimeZone?: string;
  /** Warning surfaced in the alert header when the stock came from a degraded source. */
  sourceNotice?: string;
}

export interface EvaluateResult {
  /** Human-readable next-reset stamp, e.g. "Tuesday, 21 Jul 2026 · 11:30 AM KSA". */
  resetStamp: string;
  /** Every item that matched the watchlist this reset (regardless of alert history). */
  matches: ItemMatch[];
  /** Matches not yet alerted for this tenant, paired with their fingerprints to persist. */
  newAlerts: NewAlert[];
  /** Discord-ready messages for `newAlerts`, already split to the length limit. */
  messages: string[];
}

/**
 * Pure, tenant-agnostic evaluation: given already-fetched vendor items and one watchlist,
 * compute matches, filter out already-alerted ones via the injected predicate, and format
 * the messages to send. No I/O — callers own fetching, delivery, and persisting fingerprints.
 */
export function evaluateWatch(options: EvaluateOptions): EvaluateResult {
  const resetStamp = formatReset(
    options.weeklyReset.nextInstant,
    options.resetTimeZone ?? DEFAULT_RESET_TIMEZONE,
  );

  const matches = matchItems(options.items, options.watchlist);

  const newAlerts: NewAlert[] = [];
  for (const match of matches) {
    const fingerprint = computeFingerprint(match.item, options.weeklyReset.date);
    if (!options.isAlreadyAlerted(fingerprint)) newAlerts.push({ match, fingerprint });
  }

  const messages = formatAlerts(
    newAlerts.map((alert) => alert.match),
    {
      resetDate: resetStamp,
      sourceNotice: options.sourceNotice,
    },
  );

  return { resetStamp, matches, newAlerts, messages };
}
