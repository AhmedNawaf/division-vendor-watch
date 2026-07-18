import { describe, expect, it } from "vitest";
import { parseAttribute, parseVendorData } from "../../src/parser/parse-vendor-page.js";
import { ParserError } from "../../src/errors.js";
import type { PayloadType, RawVendorData } from "../../src/source/vendor-source.js";
import { rawFromFixtures } from "../helpers.js";

function rawOf(records: {
  gear?: unknown[];
  weapons?: unknown[];
  mods?: unknown[];
}): RawVendorData {
  const types: PayloadType[] = ["gear", "weapons", "mods"];
  return {
    sourceUrl: "https://example.test/reset",
    resetDate: "2026-07-17",
    fetchedAt: new Date().toISOString(),
    payloads: types.map((type) => ({ type, url: `x/${type}`, records: records[type] ?? [] })),
  };
}

describe("parseAttribute", () => {
  it("parses a percentage attribute", () => {
    const attr = parseAttribute('<span class="icon-weapons"></span>5.7% Critical Hit Chance');
    expect(attr).toMatchObject({ name: "Critical Hit Chance", value: 5.7, unit: "%", role: "weapons" });
  });

  it("parses a flat attribute with a comma", () => {
    const attr = parseAttribute("16,335 Health");
    expect(attr).toMatchObject({ name: "Health", value: 16335, unit: "flat" });
  });

  it("parses a small flat attribute", () => {
    expect(parseAttribute("1 Skill Tier")).toMatchObject({ name: "Skill Tier", value: 1, unit: "flat" });
  });

  it("keeps text with no leading number as a nameless-value attribute", () => {
    const attr = parseAttribute("Perfect Protected Reload");
    expect(attr.name).toBe("Perfect Protected Reload");
    expect(attr.value).toBeUndefined();
    expect(attr.unit).toBe("unknown");
  });
});

describe("parseVendorData with real fixtures", () => {
  const reset = parseVendorData(rawFromFixtures());

  it("parses many vendors", () => {
    const vendors = new Set(reset.items.map((i) => i.vendor));
    expect(vendors.size).toBeGreaterThan(1);
  });

  it("assigns items to the correct vendor and extracts names", () => {
    const sleight = reset.items.find((i) => i.name === "Sleight");
    expect(sleight?.vendor).toBe("White House");
    expect(sleight?.category).toBe("gear");
  });

  it("extracts core and secondary attributes", () => {
    const sleight = reset.items.find((i) => i.name === "Sleight")!;
    expect(sleight.coreAttribute?.name).toBe("Weapon Damage");
    expect(sleight.attributes.map((a) => a.name)).toContain("Status Effects");
  });

  it("extracts talents", () => {
    const withTalent = reset.items.find((i) => i.category === "weapon" && i.talent);
    expect(typeof withTalent?.talent).toBe("string");
  });

  it("classifies gear-set pieces and puts the set name in gearSet", () => {
    const gs = reset.items.find((i) => i.gearSet);
    expect(gs?.gearSet).toBeTruthy();
    expect(gs?.brand).toBeUndefined();
  });

  it("classifies skill mods and gear mods", () => {
    const categories = new Set(reset.items.map((i) => i.category));
    expect(categories.has("skill-mod")).toBe(true);
    expect(categories.has("gear-mod")).toBe(true);
  });

  it("preserves rawText for every item", () => {
    expect(reset.items.every((i) => i.rawText.length > 0)).toBe(true);
  });
});

describe("parseVendorData validation", () => {
  it("handles missing optional values (talents '-')", () => {
    const raw = rawOf({
      gear: [
        {
          type: "gear",
          rarity: "header-he",
          vendor: "Clan",
          name: "Plain Piece",
          brand: "Airaldi Holdings",
          core: '<span class="icon-offensive"></span>10% Weapon Damage',
          attributes: "-",
          talents: "-",
        },
      ],
      weapons: [{ type: "weapon", rarity: "header-he", vendor: "Clan", name: "A Gun" }],
    });
    const reset = parseVendorData(raw, { minTotalItems: 1 });
    const piece = reset.items.find((i) => i.name === "Plain Piece")!;
    expect(piece.talent).toBeUndefined();
    expect(piece.attributes).toHaveLength(0);
  });

  it("rejects a broken record structure", () => {
    const raw = rawOf({ gear: ["not-an-object"], weapons: [{ vendor: "V", name: "N" }] });
    expect(() => parseVendorData(raw, { minTotalItems: 1 })).toThrow(ParserError);
  });

  it("rejects a record missing a required field", () => {
    const raw = rawOf({ gear: [{ type: "gear", name: "No Vendor" }] });
    expect(() => parseVendorData(raw, { minTotalItems: 1, requiredSections: [] })).toThrow(
      ParserError,
    );
  });

  it("rejects zero parsed items", () => {
    expect(() => parseVendorData(rawOf({}))).toThrow(/No items/);
  });

  it("rejects an unexpectedly low item count", () => {
    const raw = rawOf({
      gear: [{ type: "gear", vendor: "V", name: "One", rarity: "header-he" }],
      weapons: [{ type: "weapon", vendor: "V", name: "Two", rarity: "header-he" }],
    });
    expect(() => parseVendorData(raw, { minTotalItems: 50 })).toThrow(/low item count/);
  });

  it("rejects when a required section is empty", () => {
    const raw = rawOf({
      gear: [{ type: "gear", vendor: "V", name: "One", rarity: "header-he" }],
    });
    expect(() => parseVendorData(raw, { minTotalItems: 1, requiredSections: ["weapons"] })).toThrow(
      /Required section/,
    );
  });

  it("rejects a full-size payload whose records all lost an expected field", () => {
    // A realistic-sized payload that no longer carries `talent` on any weapon: without this
    // check the run would silently degrade into items with no talents and quietly stop matching.
    const weapons = Array.from({ length: 12 }, (_, i) => ({
      type: "weapon",
      vendor: "V",
      name: `W${i}`,
      rarity: "header-he",
      attribute1: "<span class=\"icon-weapons\"></span>10% SMG Damage",
      attribute2: "-",
      attribute3: "-",
    }));
    expect(() => parseVendorData(rawOf({ weapons }), { requiredSections: ["weapons"] })).toThrow(
      /Source shape changed: no weapons record contains talent/,
    );
  });

  it("tolerates a sparse field in a payload too small to draw conclusions from", () => {
    const weapons = Array.from({ length: 3 }, (_, i) => ({
      type: "weapon",
      vendor: "V",
      name: `W${i}`,
      rarity: "header-he",
    }));
    expect(() =>
      parseVendorData(rawOf({ weapons }), { minTotalItems: 1, requiredSections: ["weapons"] }),
    ).not.toThrow();
  });
});
