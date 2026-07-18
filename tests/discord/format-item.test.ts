import { describe, expect, it } from "vitest";
import { formatItemBlock } from "../../src/discord/format-alert.js";
import { vendorLine, vendorLocation } from "../../src/discord/vendor-locations.js";
import type { ItemMatch } from "../../src/matcher/match-items.js";
import type { VendorItem } from "../../src/types/vendor.js";

function match(overrides: Partial<VendorItem> = {}): ItemMatch {
  const item: VendorItem = {
    vendor: "White House",
    name: "Sleight",
    category: "gear",
    attributes: [],
    isNamed: false,
    rawText: "{}",
    ...overrides,
  };
  return { item, ruleMatches: [], reasons: ["Category is gear"] };
}

const attr = (rawValue: string) => ({ name: rawValue, rawValue });

describe("item block layout", () => {
  it("renders as three lines: identity, location, stats", () => {
    const block = formatItemBlock(
      match({
        slot: "Chest",
        brand: "Urban Lookout",
        coreAttribute: attr("10.6% Weapon Damage"),
        attributes: [attr("8.4% Status Effects"), attr("7.5% Explosive Resistance")],
        talent: "Perfect Protected Reload",
        isNamed: true,
      }),
    );

    const lines = block.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("⭐ **Sleight** · Chest · Urban Lookout");
    expect(lines[1]).toBe("📍 White House — Base of Operations, DC");
    expect(lines[2]).toBe(
      "10.6% Weapon Damage · 8.4% Status Effects · 7.5% Explosive Resistance · Perfect Protected Reload",
    );
  });

  it("never shows why the item matched", () => {
    // The reasons still drive matching; they are just noise once you are reading the alert.
    const block = formatItemBlock(match({ attributes: [attr("5% Crit")] }));
    expect(block).not.toContain("Reason");
    expect(block).not.toContain("Category is gear");
  });

  it("shows the armour slot, which the feed provides and the alert previously dropped", () => {
    expect(formatItemBlock(match({ slot: "Kneepads" }))).toContain("· Kneepads");
  });

  it("prefers the gear set over the brand, since a set is the stronger identifier", () => {
    const block = formatItemBlock(match({ slot: "Holster", gearSet: "Aegis", brand: "Yaahl Gear" }));
    expect(block).toContain("· Aegis");
    expect(block).not.toContain("Yaahl Gear");
  });

  it("omits absent parts rather than leaving empty labels", () => {
    // A weapon has no slot, no brand and no set.
    const block = formatItemBlock(
      match({ name: "Lefty - ACS-12", category: "weapon", vendor: "Clan" }),
    );
    expect(block.split("\n")).toHaveLength(2); // identity + location only
    expect(block).toBe("▫️ **Lefty - ACS-12**\n📍 Clan — White House East Wing, DC");
  });

  it("groups core, attributes and talent onto one line in that order", () => {
    const stats = formatItemBlock(
      match({
        coreAttribute: attr("CORE"),
        attributes: [attr("ONE"), attr("TWO")],
        talent: "TALENT",
      }),
    ).split("\n")[2];
    expect(stats).toBe("CORE · ONE · TWO · TALENT");
  });
});

describe("vendor locations", () => {
  it("adds a location hint next to the vendor name", () => {
    expect(vendorLine("DZ West")).toBe("📍 DZ West — Dark Zone West checkpoint");
  });

  it("matches vendor names case- and punctuation-insensitively", () => {
    expect(vendorLocation("white house")).toBe("Base of Operations, DC");
    expect(vendorLocation("The  Campus")).toBe("Downtown West settlement, DC");
  });

  it("shows the name alone for a vendor we cannot place", () => {
    // Sending someone to the wrong borough is worse than saying nothing, and the feed can add
    // a vendor at any time.
    expect(vendorLocation("Benitez")).toBeUndefined();
    expect(vendorLine("Benitez")).toBe("📍 Benitez");
    expect(vendorLine("Some New Vendor")).toBe("📍 Some New Vendor");
  });
});
