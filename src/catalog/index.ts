import { nameMatches } from "../matcher/normalize.js";
import {
  BRANDS,
  GEAR_SETS,
  WEAPONS,
  type CatalogWeapon,
  type WeaponQuality,
  type WeaponType,
} from "./catalog-data.js";

export { BRANDS, GEAR_SETS, WEAPONS, CATALOG_CHECKSUM } from "./catalog-data.js";
export type { CatalogWeapon, WeaponQuality, WeaponType } from "./catalog-data.js";

/**
 * Helpers for turning the static catalog into Discord menus.
 *
 * Node-free — the Worker imports this. The hard constraint everything here works around is that
 * a Discord String Select holds at most 25 options and has no search box (that is only true of
 * the user/role/channel selects), so any list longer than 25 must be split into pages the user
 * navigates by picking a range.
 */

/** Discord's hard cap on options in a single String Select. */
export const SELECT_LIMIT = 25;

export interface CatalogPage<T> {
  /** Human label for the page, e.g. "A–L". */
  label: string;
  values: T[];
}

function initial(value: string): string {
  const ch = value.trim()[0]?.toUpperCase() ?? "?";
  return /[A-Z]/.test(ch) ? ch : "#";
}

/**
 * Split a sorted list into pages of at most `size`, labelled by the first-letter range they
 * cover ("A–L"). Ranges beat "Page 1 / Page 2" because the user is looking for a name they
 * already know and can jump straight to the right page.
 */
export function paginate(values: readonly string[], size: number = SELECT_LIMIT): CatalogPage<string>[] {
  if (values.length === 0) return [];
  const pages: CatalogPage<string>[] = [];
  for (let i = 0; i < values.length; i += size) {
    const chunk = values.slice(i, i + size);
    const from = initial(chunk[0]!);
    const to = initial(chunk[chunk.length - 1]!);
    pages.push({ label: from === to ? from : `${from}–${to}`, values: [...chunk] });
  }
  return pages;
}

export function brandPages(): CatalogPage<string>[] {
  return paginate(BRANDS);
}

export function gearSetPages(): CatalogPage<string>[] {
  return paginate(GEAR_SETS);
}

/** Every weapon type present in the catalog, in display order. */
export function weaponTypes(): WeaponType[] {
  return [...new Set(WEAPONS.map((w) => w.type))].sort((a, b) => a.localeCompare(b, "en"));
}

/**
 * Weapons of one quality and type. Exotic and Named buckets are all comfortably under 25, which
 * is why the weapon picker can stay click-only instead of needing autocomplete; only the High End
 * (base) buckets for Assault Rifle and SMG overflow, and those are not worth watching per-item.
 */
export function weaponsOf(quality: WeaponQuality, type: WeaponType): CatalogWeapon[] {
  return WEAPONS.filter((w) => w.quality === quality && w.type === type);
}

/** True when a quality/type bucket fits in one select — i.e. needs no paging. */
export function bucketFits(quality: WeaponQuality, type: WeaponType): boolean {
  return weaponsOf(quality, type).length <= SELECT_LIMIT;
}

/**
 * Resolve a user-supplied name to its canonical catalog spelling, or undefined if unknown.
 *
 * Everything arriving from Discord must go through one of these lookups before being stored.
 * Menu values are ours, but autocomplete values are not: Discord documents that "options using
 * autocomplete are not confined to only use choices given by the application", so a user can
 * submit arbitrary text. Storing an unvalidated name yields a rule that can never match.
 */
export function resolveBrand(name: string): string | undefined {
  return BRANDS.find((b) => nameMatches(b, name));
}

export function resolveGearSet(name: string): string | undefined {
  return GEAR_SETS.find((g) => nameMatches(g, name));
}

/** Weapon names are matched exactly (after normalization) — suffixes distinguish real weapons. */
export function resolveWeapon(name: string): CatalogWeapon | undefined {
  const target = name.trim().toLowerCase();
  return WEAPONS.find((w) => w.name.toLowerCase() === target);
}
