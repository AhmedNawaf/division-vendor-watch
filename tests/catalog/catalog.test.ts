import { describe, expect, it } from "vitest";
import {
  BRANDS,
  GEAR_SETS,
  SELECT_LIMIT,
  WEAPONS,
  brandPages,
  bucketFits,
  gearSetPages,
  paginate,
  resolveBrand,
  resolveGearSet,
  resolveWeapon,
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
