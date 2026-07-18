import { describe, expect, it } from "vitest";
import type { Watchlist } from "../../src/config/load-watchlist.js";
import { evaluateWatch } from "../../src/core/evaluate.js";
import { computeWeeklyReset } from "../../src/source/reset-schedule.js";
import type { VendorItem } from "../../src/types/vendor.js";

function item(overrides: Partial<VendorItem> = {}): VendorItem {
  return {
    vendor: "The Castle",
    name: "The White Death",
    category: "weapon",
    attributes: [],
    isNamed: true,
    rawText: "{}",
    ...overrides,
  };
}

const weeklyReset = computeWeeklyReset(new Date("2026-07-17T12:00:00Z"));
const watchlist: Watchlist = { rules: [{ category: "weapon", namedOnly: true }] };

describe("evaluateWatch", () => {
  it("returns matches and formats messages for not-yet-alerted items", () => {
    const result = evaluateWatch({
      items: [item(), item({ name: "Regular Rifle", isNamed: false })],
      watchlist,
      weeklyReset,
      isAlreadyAlerted: () => false,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.newAlerts).toHaveLength(1);
    expect(result.newAlerts[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.messages.join("\n")).toContain("The White Death");
    expect(result.resetStamp).toContain("21 Jul 2026");
  });

  it("suppresses already-alerted items via the injected predicate", () => {
    const result = evaluateWatch({
      items: [item()],
      watchlist,
      weeklyReset,
      isAlreadyAlerted: () => true,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.newAlerts).toHaveLength(0);
    expect(result.messages).toEqual([]);
  });

  it("keys fingerprints on the reset week, not the display stamp", () => {
    const a = evaluateWatch({ items: [item()], watchlist, weeklyReset, isAlreadyAlerted: () => false });
    // A later reference within the same vendor week yields the same fingerprint.
    const sameWeek = computeWeeklyReset(new Date("2026-07-19T23:00:00Z"));
    const b = evaluateWatch({
      items: [item()],
      watchlist,
      weeklyReset: sameWeek,
      isAlreadyAlerted: () => false,
    });
    expect(a.newAlerts[0]!.fingerprint).toBe(b.newAlerts[0]!.fingerprint);
  });
});
