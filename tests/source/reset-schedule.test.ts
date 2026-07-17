import { describe, expect, it } from "vitest";
import {
  RESET_WEEKDAY_UTC,
  computeWeeklyReset,
  formatReset,
} from "../../src/source/reset-schedule.js";

describe("computeWeeklyReset", () => {
  it("resolves to the most recent Tuesday reset for a mid-week reference", () => {
    // Friday 2026-07-17 12:00 UTC → the applicable reset is Tuesday 2026-07-14.
    const reset = computeWeeklyReset(new Date("2026-07-17T12:00:00Z"));
    expect(reset.date).toBe("2026-07-14");
    expect(reset.instant.getUTCDay()).toBe(RESET_WEEKDAY_UTC);
  });

  it("returns the current Tuesday once the reset time has passed", () => {
    const reset = computeWeeklyReset(new Date("2026-07-14T09:00:00Z"));
    expect(reset.date).toBe("2026-07-14");
  });

  it("returns the previous Tuesday before the reset time on reset day", () => {
    // 07:00 UTC is before the 08:30 UTC reset, so the live stock is still last week's.
    const reset = computeWeeklyReset(new Date("2026-07-14T07:00:00Z"));
    expect(reset.date).toBe("2026-07-07");
  });

  it("is stable across a week (same date for every day until the next reset)", () => {
    const wed = computeWeeklyReset(new Date("2026-07-15T00:00:00Z")).date;
    const sun = computeWeeklyReset(new Date("2026-07-19T23:00:00Z")).date;
    expect(wed).toBe("2026-07-14");
    expect(sun).toBe("2026-07-14");
  });

  it("exposes the upcoming reset once the reset time has passed", () => {
    // After Tuesday's reset, the next reset is the following Tuesday.
    const reset = computeWeeklyReset(new Date("2026-07-14T09:00:00Z"));
    expect(reset.date).toBe("2026-07-14");
    expect(reset.nextDate).toBe("2026-07-21");
  });

  it("points nextDate at this week's reset when it is still ahead", () => {
    // 07:00 UTC is before the 08:30 reset, so the next reset is today.
    const reset = computeWeeklyReset(new Date("2026-07-14T07:00:00Z"));
    expect(reset.date).toBe("2026-07-07");
    expect(reset.nextDate).toBe("2026-07-14");
  });
});

describe("formatReset", () => {
  it("renders the reset in the Riyadh time zone (UTC+3)", () => {
    // 08:30 UTC → 11:30 in Asia/Riyadh.
    const out = formatReset(new Date("2026-07-14T08:30:00Z"), "Asia/Riyadh");
    expect(out).toContain("11:30");
    expect(out).toContain("2026");
  });

  it("falls back to a UTC stamp for an invalid time zone", () => {
    const out = formatReset(new Date("2026-07-14T08:30:00Z"), "Not/AZone");
    expect(out).toContain("UTC");
  });
});
