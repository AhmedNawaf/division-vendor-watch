import { describe, expect, it } from "vitest";
import {
  DISCORD_MAX_MESSAGE_LENGTH,
  SOURCE_CREDIT,
  formatAlerts,
  formatItemBlock,
} from "../../src/discord/format-alert.js";
import type { ItemMatch } from "../../src/matcher/match-items.js";
import type { VendorItem } from "../../src/types/vendor.js";

function match(overrides: Partial<VendorItem> = {}, reasons = ["Watchlisted"]): ItemMatch {
  const item: VendorItem = {
    vendor: "Countdown Vendor",
    name: "Fox's Prayer",
    category: "gear",
    attributes: [],
    isNamed: true,
    rawText: "{}",
    ...overrides,
  };
  return { item, ruleMatches: [], reasons };
}

describe("formatItemBlock", () => {
  it("renders a full block with core, attributes, and reason", () => {
    const block = formatItemBlock(
      match({
        coreAttribute: { name: "Weapon Damage", value: 15, unit: "%", rawValue: "15% Weapon Damage" },
        attributes: [
          { name: "Critical Hit Chance", value: 5.7, unit: "%", rawValue: "5.7% Critical Hit Chance" },
        ],
      }),
    );
    expect(block).toContain("⭐ Fox's Prayer");
    expect(block).toContain("Vendor: Countdown Vendor");
    expect(block).toContain("Core:");
    expect(block).toContain("15% Weapon Damage");
    expect(block).toContain("Attributes:");
    expect(block).toContain("5.7% Critical Hit Chance");
    expect(block).toContain("Reason:");
  });

  it("handles missing optional values", () => {
    const block = formatItemBlock(match({ isNamed: false, coreAttribute: undefined, attributes: [] }));
    expect(block).toContain("Fox's Prayer");
    expect(block).not.toContain("Core:");
    expect(block).not.toContain("Attributes:");
    expect(block).toContain("Reason:");
  });

  it("omits the reason section when showReasons is false", () => {
    const block = formatItemBlock(match(), false);
    expect(block).toContain("Fox's Prayer");
    expect(block).not.toContain("Reason:");
  });
});

describe("formatAlerts", () => {
  it("returns nothing when there are no matches", () => {
    expect(formatAlerts([])).toEqual([]);
  });

  it("formats a single match into one message with a header", () => {
    const messages = formatAlerts([match()], { resetDate: "2026-07-17" });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🛒 **Weekly Vendor Watch**");
    expect(messages[0]).toContain("📅 Next reset: 2026-07-17");
    expect(messages[0]).toContain("🎯 1 match");
    expect(messages[0]).toContain("Fox's Prayer");
  });

  it("drops reasons from every block when showReasons is false", () => {
    const messages = formatAlerts([match({ name: "A" }), match({ name: "B" })], {
      showReasons: false,
    });
    expect(messages.join("\n")).not.toContain("Reason:");
  });

  it("groups multiple matches into a single message when they fit", () => {
    const messages = formatAlerts([match({ name: "A" }), match({ name: "B" }), match({ name: "C" })]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("A");
    expect(messages[0]).toContain("B");
    expect(messages[0]).toContain("C");
  });

  it("splits into multiple messages when exceeding the length budget", () => {
    const many = Array.from({ length: 12 }, (_, i) => match({ name: `Item Number ${i}` }));
    const messages = formatAlerts(many, { maxMessageLength: 200 });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(200);
  });

  it("keeps every message within the Discord hard limit for large inputs", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      match({
        name: `Item ${i}`,
        attributes: [
          { name: "Critical Hit Chance", value: 5.7, unit: "%", rawValue: "5.7% Critical Hit Chance" },
          { name: "Critical Hit Damage", value: 12, unit: "%", rawValue: "12% Critical Hit Damage" },
        ],
      }),
    );
    const messages = formatAlerts(many);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_LENGTH);
    }
  });

  it("credits the upstream data source once, in the first message only", () => {
    const many = Array.from({ length: 60 }, (_, i) => match({ name: `Item ${i}` }));
    const messages = formatAlerts(many);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]).toContain(SOURCE_CREDIT);
    for (const message of messages.slice(1)) expect(message).not.toContain(SOURCE_CREDIT);
  });

  it("omits the credit when explicitly disabled", () => {
    const [message] = formatAlerts([match()], { sourceCredit: false });
    expect(message).not.toContain(SOURCE_CREDIT);
  });

  it("surfaces a degraded-source notice in the header", () => {
    const [message] = formatAlerts([match()], {
      sourceNotice: "Vendor source unavailable — using this week's cached stock.",
    });
    expect(message).toContain("⚠️ Vendor source unavailable");
  });
});
