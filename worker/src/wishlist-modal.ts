import type { WatchRule } from "../../src/config/watchlist-schema.js";
import {
  BRANDS,
  GEAR_SETS,
  WEAPONS,
  balancedPages,
  resolveBrand,
  resolveGearItem,
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
const FIELD_WEAPON = "weapon";

export type ModalScope = "gear" | "weapons";

/** Gear-side categories only — weapons are the other form's business. */
const GEAR_TYPE_CHOICES = [
  { value: "named-gear", label: "Any named gear", description: "Named-tier armor pieces" },
  { value: "gear", label: "All gear", description: "Every armor piece" },
  { value: "gear-mod", label: "All gear mods", description: "Every gear mod" },
  { value: "skill-mod", label: "All skill mods", description: "Every skill mod" },
] as const;

const WEAPON_TYPE_CHOICES = [
  { value: "weapon", label: "All weapons", description: "Every weapon the vendors carry" },
  { value: "named-weapons", label: "Any named weapon", description: "Only named-tier weapons" },
] as const;

/**
 * Named weapons — the only individually watchable weapons that vendors actually stock.
 *
 * Exotics are deliberately absent. The vendor feed publishes only header-named, header-he and
 * header-gs, so no exotic ever appears at a vendor; offering them produced 44 options that could
 * never fire.
 */
function namedWeaponNames(): string[] {
  return [...new Set(WEAPONS.filter((w) => w.quality === "Named").map((w) => w.name))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
}

/**
 * Which form owns a rule.
 *
 * Keyed on category rather than `namedOnly`, because both forms now offer a "named" toggle:
 * "Any named weapon" and "Any named gear" differ only by category, and an earlier version that
 * branched on `namedOnly` would have routed named gear to the weapons form.
 */
export function ruleScope(rule: WatchRule): ModalScope {
  if (rule.category === "weapon") return "weapons";
  if (rule.itemName !== undefined) {
    // Item names are weapons today; resolve so named gear lands correctly if that changes.
    if (resolveWeapon(rule.itemName)) return "weapons";
    if (resolveGearItem(rule.itemName)) return "gear";
    return "weapons";
  }
  if (rule.category !== undefined) return "gear";
  // A bare namedOnly rule predates the split; it meant weapons.
  return rule.namedOnly === true ? "weapons" : "gear";
}

/**
 * The option value that would represent a rule in its form.
 *
 * A submit may only delete rules whose value the form actually rendered — see
 * `renderedValues`. Without that, a form showing a subset of a large list (as the weapons form
 * does) would silently delete every watch it could not display.
 */
export function ruleValue(rule: WatchRule): string {
  if (rule.itemName !== undefined) return rule.itemName;
  if (rule.gearSet !== undefined) return rule.gearSet;
  if (rule.brand !== undefined) return rule.brand;
  if (rule.category === "weapon") return rule.namedOnly === true ? "named-weapons" : "weapon";
  if (rule.category === "gear" && rule.namedOnly === true) return "named-gear";
  return rule.category ?? "";
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
function splitByStock(all: readonly string[], inStockNames: ReadonlySet<string>): StockSplit {
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
  weapons: Set<string>;
}

function selectionsFromRules(rules: readonly WatchRule[]): Selections {
  const s: Selections = {
    gearTypes: new Set(),
    gearSets: new Set(),
    brands: new Set(),
    weaponTypes: new Set(),
    weapons: new Set(),
  };
  for (const rule of rules) {
    // Mirrors ruleValue: whichever option would represent this rule is the one to pre-tick.
    if (rule.itemName) s.weapons.add(rule.itemName);
    else if (rule.category === "weapon") {
      s.weaponTypes.add(rule.namedOnly === true ? "named-weapons" : "weapon");
    } else if (rule.gearSet) s.gearSets.add(rule.gearSet);
    else if (rule.brand) s.brands.add(rule.brand);
    else if (rule.category === "gear" && rule.namedOnly === true) s.gearTypes.add("named-gear");
    else if (rule.category) s.gearTypes.add(rule.category);
    else if (rule.namedOnly === true) s.weaponTypes.add("named-weapons");
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

/**
 * Which named weapons the weapons form lists: everything in stock, plus everything the user is
 * already watching.
 *
 * There are 101 named weapons and only 25 fit a select, so the form cannot show them all. Listing
 * the user's existing watches is what makes the form safe to submit — otherwise a scope-replace
 * would delete every watch the form happened not to display.
 */
function weaponsToList(watched: ReadonlySet<string>, stock: StockIndex): {
  inStock: string[];
  watchedElsewhere: string[];
} {
  const named = new Set(namedWeaponNames());
  const inStock = [...stock.weapons.keys()].filter((n) => named.has(n)).sort((a, b) => a.localeCompare(b, "en"));
  const inStockSet = new Set(inStock);
  // Only named weapons are listed: anything else a user somehow watches (an exotic left over
  // from an older version, say) can never fire, and offering it would imply otherwise.
  const watchedElsewhere = [...watched]
    .filter((n) => named.has(n) && !inStockSet.has(n))
    .sort((a, b) => a.localeCompare(b, "en"));
  return { inStock: inStock.slice(0, SELECT_LIMIT), watchedElsewhere: watchedElsewhere.slice(0, SELECT_LIMIT) };
}

export function buildWeaponsModal(
  rules: readonly WatchRule[],
  stock: StockIndex = EMPTY_STOCK,
): ModalResponse {
  const s = selectionsFromRules(rules);
  const { inStock, watchedElsewhere } = weaponsToList(s.weapons, stock);
  const fields: MessageComponent[] = [];

  if (inStock.length > 0) {
    fields.push(
      selectField(
        `${FIELD_WEAPON}:0`,
        "🔥 Named weapons in stock now",
        `At vendors this week (${inStock.length})`,
        inStock.map((v) => option(v, v, s.weapons, describeStock(stock.weapons.get(v)))),
      ),
    );
  }

  if (watchedElsewhere.length > 0) {
    fields.push(
      selectField(
        `${FIELD_WEAPON}:1`,
        "Named weapons you're watching",
        "Not in stock this week — deselect to stop watching",
        watchedElsewhere.map((v) => option(v, v, s.weapons)),
      ),
    );
  }

  fields.push(
    selectField(
      FIELD_WEAPON_TYPES,
      "Everything in a category",
      "Broad — alerts on every weapon of that kind",
      WEAPON_TYPE_CHOICES.map((c) => {
        // stock.weapons counts every resolved weapon, High End included, so the named count
        // comes from the named-only list rather than that map's size.
        const count =
          c.value === "weapon"
            ? stock.categories.get("weapon")
            : c.value === "named-weapons"
              ? inStock.length
              : undefined;
        return option(
          c.value,
          c.label,
          s.weaponTypes,
          count ? `${count} this week` : c.description,
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

/**
 * The option values a form currently renders. A submit may only delete rules whose value appears
 * here; anything the form could not display is left untouched.
 *
 * The gear form renders every set, brand and type, so nothing is ever withheld there. The weapons
 * form can only show a slice of 101 named weapons, which is exactly why this exists.
 */
export function renderedValues(
  scope: ModalScope,
  rules: readonly WatchRule[],
  stock: StockIndex = EMPTY_STOCK,
): Set<string> {
  if (scope === "gear") {
    return new Set<string>([
      ...GEAR_SETS,
      ...BRANDS,
      ...GEAR_TYPE_CHOICES.map((c) => c.value),
    ]);
  }
  const s = selectionsFromRules(rules);
  const { inStock, watchedElsewhere } = weaponsToList(s.weapons, stock);
  return new Set<string>([
    ...inStock,
    ...watchedElsewhere,
    ...WEAPON_TYPE_CHOICES.map((c) => c.value),
  ]);
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
      if (value === "named-gear") {
        rules.push({ category: "gear", namedOnly: true, label: known.label });
        return;
      }
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
      } else {
        rejected.push(value);
      }
    });
    each(FIELD_WEAPON, (value) => {
      const weapon = resolveWeapon(value);
      // Only named weapons are individually watchable: vendors never stock exotics, and base
      // High End weapons are too common to be worth a per-item alert.
      if (!weapon || weapon.quality !== "Named") return rejected.push(value);
      rules.push({ itemName: weapon.name, label: weapon.name });
    });
  }

  return { rules: dedupeRules(rules), rejected };
}

/** A rule's identity, so "already watching this" is decidable without duplicating rows. */
function ruleKey(rule: WatchRule): string {
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
