import type { WatchRule } from "../../src/config/watchlist-schema.js";
import {
  BRANDS,
  GEAR_SETS,
  WEAPONS,
  balancedPages,
  brandPages,
  gearSetPages,
  resolveBrand,
  resolveGearSet,
  resolveWeapon,
  SELECT_LIMIT,
} from "../../src/catalog/index.js";
import {
  ComponentType,
  InteractionResponseType,
  type MessageComponent,
  type ModalResponse,
  type SelectOption,
} from "./discord.js";

/**
 * The wishlist editor: two modals, each a multi-section form the user fills in and submits once.
 *
 * Why modals rather than a message full of select menus: a modal fires no interaction until
 * Submit, so the whole edit arrives as one atomic payload with no server-side draft state to
 * accumulate, lose, or race against the 15-minute token expiry.
 *
 * Why two modals: Discord allows at most 5 top-level components, and gear alone needs all five
 * (categories + two pages of gear sets + two pages of brands).
 *
 * Each modal owns a scope of rules and *replaces* that scope on submit, so the form always shows
 * the truth: what you see selected is exactly what is stored. Rules outside the scope are left
 * alone, which is why editing gear can never wipe your weapon picks.
 */

export const GEAR_MODAL_ID = "wishlist:modal:gear";
export const WEAPONS_MODAL_ID = "wishlist:modal:weapons";

const FIELD_CATEGORIES = "categories";
const FIELD_GEAR_SET = "gearset";
const FIELD_BRAND = "brand";
const FIELD_QUICK = "quick";
const FIELD_EXOTIC = "exotic";

export type ModalScope = "gear" | "weapons";

const CATEGORY_CHOICES: Array<{ value: string; label: string; description: string }> = [
  { value: "weapon", label: "All weapons", description: "Every weapon the vendors carry" },
  { value: "gear", label: "All gear", description: "Every armor piece" },
  { value: "gear-mod", label: "All gear mods", description: "Every gear mod" },
  { value: "skill-mod", label: "All skill mods", description: "Every skill mod" },
];

const QUICK_CHOICES: Array<{ value: string; label: string; description: string }> = [
  {
    value: "named-weapons",
    label: "Any named weapon",
    description: "Alert on every named weapon in stock",
  },
  {
    value: "exotic-weapons",
    label: "Any exotic weapon",
    description: "Alert on every exotic weapon in stock",
  },
];

/** Exotic weapon names, the only weapon list small enough to pick from without typing. */
function exoticNames(): string[] {
  return [...new Set(WEAPONS.filter((w) => w.quality === "Exotic").map((w) => w.name))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
}

/**
 * Which modal owns a rule. Anything naming a specific item, or restricted to named weapons,
 * belongs to the weapons form; brand/gear-set/category rules belong to the gear form.
 */
export function ruleScope(rule: WatchRule): ModalScope {
  if (rule.itemName !== undefined || rule.namedOnly === true) return "weapons";
  return "gear";
}

function option(value: string, label: string, selected: Set<string>, description?: string): SelectOption {
  const opt: SelectOption = { label: label.slice(0, 100), value: value.slice(0, 100) };
  if (description) opt.description = description.slice(0, 100);
  if (selected.has(value)) opt.default = true;
  return opt;
}

/** A Label wrapping one multi-select — the modal equivalent of a form field. */
function selectField(
  customId: string,
  label: string,
  description: string,
  options: SelectOption[],
): MessageComponent {
  return {
    type: ComponentType.LABEL,
    label: label.slice(0, 45),
    description: description.slice(0, 100),
    component: {
      type: ComponentType.STRING_SELECT,
      custom_id: customId,
      placeholder: "Select any number…",
      min_values: 0,
      max_values: Math.min(options.length, SELECT_LIMIT),
      // Modal-only field; without it Discord blocks submission on an empty select.
      required: false,
      options,
    },
  };
}

/** Current selections, so the form opens pre-filled and doubles as the edit flow. */
interface Selections {
  categories: Set<string>;
  gearSets: Set<string>;
  brands: Set<string>;
  quick: Set<string>;
  exotics: Set<string>;
}

export function selectionsFromRules(rules: readonly WatchRule[]): Selections {
  const s: Selections = {
    categories: new Set(),
    gearSets: new Set(),
    brands: new Set(),
    quick: new Set(),
    exotics: new Set(),
  };
  for (const rule of rules) {
    if (rule.itemName) s.exotics.add(rule.itemName);
    else if (rule.namedOnly === true) s.quick.add("named-weapons");
    else if (rule.gearSet) s.gearSets.add(rule.gearSet);
    else if (rule.brand) s.brands.add(rule.brand);
    else if (rule.category) s.categories.add(rule.category);
  }
  return s;
}

export function buildGearModal(rules: readonly WatchRule[]): ModalResponse {
  const s = selectionsFromRules(rules);
  const setPages = gearSetPages();
  const brands = brandPages();

  const fields: MessageComponent[] = [
    selectField(
      FIELD_CATEGORIES,
      "Whole categories",
      "Broad — alerts on everything in the category",
      CATEGORY_CHOICES.map((c) => option(c.value, c.label, s.categories, c.description)),
    ),
  ];

  setPages.forEach((page, i) => {
    fields.push(
      selectField(
        `${FIELD_GEAR_SET}:${i}`,
        `Gear sets (${page.label})`,
        "Alert when pieces from these sets appear",
        page.values.map((v) => option(v, v, s.gearSets)),
      ),
    );
  });

  brands.forEach((page, i) => {
    fields.push(
      selectField(
        `${FIELD_BRAND}:${i}`,
        `Brands (${page.label})`,
        "Alert when pieces from these brands appear",
        page.values.map((v) => option(v, v, s.brands)),
      ),
    );
  });

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: GEAR_MODAL_ID,
      title: "Wishlist — gear, sets & brands",
      // Discord allows at most 5; the pages above are sized so this never truncates in practice,
      // but slice defensively so a future season adding brands degrades instead of erroring.
      components: fields.slice(0, 5),
    },
  };
}

export function buildWeaponsModal(rules: readonly WatchRule[]): ModalResponse {
  const s = selectionsFromRules(rules);
  const exotics = balancedPages(exoticNames());

  const fields: MessageComponent[] = [
    selectField(
      FIELD_QUICK,
      "Quick picks",
      "Broad weapon watches",
      QUICK_CHOICES.map((c) => option(c.value, c.label, s.quick, c.description)),
    ),
  ];

  exotics.forEach((page, i) => {
    fields.push(
      selectField(
        `${FIELD_EXOTIC}:${i}`,
        `Exotic weapons (${page.label})`,
        "Alert when these specific exotics appear",
        page.values.map((v) => option(v, v, s.exotics)),
      ),
    );
  });

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: WEAPONS_MODAL_ID,
      title: "Wishlist — weapons",
      components: fields.slice(0, 5),
    },
  };
}

export interface ParsedSubmission {
  rules: WatchRule[];
  /** Values Discord sent that are not in our catalog; surfaced rather than silently dropped. */
  rejected: string[];
}

/**
 * Turn a submitted modal into the rules it represents.
 *
 * Every value is re-resolved against the catalog rather than trusted. Menu values originate from
 * us, but validating here keeps a stale client, a replayed payload, or a future autocomplete
 * surface from storing a name that can never match anything.
 */
export function parseSubmission(scope: ModalScope, values: Map<string, string[]>): ParsedSubmission {
  const rules: WatchRule[] = [];
  const rejected: string[] = [];

  const each = (prefix: string, fn: (value: string) => void): void => {
    for (const [key, list] of values) {
      if (key !== prefix && !key.startsWith(`${prefix}:`)) continue;
      for (const value of list) fn(value);
    }
  };

  if (scope === "gear") {
    each(FIELD_CATEGORIES, (value) => {
      const known = CATEGORY_CHOICES.find((c) => c.value === value);
      if (!known) return rejected.push(value);
      rules.push({ category: value as WatchRule["category"], label: known.label });
    });
    each(FIELD_GEAR_SET, (value) => {
      const canonical = resolveGearSet(value);
      if (!canonical) return rejected.push(value);
      rules.push({ gearSet: canonical, label: canonical });
    });
    each(FIELD_BRAND, (value) => {
      const canonical = resolveBrand(value);
      if (!canonical) return rejected.push(value);
      rules.push({ brand: canonical, label: canonical });
    });
  } else {
    each(FIELD_QUICK, (value) => {
      if (value === "named-weapons") {
        rules.push({ category: "weapon", namedOnly: true, label: "Any named weapon" });
      } else if (value === "exotic-weapons") {
        // Exotics are enumerable, so watch them by name rather than inventing a rarity filter
        // the matcher does not support.
        for (const name of exoticNames()) rules.push({ itemName: name, label: name });
      } else {
        rejected.push(value);
      }
    });
    each(FIELD_EXOTIC, (value) => {
      const weapon = resolveWeapon(value);
      if (!weapon) return rejected.push(value);
      rules.push({ itemName: weapon.name, label: weapon.name });
    });
  }

  return { rules: dedupeRules(rules), rejected };
}

/** A rule's identity, so "already watching this" is decidable without duplicating rows. */
export function ruleKey(rule: WatchRule): string {
  return JSON.stringify([
    rule.itemName ?? null,
    rule.brand ?? null,
    rule.gearSet ?? null,
    rule.category ?? null,
    rule.talent ?? null,
    rule.namedOnly ?? null,
    rule.minimumRollPercentage ?? null,
    rule.requiredAttributes ?? null,
  ]);
}

function dedupeRules(rules: WatchRule[]): WatchRule[] {
  const seen = new Set<string>();
  const out: WatchRule[] = [];
  for (const rule of rules) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

/** Counts used to describe what a submit changed, without re-reading the database. */
export function diffRules(
  existing: readonly WatchRule[],
  desired: readonly WatchRule[],
): { added: WatchRule[]; removed: WatchRule[]; unchanged: WatchRule[] } {
  const existingKeys = new Map(existing.map((r) => [ruleKey(r), r]));
  const desiredKeys = new Map(desired.map((r) => [ruleKey(r), r]));

  const added = desired.filter((r) => !existingKeys.has(ruleKey(r)));
  const removed = existing.filter((r) => !desiredKeys.has(ruleKey(r)));
  const unchanged = desired.filter((r) => existingKeys.has(ruleKey(r)));
  return { added, removed, unchanged };
}

export const CATALOG_SIZES = {
  brands: BRANDS.length,
  gearSets: GEAR_SETS.length,
  exotics: exoticNames().length,
};
