import type { VendorItem } from "../../src/types/vendor.js";
import { resolveBrand, resolveGearSet, resolveWeapon } from "../../src/catalog/index.js";

/**
 * A view of this week's vendor stock, used to make the wishlist forms concrete.
 *
 * Without it every option in a 37-item dropdown looks identical and there is no way to tell
 * that Hunter's Fury has three pieces at vendors right now while another set has none. Discord
 * select menus have no search box (confirmed empirically — that is only true of the user/role
 * selects), so scanning a long list is the only way to find something; making the options
 * self-describing is what keeps that tolerable.
 */
export interface StockEntry {
  count: number;
  vendors: string[];
}

export interface StockIndex {
  gearSets: Map<string, StockEntry>;
  brands: Map<string, StockEntry>;
  categories: Map<string, number>;
  /** Weapons in stock, keyed by catalog-canonical name (see the resolution note below). */
  weapons: Map<string, StockEntry>;
  /** Raw vendor item names, exactly as published. */
  itemNames: Set<string>;
}

export const EMPTY_STOCK: StockIndex = {
  gearSets: new Map(),
  brands: new Map(),
  categories: new Map(),
  weapons: new Map(),
  itemNames: new Set(),
};

function bump(map: Map<string, StockEntry>, key: string, vendor: string): void {
  const entry = map.get(key) ?? { count: 0, vendors: [] };
  entry.count += 1;
  if (!entry.vendors.includes(vendor)) entry.vendors.push(vendor);
  map.set(key, entry);
}

/**
 * Index parsed stock by catalog-canonical names. Vendor spellings are resolved through the
 * catalog so "Yaahl" lands under "Yaahl Gear" — the same reconciliation the matcher does, or
 * the counts shown in the form would disagree with what actually alerts.
 */
export function indexStock(items: readonly VendorItem[]): StockIndex {
  const index: StockIndex = {
    gearSets: new Map(),
    brands: new Map(),
    categories: new Map(),
    weapons: new Map(),
    itemNames: new Set(),
  };

  for (const item of items) {
    index.itemNames.add(item.name);
    index.categories.set(item.category, (index.categories.get(item.category) ?? 0) + 1);

    if (item.gearSet) {
      const canonical = resolveGearSet(item.gearSet);
      if (canonical) bump(index.gearSets, canonical, item.vendor);
    }
    if (item.brand) {
      const canonical = resolveBrand(item.brand);
      if (canonical) bump(index.brands, canonical, item.vendor);
    }
    if (item.category === "weapon") {
      // The feed writes "Pyromaniac - Police M4"; the catalog says "Pyromaniac". Resolving here
      // is what lets the form mark a named weapon as in stock at all.
      const canonical = resolveWeapon(item.name);
      if (canonical) bump(index.weapons, canonical.name, item.vendor);
    }
  }

  return index;
}

/** "3 in stock — The Campus, DZ West", or undefined when the entry has nothing this week. */
export function describeStock(entry: StockEntry | undefined): string | undefined {
  if (!entry || entry.count === 0) return undefined;
  const pieces = `${entry.count} in stock`;
  const where = entry.vendors.slice(0, 2).join(", ");
  const more = entry.vendors.length > 2 ? ` +${entry.vendors.length - 2}` : "";
  return where ? `${pieces} — ${where}${more}` : pieces;
}
