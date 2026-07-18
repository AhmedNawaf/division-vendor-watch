import type { WatchRule } from "../../src/config/watchlist-schema.js";

/**
 * Click-only starter rules. Selecting one from the `/wishlist add` menu stores the matching
 * WatchRule — no typing required. Richer builders (brand, attributes, roll %) can be layered on
 * later as additional menus; these presets cover the common "watch a whole category" cases.
 */
export interface RulePreset {
  key: string;
  label: string;
  description: string;
  rule: WatchRule;
}

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    key: "named-weapons",
    label: "Named weapons",
    description: "Any named (exotic-name tier) weapon in stock",
    rule: { category: "weapon", namedOnly: true, label: "Named weapons" },
  },
  {
    key: "all-weapons",
    label: "All weapons",
    description: "Every weapon the vendor carries",
    rule: { category: "weapon", label: "All weapons" },
  },
  {
    key: "gear",
    label: "Gear",
    description: "Any body/armor gear piece",
    rule: { category: "gear", label: "Gear" },
  },
  {
    key: "gear-mods",
    label: "Gear mods",
    description: "Any gear mod",
    rule: { category: "gear-mod", label: "Gear mods" },
  },
  {
    key: "skill-mods",
    label: "Skill mods",
    description: "Any skill mod",
    rule: { category: "skill-mod", label: "Skill mods" },
  },
];

export function presetByKey(key: string): RulePreset | undefined {
  return RULE_PRESETS.find((preset) => preset.key === key);
}
