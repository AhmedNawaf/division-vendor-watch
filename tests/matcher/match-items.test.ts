import { describe, expect, it } from "vitest";
import { evaluateRule, matchItems } from "../../src/matcher/match-items.js";
import { parseWatchlist } from "../../src/config/load-watchlist.js";
import type { VendorItem } from "../../src/types/vendor.js";

function item(overrides: Partial<VendorItem> = {}): VendorItem {
  return {
    vendor: "Clan",
    name: "Test Item",
    category: "gear",
    attributes: [],
    isNamed: false,
    rawText: "{}",
    ...overrides,
  };
}

const attr = (name: string, value?: number, unit: "%" | "flat" = "%") => ({
  name,
  value,
  unit,
  rawValue: value !== undefined ? `${value}${unit === "%" ? "%" : ""} ${name}` : name,
});

describe("evaluateRule", () => {
  it("matches an exact item name", () => {
    const reasons = evaluateRule(item({ name: "Fox's Prayer" }), { itemName: "Fox's Prayer" });
    expect(reasons).not.toBeNull();
    expect(reasons!.join(" ")).toContain("watchlisted");
  });

  it("matches item name case- and punctuation-insensitively", () => {
    expect(evaluateRule(item({ name: "Fox's Prayer" }), { itemName: "fox's prayer" })).not.toBeNull();
    expect(evaluateRule(item({ name: "Grupo Sombra S.A." }), { itemName: "grupo sombra sa" })).not.toBeNull();
  });

  it("matches on brand", () => {
    expect(evaluateRule(item({ brand: "Grupo Sombra S.A." }), { brand: "Grupo Sombra S.A." })).not.toBeNull();
  });

  it("does not match a brand rule against a gear-set piece", () => {
    expect(evaluateRule(item({ gearSet: "Tip of the Spear" }), { brand: "Tip of the Spear" })).toBeNull();
  });

  it("matches on gear set", () => {
    expect(evaluateRule(item({ gearSet: "Striker's Battlegear" }), { gearSet: "Striker's Battlegear" })).not.toBeNull();
  });

  it("matches a single required attribute", () => {
    const it = item({ attributes: [attr("Critical Hit Chance", 5.7)] });
    expect(evaluateRule(it, { requiredAttributes: ["Critical Hit Chance"] })).not.toBeNull();
  });

  it("matches multiple required attributes", () => {
    const it = item({ attributes: [attr("Critical Hit Chance", 5.7), attr("Critical Hit Damage", 12)] });
    expect(
      evaluateRule(it, { requiredAttributes: ["Critical Hit Chance", "Critical Hit Damage"] }),
    ).not.toBeNull();
  });

  it("fails when a required attribute is missing", () => {
    const it = item({ attributes: [attr("Critical Hit Chance", 5.7)] });
    expect(evaluateRule(it, { requiredAttributes: ["Critical Hit Damage"] })).toBeNull();
  });

  it("matches on talent (substring)", () => {
    expect(evaluateRule(item({ talent: "Perfect Protected Reload" }), { talent: "Protected Reload" })).not.toBeNull();
  });

  it("matches named-only", () => {
    expect(evaluateRule(item({ isNamed: true }), { namedOnly: true })).not.toBeNull();
    expect(evaluateRule(item({ isNamed: false }), { namedOnly: true })).toBeNull();
  });

  it("enforces the minimum roll threshold on required attributes", () => {
    const strong = item({ attributes: [attr("Critical Hit Chance", 5.7)] });
    const weak = item({ attributes: [attr("Critical Hit Chance", 4.0)] });
    const rule = { requiredAttributes: ["Critical Hit Chance"], minimumRollPercentage: 5.5 };
    expect(evaluateRule(strong, rule)).not.toBeNull();
    expect(evaluateRule(weak, rule)).toBeNull();
  });

  it("applies the minimum roll threshold to any % attribute when no required attributes", () => {
    const it = item({ attributes: [attr("Weapon Damage", 12)] });
    expect(evaluateRule(it, { minimumRollPercentage: 10 })).not.toBeNull();
    expect(evaluateRule(it, { minimumRollPercentage: 15 })).toBeNull();
  });

  it("returns null for a non-matching item", () => {
    expect(evaluateRule(item({ name: "Something Else" }), { itemName: "Fox's Prayer" })).toBeNull();
  });

  it("considers the core attribute when matching required attributes", () => {
    const it = item({ coreAttribute: attr("Weapon Damage", 15), attributes: [] });
    expect(evaluateRule(it, { requiredAttributes: ["Weapon Damage"] })).not.toBeNull();
  });
});

describe("matchItems", () => {
  it("returns an item once even when multiple rules match it", () => {
    const watchlist = parseWatchlist({
      rules: [{ itemName: "Fox's Prayer" }, { category: "gear" }],
    });
    const items = [item({ name: "Fox's Prayer", category: "gear" }), item({ name: "Ignore Me", category: "weapon" })];
    const matches = matchItems(items, watchlist);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.ruleMatches).toHaveLength(2);
  });
});
