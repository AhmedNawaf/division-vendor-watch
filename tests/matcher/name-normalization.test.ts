import { describe, expect, it } from "vitest";
import { evaluateRule } from "../../src/matcher/match-items.js";
import type { VendorItem } from "../../src/types/vendor.js";

function gear(overrides: Partial<VendorItem>): VendorItem {
  return {
    vendor: "The Campus",
    name: "Some Piece",
    category: "gear",
    attributes: [],
    isNamed: false,
    rawText: "{}",
    ...overrides,
  };
}

/**
 * These four pairs are real: the left value is what the vendor feed publishes, the right is what
 * the item catalog (buildstation.app) calls the same brand. A user picks the catalog spelling
 * from a dropdown, so the matcher has to reconcile them or the rule silently never fires.
 */
const REAL_MISMATCHES: Array<[vendorSpelling: string, catalogSpelling: string, why: string]> = [
  ["Yaahl", "Yaahl Gear", "catalog keeps the corporate suffix"],
  ["Richter & Kaiser", "Richter & Kaiser GmbH", "catalog keeps GmbH"],
  ["Legatus S.p.A.", "Legatus S.P.A", "case and trailing punctuation differ"],
  ["Česká Výroba s.r.o.", "Ceska Vyroba s.r.o.", "catalog strips diacritics"],
];

describe("brand name reconciliation between the vendor feed and the item catalog", () => {
  for (const [vendorSpelling, catalogSpelling, why] of REAL_MISMATCHES) {
    it(`matches "${vendorSpelling}" against "${catalogSpelling}" (${why})`, () => {
      const item = gear({ brand: vendorSpelling });
      expect(evaluateRule(item, { brand: catalogSpelling })).not.toBeNull();
      // ...and symmetrically, in case the sources ever swap which one is fuller.
      expect(evaluateRule(gear({ brand: catalogSpelling }), { brand: vendorSpelling })).not.toBeNull();
    });
  }

  it("does not match unrelated brands that merely share a word", () => {
    expect(evaluateRule(gear({ brand: "Golan Gear Ltd" }), { brand: "Yaahl Gear" })).toBeNull();
    expect(evaluateRule(gear({ brand: "Providence Defense" }), { brand: "Petrov Defense Group" })).toBeNull();
  });

  it("only extends at a word boundary, never mid-word", () => {
    // "Gila" must not match "Gilagaurd"-style run-together names.
    expect(evaluateRule(gear({ brand: "Gila" }), { brand: "Gilamesh Armory" })).toBeNull();
  });

  it("applies the same tolerance to gear sets", () => {
    expect(evaluateRule(gear({ gearSet: "Hunter's Fury" }), { gearSet: "Hunters Fury" })).not.toBeNull();
  });

  it("keeps item names strict, since suffixes distinguish real weapons", () => {
    // "Police M4" and "Police M4 Enhanced" are different guns — a prefix match here would be a bug.
    const item = gear({ name: "Police M4", category: "weapon" });
    expect(evaluateRule(item, { itemName: "Police M4 Enhanced" })).toBeNull();
    expect(evaluateRule(item, { itemName: "police m4" })).not.toBeNull();
  });
});
