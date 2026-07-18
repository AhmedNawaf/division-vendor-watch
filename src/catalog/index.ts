import { nameMatches, normalizeKey } from "../matcher/normalize.js";
import {
  ATTRIBUTES,
  BRANDS,
  GEAR,
  GEAR_SETS,
  TALENTS,
  WEAPONS,
  type CatalogGear,
  type CatalogTalent,
  type CatalogWeapon,
  type TalentKind,
  type WeaponQuality,
  type WeaponType,
} from "./catalog-data.js";

export {
  ATTRIBUTES,
  BRANDS,
  GEAR,
  GEAR_SETS,
  TALENTS,
  WEAPONS,
  CATALOG_CHECKSUM,
} from "./catalog-data.js";
export type {
  CatalogGear,
  CatalogTalent,
  CatalogWeapon,
  GearQuality,
  GearSlot,
  TalentKind,
  TalentQuality,
  WeaponQuality,
  WeaponType,
} from "./catalog-data.js";

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

/**
 * Split into the fewest pages that fit, then spread evenly across them. Plain chunking would
 * put 27 gear sets into pages of 25 and 2, which reads as a bug; this gives 14 and 13.
 */
export function balancedPages(
  values: readonly string[],
  max: number = SELECT_LIMIT,
): CatalogPage<string>[] {
  if (values.length === 0) return [];
  const pageCount = Math.ceil(values.length / max);
  const perPage = Math.ceil(values.length / pageCount);
  return paginate(values, perPage);
}

export function brandPages(): CatalogPage<string>[] {
  return balancedPages(BRANDS);
}

export function gearSetPages(): CatalogPage<string>[] {
  return balancedPages(GEAR_SETS);
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

/**
 * The vendor feed writes named items as "<Named> - <Base item>", with either a hyphen or an
 * en-dash ("Pyromaniac - Police M4", "Cuélebre – Military M870"), while the catalog stores only
 * the named part. Without reconciling that, watching a named weapon by name would silently never
 * fire — the same failure mode as the brand suffixes, and just as invisible.
 */
function namedPrefix(name: string): string {
  return name.split(/\s+[-–—]\s+/)[0]!.trim();
}

/**
 * Weapon names are matched exactly (after normalization) rather than by prefix — "Police M4" and
 * "Police M4 Enhanced" are different guns. The named-item separator is handled first, since that
 * is a formatting difference between sources rather than a different item.
 */
export function resolveWeapon(name: string): CatalogWeapon | undefined {
  const exact = normalizeKey(name);
  const direct = WEAPONS.find((w) => normalizeKey(w.name) === exact);
  if (direct) return direct;
  const prefix = normalizeKey(namedPrefix(name));
  return WEAPONS.find((w) => normalizeKey(w.name) === prefix);
}

/** Named or Exotic gear pieces, resolved the same way as weapons. */
export function resolveGearItem(name: string): CatalogGear | undefined {
  const exact = normalizeKey(name);
  const direct = GEAR.find((g) => normalizeKey(g.name) === exact);
  if (direct) return direct;
  const prefix = normalizeKey(namedPrefix(name));
  return GEAR.find((g) => normalizeKey(g.name) === prefix);
}

export function resolveTalent(name: string, kind?: TalentKind): CatalogTalent | undefined {
  const target = normalizeKey(name);
  return TALENTS.find((t) => normalizeKey(t.name) === target && (!kind || t.kind === kind));
}

export function resolveAttribute(name: string): string | undefined {
  const target = normalizeKey(name);
  return ATTRIBUTES.find((a) => normalizeKey(a) === target);
}

/** Gear pieces vendors can actually stock. Exotics never appear at vendors, so they are excluded. */
export function vendorSellableGear(): CatalogGear[] {
  return GEAR.filter((g) => g.quality === "Named");
}

/** Weapons vendors can actually stock: High End and Named, never Exotic. */
export function vendorSellableWeapons(): CatalogWeapon[] {
  return WEAPONS.filter((w) => w.quality !== "Exotic");
}
