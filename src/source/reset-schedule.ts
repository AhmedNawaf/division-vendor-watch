/**
 * The Division 2 vendor stock rotates on a fixed weekly reset. The source page's JSON
 * cache-buster (e.g. `?20260717`) is just the site's last-updated date, NOT the in-game
 * reset — so we compute the real reset instant here instead of trusting that number.
 */

/** Reset weekday in UTC: Tuesday (Sun=0 … Sat=6). */
export const RESET_WEEKDAY_UTC = 2;

/**
 * Weekly reset time in UTC. The Division 2 weekly reset is Tuesday ~08:30 UTC.
 * If Ubisoft changes the schedule, adjust these two values.
 */
export const RESET_HOUR_UTC = 8;
export const RESET_MINUTE_UTC = 30;

export const DEFAULT_RESET_TIMEZONE = "Asia/Riyadh";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeeklyReset {
  /** Canonical reset day as YYYY-MM-DD in UTC. Stable within a week — used for fingerprints. */
  date: string;
  /** The exact reset moment that produced the current stock (most recent past reset). */
  instant: Date;
  /** The upcoming reset day as YYYY-MM-DD (this week's if still ahead, else next week's). */
  nextDate: string;
  /** The upcoming reset moment — once the reset time passes, this rolls to next week. For display. */
  nextInstant: Date;
}

/**
 * The most recent weekly reset (reset weekday at the reset time, UTC) at or before `reference`,
 * plus the next upcoming reset. Every run within the same vendor week resolves the past reset to
 * the same instant, keeping fingerprints stable; `nextInstant` rolls forward once the reset passes.
 */
export function computeWeeklyReset(reference: Date = new Date()): WeeklyReset {
  let candidate = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate(),
      RESET_HOUR_UTC,
      RESET_MINUTE_UTC,
      0,
      0,
    ),
  );

  // Walk back at most a week to the reset weekday that is at or before the reference time.
  for (let i = 0; i < 8; i += 1) {
    if (candidate.getUTCDay() === RESET_WEEKDAY_UTC && candidate.getTime() <= reference.getTime()) {
      break;
    }
    candidate = new Date(candidate.getTime() - DAY_MS);
  }

  const nextInstant = new Date(candidate.getTime() + 7 * DAY_MS);

  return {
    date: candidate.toISOString().slice(0, 10),
    instant: candidate,
    nextDate: nextInstant.toISOString().slice(0, 10),
    nextInstant,
  };
}

/** Friendly zone labels for the zones we actually use. Falls back to the GMT offset. */
const ZONE_LABELS: Record<string, string> = {
  "Asia/Riyadh": "KSA",
};

/**
 * Human-readable reset stamp in the given IANA time zone,
 * e.g. "Tuesday, 14 Jul 2026 · 11:30 AM KSA".
 */
export function formatReset(instant: Date, timeZone: string = DEFAULT_RESET_TIMEZONE): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).formatToParts(instant);

    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";

    const zoneLabel = ZONE_LABELS[timeZone] ?? get("timeZoneName");

    return (
      `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}` +
      ` · ${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()} ${zoneLabel}`
    );
  } catch {
    // Unknown time zone → fall back to a UTC ISO minute stamp rather than throwing.
    return `${instant.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}
