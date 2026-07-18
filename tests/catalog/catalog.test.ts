import { describe, expect, it } from "vitest";
import {
  ATTRIBUTES,
  BRANDS,
  GEAR,
  GEAR_SETS,
  SELECT_LIMIT,
  TALENTS,
  WEAPONS,
  brandPages,
  bucketFits,
  gearSetPages,
  paginate,
  resolveAttribute,
  resolveBrand,
  resolveGearItem,
  resolveGearSet,
  resolveTalent,
  resolveWeapon,
  vendorSellableGear,
  vendorSellableWeapons,
  weaponTypes,
  weaponsOf,
} from "../../src/catalog/index.js";

describe("catalog snapshot", () => {
  it("holds a plausible catalog (guards against a truncated sync)", () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(30);
    expect(GEAR_SETS.length).toBeGreaterThanOrEqual(20);
    expect(WEAPONS.length).toBeGreaterThanOrEqual(250);
  });

  it("excludes the crafted-gear placeholder, which is not a real brand", () => {
    expect(BRANDS).not.toContain("Crafted");
    expect(BRANDS).not.toContain("Improvised Body Armor");
  });

  it("has no duplicate entries", () => {
    expect(new Set(BRANDS).size).toBe(BRANDS.length);
    expect(new Set(GEAR_SETS).size).toBe(GEAR_SETS.length);
    const keys = WEAPONS.map((w) => `${w.quality}|${w.type}|${w.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("pagination for Discord selects", () => {
  it("never exceeds the 25-option cap", () => {
    for (const page of [...brandPages(), ...gearSetPages()]) {
      expect(page.values.length).toBeLessThanOrEqual(SELECT_LIMIT);
    }
  });

  it("covers every value exactly once, in order", () => {
    const flattened = brandPages().flatMap((p) => p.values);
    expect(flattened).toEqual([...BRANDS]);
  });

  it("labels pages by their first-letter range so users can jump to a name", () => {
    const pages = paginate(["Alpha", "Beta", "Gamma", "Delta"], 2);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.label).toBe("A–B");
    expect(pages[1]!.label).toBe("G–D");
  });

  it("labels a single-letter page without a range", () => {
    expect(paginate(["Alpha", "Anvil"], 5)[0]!.label).toBe("A");
  });

  it("returns nothing for an empty list", () => {
    expect(paginate([])).toEqual([]);
  });
});

describe("weapon bucketing", () => {
  it("keeps every Exotic and Named bucket inside one select", () => {
    // This is the finding the whole click-only weapon picker rests on: if these overflowed we
    // would be forced into autocomplete, which cannot live inside the bulk-edit modal.
    const overflowing: string[] = [];
    for (const type of weaponTypes()) {
      for (const quality of ["Exotic", "Named"] as const) {
        if (!bucketFits(quality, type)) {
          overflowing.push(`${quality} ${type} (${weaponsOf(quality, type).length})`);
        }
      }
    }
    expect(overflowing).toEqual([]);
  });

  it("returns only weapons of the requested quality and type", () => {
    const type = weaponTypes()[0]!;
    for (const weapon of weaponsOf("Exotic", type)) {
      expect(weapon.quality).toBe("Exotic");
      expect(weapon.type).toBe(type);
    }
  });
});

describe("resolving user-supplied names", () => {
  it("accepts the vendor feed's shorter brand spellings", () => {
    // The vendor feed says "Yaahl"; the catalog says "Yaahl Gear". Both must resolve.
    expect(resolveBrand("Yaahl")).toBe("Yaahl Gear");
    expect(resolveBrand("Richter & Kaiser")).toBe("Richter & Kaiser GmbH");
    expect(resolveBrand("Česká Výroba s.r.o.")).toBe("Ceska Vyroba s.r.o.");
  });

  it("returns the canonical spelling regardless of case", () => {
    expect(resolveBrand("providence defense")).toBe("Providence Defense");
  });

  it("rejects names that are not in the catalog", () => {
    // Autocomplete lets users submit arbitrary text, so unknowns must not become stored rules.
    expect(resolveBrand("Definitely Not A Brand")).toBeUndefined();
    expect(resolveGearSet("Made Up Set")).toBeUndefined();
    expect(resolveWeapon("Nonexistent Gun")).toBeUndefined();
  });

  it("resolves a known gear set and weapon", () => {
    expect(resolveGearSet(GEAR_SETS[0]!)).toBe(GEAR_SETS[0]);
    expect(resolveWeapon(WEAPONS[0]!.name)?.name).toBe(WEAPONS[0]!.name);
  });
});

describe("named-item naming between the vendor feed and the catalog", () => {
  /**
   * Real pairs observed in live vendor stock. The feed writes "<Named> - <Base weapon>" using
   * either a hyphen or an en-dash; the catalog stores only the named part. All eleven named
   * weapons in stock the day this was written failed to resolve before this was handled.
   */
  const REAL_PAIRS: Array<[feedName: string, catalogName: string]> = [
    ["Pyromaniac - Police M4", "Pyromaniac"],
    ["Lefty - ACS-12", "Lefty"],
    ["The White Death - Classic M44 Carbine", "The White Death"],
    ["Cuélebre – Military M870", "Cuélebre"], // en-dash, not a hyphen
    ["Shield Splinterer - F2000", "Shield Splinterer"],
    ["Whisper", "Whisper"], // no suffix at all
  ];

  for (const [feedName, catalogName] of REAL_PAIRS) {
    it(`resolves "${feedName}" to "${catalogName}"`, () => {
      expect(resolveWeapon(feedName)?.name).toBe(catalogName);
    });
  }

  it("still refuses a weapon that only shares a prefix word", () => {
    // "Police M4" and "Police M4 Enhanced" are different guns; only the named-item separator
    // is treated as a formatting difference.
    expect(resolveWeapon("Police M4 Enhanced")?.name).not.toBe("Police M4");
  });
});

describe("gear, talents and attributes", () => {
  it("carries named and exotic gear, but not brand/set placeholder rows", () => {
    expect(GEAR.length).toBeGreaterThanOrEqual(80);
    // Upstream lists High End gear under its brand name; those must not leak in as items.
    for (const brand of BRANDS) expect(GEAR.some((g) => g.name === brand)).toBe(false);
    for (const set of GEAR_SETS) expect(GEAR.some((g) => g.name === set)).toBe(false);
  });

  it("excludes exotics from what vendors can actually stock", () => {
    // The vendor feed publishes only header-named / header-he / header-gs — no exotic rarity.
    expect(vendorSellableGear().every((g) => g.quality === "Named")).toBe(true);
    expect(vendorSellableWeapons().every((w) => w.quality !== "Exotic")).toBe(true);
    expect(vendorSellableGear().length).toBeGreaterThan(50);
  });

  it("carries both weapon and gear talents", () => {
    expect(TALENTS.some((t) => t.kind === "weapon")).toBe(true);
    expect(TALENTS.some((t) => t.kind === "gear")).toBe(true);
    expect(new Set(TALENTS.map((t) => `${t.kind}|${t.name}`)).size).toBe(TALENTS.length);
  });

  it("resolves talents and attributes, and rejects unknowns", () => {
    expect(resolveTalent(TALENTS[0]!.name)?.name).toBe(TALENTS[0]!.name);
    expect(resolveTalent("Not A Real Talent")).toBeUndefined();
    expect(resolveAttribute(ATTRIBUTES[0]!)).toBe(ATTRIBUTES[0]);
    expect(resolveAttribute("Not A Real Stat")).toBeUndefined();
  });

  it("resolves a named gear piece", () => {
    const named = vendorSellableGear()[0]!;
    expect(resolveGearItem(named.name)?.name).toBe(named.name);
  });
});
