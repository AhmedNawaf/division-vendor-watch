import type { WatchRule } from "../../src/config/watchlist-schema.js";
import {
  BRANDS,
  GEAR_SETS,
  WEAPONS,
  balancedPages,
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
import { describeStock, EMPTY_STOCK, type StockIndex } from "./stock.js";

/**
 * The wishlist editor: two forms, split by what you are watching rather than by what happens to
 * fit. Everything about gear — types, sets and brands — lives in the gear form; everything about
 * weapons lives in the weapons form. An earlier version put "All weapons" in the gear form
 * because the section budget allowed it, which was incoherent.
 *
 * Modals rather than a message full of selects: a modal fires no interaction until Submit, so an
 * edit arrives as one atomic payload with no draft state to accumulate or lose.
 *
 * Lists are split by what is in stock this week rather than alphabetically. A–M / N–V is a split
 * you have to decode; "in stock now" is one you can act on, and it puts the thing you are most
 * likely hunting in a short first list. Since Discord select menus have no search box, that
 * matters more than alphabetical predictability.
 */

export const GEAR_MODAL_ID = "wishlist:modal:gear";
export const WEAPONS_MODAL_ID = "wishlist:modal:weapons";

const FIELD_GEAR_TYPES = "geartype";
const FIELD_GEAR_SET = "gearset";
const FIELD_BRAND = "brand";
const FIELD_WEAPON_TYPES = "weapontype";
const FIELD_EXOTIC = "exotic";

export type ModalScope = "gear" | "weapons";

/** Gear-side categories only — weapons are the other form's business. */
const GEAR_TYPE_CHOICES = [
  { value: "gear", label: "All gear", description: "Every armor piece" },
  { value: "gear-mod", label: "All gear mods", description: "Every gear mod" },
  { value: "skill-mod", label: "All skill mods", description: "Every skill mod" },
] as const;

const WEAPON_TYPE_CHOICES = [
  { value: "weapon", label: "All weapons", description: "Every weapon the vendors carry" },
  { value: "named-weapons", label: "Any named weapon", description: "Only named-tier weapons" },
  { value: "exotic-weapons", label: "Any exotic weapon", description: "Every exotic, by name" },
] as const;

function exoticNames(): string[] {
  return [...new Set(WEAPONS.filter((w) => w.quality === "Exotic").map((w) => w.name))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
}

/**
 * Which form owns a rule. Anything naming an item, restricted to named weapons, or watching the
 * weapon category belongs to the weapons form; gear types, sets and brands belong to the gear
 * form. Each form replaces only its own scope, so editing one never disturbs the other.
 */
export function ruleScope(rule: WatchRule): ModalScope {
  if (rule.itemName !== undefined) return "weapons";
  if (rule.namedOnly === true) return "weapons";
  if (rule.category === "weapon") return "weapons";
  return "gear";
}

function option(
  value: string,
  label: string,
  selected: Set<string>,
  description?: string,
): SelectOption {
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
      max_values: Math.min(Math.max(options.length, 1), SELECT_LIMIT),
      required: false,
      options,
    },
  };
}

interface StockSplit {
  inStock: string[];
  rest: string[];
  /** True when we could not split by stock and fell back to an alphabetical halving. */
  alphabetical: boolean;
}

/**
 * Split a list into "in stock now" and the rest.
 *
 * Falls back to an even alphabetical split when either half would exceed Discord's 25-option
 * cap — which happens if an unusual week stocks nearly everything, or when we have no cached
 * stock at all. The form stays usable either way; it just loses the stock framing.
 */
export function splitByStock(all: readonly string[], inStockNames: ReadonlySet<string>): StockSplit {
  const inStock = all.filter((v) => inStockNames.has(v));
  const rest = all.filter((v) => !inStockNames.has(v));
  if (inStock.length > 0 && inStock.length <= SELECT_LIMIT && rest.length <= SELECT_LIMIT) {
    return { inStock, rest, alphabetical: false };
  }
  const pages = balancedPages(all);
  return {
    inStock: pages[0]?.values ?? [],
    rest: pages[1]?.values ?? [],
    alphabetical: true,
  };
}

interface Selections {
  gearTypes: Set<string>;
  gearSets: Set<string>;
  brands: Set<string>;
  weaponTypes: Set<string>;
  exotics: Set<string>;
}

export function selectionsFromRules(rules: readonly WatchRule[]): Selections {
  const s: Selections = {
    gearTypes: new Set(),
    gearSets: new Set(),
    brands: new Set(),
    weaponTypes: new Set(),
    exotics: new Set(),
  };
  for (const rule of rules) {
    if (rule.itemName) s.exotics.add(rule.itemName);
    else if (rule.namedOnly === true) s.weaponTypes.add("named-weapons");
    else if (rule.category === "weapon") s.weaponTypes.add("weapon");
    else if (rule.gearSet) s.gearSets.add(rule.gearSet);
    else if (rule.brand) s.brands.add(rule.brand);
    else if (rule.category) s.gearTypes.add(rule.category);
  }
  return s;
}

/** Two sections for one dimension: what's in stock, then everything else. */
function stockSections(
  field: string,
  noun: string,
  all: readonly string[],
  entries: Map<string, { count: number; vendors: string[] }>,
  selected: Set<string>,
): MessageComponent[] {
  const split = splitByStock(all, new Set(entries.keys()));
  const build = (values: string[]): SelectOption[] =>
    values.map((v) => option(v, v, selected, describeStock(entries.get(v))));

  if (split.alphabetical) {
    // No usable stock data — fall back to a plain two-page list rather than lying about stock.
    return [
      selectField(`${field}:0`, `${noun} (1 of 2)`, `Alphabetical, first half`, build(split.inStock)),
      selectField(`${field}:1`, `${noun} (2 of 2)`, `Alphabetical, second half`, build(split.rest)),
    ];
  }

  const sections: MessageComponent[] = [
    selectField(
      `${field}:0`,
      `🔥 ${noun} in stock now`,
      `Available at vendors this week (${split.inStock.length})`,
      build(split.inStock),
    ),
  ];
  if (split.rest.length > 0) {
    sections.push(
      selectField(
        `${field}:1`,
        `${noun} — not in stock`,
        `Watch these for future weeks (${split.rest.length})`,
        build(split.rest),
      ),
    );
  }
  return sections;
}

export function buildGearModal(
  rules: readonly WatchRule[],
  stock: StockIndex = EMPTY_STOCK,
): ModalResponse {
  const s = selectionsFromRules(rules);

  const fields: MessageComponent[] = [
    ...stockSections(FIELD_GEAR_SET, "Gear sets", GEAR_SETS, stock.gearSets, s.gearSets),
    ...stockSections(FIELD_BRAND, "Brands", BRANDS, stock.brands, s.brands),
    // Broad catch-alls last: "All gear" is ~48 items a week, and leading with the firehose
    // invites over-subscribing before the specific options have been seen.
    selectField(
      FIELD_GEAR_TYPES,
      "Everything in a category",
      "Broad — alerts on every item of that type",
      GEAR_TYPE_CHOICES.map((c) => {
        const count = stock.categories.get(c.value);
        return option(c.value, c.label, s.gearTypes, count ? `${count} items this week` : c.description);
      }),
    ),
  ];

  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: GEAR_MODAL_ID,
      title: "Wishlist — gear",
      components: fields.slice(0, 5),
    },
  };
}

export function buildWeaponsModal(
  rules: readonly WatchRule[],
  stock: StockIndex = EMPTY_STOCK,
): ModalResponse {
  const s = selectionsFromRules(rules);
  const exotics = balancedPages(exoticNames());

  const fields: MessageComponent[] = [];

  exotics.forEach((page, i) => {
    fields.push(
      selectField(
        `${FIELD_EXOTIC}:${i}`,
        `Exotic weapons (${i + 1} of ${exotics.length})`,
        `${page.values[0]} → ${page.values[page.values.length - 1]}`,
        page.values.map((v) =>
          option(v, v, s.exotics, stock.itemNames.has(v) ? "in stock now" : undefined),
        ),
      ),
    );
  });

  fields.push(
    selectField(
      FIELD_WEAPON_TYPES,
      "Everything in a category",
      "Broad — alerts on every weapon of that kind",
      WEAPON_TYPE_CHOICES.map((c) => {
        const count = c.value === "weapon" ? stock.categories.get("weapon") : undefined;
        return option(
          c.value,
          c.label,
          s.weaponTypes,
          count ? `${count} weapons this week` : c.description,
        );
      }),
    ),
  );

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
 * Turn a submitted form into the rules it represents.
 *
 * Every value is re-resolved against the catalog rather than trusted. Menu values originate from
 * us, but validating here keeps a stale client or a replayed payload from storing a name that can
 * never match anything.
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
    each(FIELD_GEAR_TYPES, (value) => {
      const known = GEAR_TYPE_CHOICES.find((c) => c.value === value);
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
    each(FIELD_WEAPON_TYPES, (value) => {
      if (value === "weapon") {
        rules.push({ category: "weapon", label: "All weapons" });
      } else if (value === "named-weapons") {
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

export function diffRules(
  existing: readonly WatchRule[],
  desired: readonly WatchRule[],
): { added: WatchRule[]; removed: WatchRule[]; unchanged: WatchRule[] } {
  const existingKeys = new Map(existing.map((r) => [ruleKey(r), r]));
  const desiredKeys = new Map(desired.map((r) => [ruleKey(r), r]));

  return {
    added: desired.filter((r) => !existingKeys.has(ruleKey(r))),
    removed: existing.filter((r) => !desiredKeys.has(ruleKey(r))),
    unchanged: desired.filter((r) => existingKeys.has(ruleKey(r))),
  };
}
