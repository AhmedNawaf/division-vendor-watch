import type { WatchRule, Watchlist } from "../config/load-watchlist.js";
import type { VendorAttribute, VendorItem } from "../types/vendor.js";

export interface RuleMatch {
  rule: WatchRule;
  reasons: string[];
}

export interface ItemMatch {
  item: VendorItem;
  ruleMatches: RuleMatch[];
  /** De-duplicated, ordered reasons across all matching rules. */
  reasons: string[];
}

/** Lowercase, strip punctuation, collapse whitespace — for tolerant equality checks. */
function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’'.]/g, "")
    .replace(/[,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attributePool(item: VendorItem): VendorAttribute[] {
  return item.coreAttribute ? [item.coreAttribute, ...item.attributes] : item.attributes;
}

function findAttribute(item: VendorItem, wanted: string): VendorAttribute | undefined {
  const target = normalizeKey(wanted);
  return attributePool(item).find((attr) => {
    const name = normalizeKey(attr.name);
    return name === target || name.includes(target) || normalizeKey(attr.rawValue).includes(target);
  });
}

/** Evaluate one rule against one item. Returns reasons if it matches, otherwise null. */
export function evaluateRule(item: VendorItem, rule: WatchRule): string[] | null {
  const reasons: string[] = [];
  const label = rule.label;

  if (rule.itemName !== undefined) {
    if (normalizeKey(item.name) !== normalizeKey(rule.itemName)) return null;
    reasons.push(`${item.name} is explicitly watchlisted`);
  }

  if (rule.brand !== undefined) {
    if (!item.brand || normalizeKey(item.brand) !== normalizeKey(rule.brand)) return null;
    reasons.push(`Brand is ${item.brand}`);
  }

  if (rule.gearSet !== undefined) {
    if (!item.gearSet || normalizeKey(item.gearSet) !== normalizeKey(rule.gearSet)) return null;
    reasons.push(`Gear set is ${item.gearSet}`);
  }

  if (rule.category !== undefined) {
    if (item.category !== rule.category) return null;
    reasons.push(`Category is ${item.category}`);
  }

  if (rule.talent !== undefined) {
    if (!item.talent) return null;
    const itemTalent = normalizeKey(item.talent);
    const wanted = normalizeKey(rule.talent);
    if (itemTalent !== wanted && !itemTalent.includes(wanted)) return null;
    reasons.push(`Talent is ${item.talent}`);
  }

  if (rule.namedOnly === true) {
    if (!item.isNamed) return null;
    reasons.push(`Item is a named item`);
  }

  if (rule.requiredAttributes !== undefined) {
    for (const required of rule.requiredAttributes) {
      const attr = findAttribute(item, required);
      if (!attr) return null;
      if (rule.minimumRollPercentage !== undefined) {
        if (attr.unit !== "%" || attr.value === undefined || attr.value < rule.minimumRollPercentage) {
          return null;
        }
        reasons.push(
          `${attr.name} roll ${attr.value}% meets the ${rule.minimumRollPercentage}% threshold`,
        );
      } else {
        reasons.push(`Has ${attr.name} (${attr.rawValue})`);
      }
    }
  } else if (rule.minimumRollPercentage !== undefined) {
    const threshold = rule.minimumRollPercentage;
    const strong = attributePool(item).find(
      (attr) => attr.unit === "%" && attr.value !== undefined && attr.value >= threshold,
    );
    if (!strong) return null;
    reasons.push(`${strong.name} roll ${strong.value}% meets the ${threshold}% threshold`);
  }

  if (reasons.length === 0) return null;
  if (label) reasons.unshift(label);
  return reasons;
}

/** Match all items against the watchlist. Items matching >=1 rule are returned once. */
export function matchItems(items: VendorItem[], watchlist: Watchlist): ItemMatch[] {
  const results: ItemMatch[] = [];

  for (const item of items) {
    const ruleMatches: RuleMatch[] = [];
    for (const rule of watchlist.rules) {
      const reasons = evaluateRule(item, rule);
      if (reasons) ruleMatches.push({ rule, reasons });
    }
    if (ruleMatches.length === 0) continue;

    const seen = new Set<string>();
    const reasons: string[] = [];
    for (const match of ruleMatches) {
      for (const reason of match.reasons) {
        if (!seen.has(reason)) {
          seen.add(reason);
          reasons.push(reason);
        }
      }
    }
    results.push({ item, ruleMatches, reasons });
  }

  return results;
}
