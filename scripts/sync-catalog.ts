/**
 * Regenerate the static item catalog from buildstation.app (the data backend behind mxswat's
 * Division 2 build tool).
 *
 *   npm run sync:catalog
 *
 * Why a committed snapshot rather than a runtime fetch:
 *  - The catalog is append-only and season-locked — roughly one new brand and one new gear set
 *    per season. A snapshot stays ~95% correct for a year, unlike vendor stock which is wrong
 *    after 7 days.
 *  - The Cloudflare Worker builds interaction menus from this data and must answer within 3
 *    seconds. Importing a bundled constant is instant and cannot fail.
 *  - It removes a runtime dependency on an undocumented third-party endpoint.
 *
 * Run it once a season (or via the monthly workflow) and commit the result.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://buildstation.app/api/td2/v2/data/mx";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "catalog", "catalog-data.ts");

/**
 * Not a real brand — the catalog uses it for crafted/generic gear, which no one would watch for.
 * Kept explicit rather than filtered silently so a future reader knows it was a decision.
 */
const NOT_A_BRAND = new Set(["Crafted", "Improvised Body Armor"]);

/**
 * Floors that catch an upstream that has broken or started serving an error page. Losing the
 * catalog silently would empty every dropdown in the bot, so refuse to write instead.
 */
const MINIMUMS = { brands: 30, gearSets: 20, weapons: 250, gear: 80, talents: 250, attributes: 30 };

/** RFC4180-ish parser. The data contains "Walker, Harris & Co." — naive splitting corrupts it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface Table {
  header: string[];
  rows: string[][];
}

async function fetchTable(name: string): Promise<Table> {
  const res = await fetch(`${BASE}/${name}`, {
    headers: { "user-agent": "division-vendor-watch/0.1 (catalog sync; personal project)" },
  });
  if (!res.ok) throw new Error(`Catalog fetch failed for ${name}: HTTP ${res.status}`);
  const parsed = parseCsv((await res.text()).trim());
  const [header, ...rows] = parsed;
  if (!header) throw new Error(`Catalog table ${name} was empty`);
  return { header, rows };
}

function column(table: Table, name: string): number {
  const index = table.header.indexOf(name);
  if (index === -1) {
    throw new Error(`Catalog table is missing the "${name}" column (got: ${table.header.join(", ")})`);
  }
  return index;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** The six armour slots, each published as its own table. */
const GEAR_SLOTS = ["mask", "chest", "backpack", "gloves", "holster", "kneepads"] as const;

/**
 * Talent tables encode quality as a single letter. Decoded here so the generated file is
 * readable and nothing downstream has to know the upstream's shorthand.
 */
const TALENT_QUALITY: Record<string, string> = {
  A: "Standard",
  N: "Named",
  E: "Exotic",
  S: "Gear Set",
};

interface CatalogGearRow {
  name: string;
  slot: string;
  quality: string;
}

/**
 * Named and Exotic gear pieces, by slot.
 *
 * High End and Gearset rows are deliberately skipped: for those the "Item Name" column holds the
 * *brand* or *set* name (a High End chest is literally listed as "5.11 Tactical"), which we
 * already carry in BRANDS and GEAR_SETS. Only Named and Exotic rows name an actual item.
 */
async function fetchGear(): Promise<CatalogGearRow[]> {
  const out: CatalogGearRow[] = [];
  const seen = new Set<string>();

  for (const slot of GEAR_SLOTS) {
    const table = await fetchTable(slot);
    const iName = column(table, "Item Name");
    const iQuality = column(table, "Quality");
    const label = slot.charAt(0).toUpperCase() + slot.slice(1);

    for (const row of table.rows) {
      const quality = (row[iQuality] ?? "").trim();
      if (quality !== "Named" && quality !== "Exotic") continue;
      const name = (row[iName] ?? "").trim();
      if (!name) continue;
      const key = `${quality}|${label}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, slot: label, quality });
    }
  }

  out.sort(
    (a, b) =>
      a.quality.localeCompare(b.quality, "en") ||
      a.slot.localeCompare(b.slot, "en") ||
      a.name.localeCompare(b.name, "en"),
  );
  return out;
}

interface CatalogTalentRow {
  name: string;
  kind: "weapon" | "gear";
  quality: string;
}

/** Talent names from both talent tables, deduplicated (gear talents repeat across slots). */
async function fetchTalents(): Promise<CatalogTalentRow[]> {
  const out: CatalogTalentRow[] = [];
  const seen = new Set<string>();

  const add = (name: string, kind: "weapon" | "gear", rawQuality: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const key = `${kind}|${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: trimmed, kind, quality: TALENT_QUALITY[rawQuality.trim()] ?? "Standard" });
  };

  const weaponTable = await fetchTable("weaponTalents");
  const wtName = column(weaponTable, "Name");
  const wtQuality = column(weaponTable, "Quality");
  for (const row of weaponTable.rows) add(row[wtName] ?? "", "weapon", row[wtQuality] ?? "");

  const gearTable = await fetchTable("gearTalents");
  const gtName = column(gearTable, "Talent");
  const gtQuality = column(gearTable, "Quality");
  for (const row of gearTable.rows) add(row[gtName] ?? "", "gear", row[gtQuality] ?? "");

  out.sort((a, b) => a.kind.localeCompare(b.kind, "en") || a.name.localeCompare(b.name, "en"));
  return out;
}

/** Distinct attribute (stat) names across gear and weapons, for attribute-based rules. */
async function fetchAttributes(): Promise<string[]> {
  const names: string[] = [];
  for (const table of ["gearAttributes", "weaponAttributes"] as const) {
    const t = await fetchTable(table);
    const iStat = column(t, "Stat");
    for (const row of t.rows) names.push(row[iStat] ?? "");
  }
  return unique(names);
}

async function main(): Promise<void> {
  console.log(`Fetching catalog from ${BASE} …`);

  const brandsTable = await fetchTable("brands");
  const bName = column(brandsTable, "Brand");
  const bType = column(brandsTable, "Type");
  const brands = unique(
    brandsTable.rows
      .filter((r) => r[bType] === "High End" && !NOT_A_BRAND.has((r[bName] ?? "").trim()))
      .map((r) => r[bName] ?? ""),
  );
  const gearSets = unique(
    brandsTable.rows.filter((r) => r[bType] === "Gearset").map((r) => r[bName] ?? ""),
  );

  const weaponTable = await fetchTable("weapon");
  const wName = column(weaponTable, "Name");
  const wType = column(weaponTable, "Weapon Type");
  const wQuality = column(weaponTable, "Quality");

  // Deduplicate by name+type+quality — the upstream has at least one repeated row
  // (The Bighorn appears twice).
  const seen = new Set<string>();
  const weapons: Array<{ name: string; type: string; quality: string }> = [];
  for (const row of weaponTable.rows) {
    const name = (row[wName] ?? "").trim();
    const type = (row[wType] ?? "").trim();
    const quality = (row[wQuality] ?? "").trim();
    if (!name || !type || !quality) continue;
    const key = `${quality}|${type}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    weapons.push({ name, type, quality });
  }
  weapons.sort(
    (a, b) =>
      a.quality.localeCompare(b.quality, "en") ||
      a.type.localeCompare(b.type, "en") ||
      a.name.localeCompare(b.name, "en"),
  );

  if (brands.length < MINIMUMS.brands) {
    throw new Error(`Only ${brands.length} brands parsed (expected >= ${MINIMUMS.brands}); refusing to write.`);
  }
  if (gearSets.length < MINIMUMS.gearSets) {
    throw new Error(`Only ${gearSets.length} gear sets parsed (expected >= ${MINIMUMS.gearSets}); refusing to write.`);
  }
  if (weapons.length < MINIMUMS.weapons) {
    throw new Error(`Only ${weapons.length} weapons parsed (expected >= ${MINIMUMS.weapons}); refusing to write.`);
  }

  const gear = await fetchGear();
  const talents = await fetchTalents();
  const attributes = await fetchAttributes();

  if (gear.length < MINIMUMS.gear) {
    throw new Error(`Only ${gear.length} named/exotic gear parsed (expected >= ${MINIMUMS.gear}); refusing to write.`);
  }
  if (talents.length < MINIMUMS.talents) {
    throw new Error(`Only ${talents.length} talents parsed (expected >= ${MINIMUMS.talents}); refusing to write.`);
  }
  if (attributes.length < MINIMUMS.attributes) {
    throw new Error(`Only ${attributes.length} attributes parsed (expected >= ${MINIMUMS.attributes}); refusing to write.`);
  }

  // Report what changed, so the seasonal refresh is reviewable rather than a blind diff.
  let previous: { BRANDS?: readonly string[]; GEAR_SETS?: readonly string[] } | undefined;
  try {
    previous = (await import("../src/catalog/catalog-data.js")) as typeof previous;
  } catch {
    console.log("(no existing catalog — first run)");
  }
  if (previous?.BRANDS) {
    const added = brands.filter((b) => !previous!.BRANDS!.includes(b));
    const removed = previous.BRANDS.filter((b) => !brands.includes(b));
    const setsAdded = gearSets.filter((g) => !(previous!.GEAR_SETS ?? []).includes(g));
    const setsRemoved = (previous.GEAR_SETS ?? []).filter((g) => !gearSets.includes(g));
    for (const [label, list] of [
      ["+ brand", added],
      ["- brand", removed],
      ["+ gear set", setsAdded],
      ["- gear set", setsRemoved],
    ] as const) {
      for (const value of list) console.log(`  ${label}: ${value}`);
    }
  }

  const checksum = createHash("sha256")
    .update(JSON.stringify({ brands, gearSets, weapons, gear, talents, attributes }))
    .digest("hex")
    .slice(0, 12);

  const body = `// GENERATED FILE — do not edit by hand. Run \`npm run sync:catalog\` to refresh.
//
// Source: ${BASE} (the data backend behind mxswat's Division 2 build tool).
// The catalog is append-only and season-locked, so this snapshot ages gracefully; refresh it
// once a season. See scripts/sync-catalog.ts for why this is committed rather than fetched.

/** Changes only when the data changes, so a no-op sync produces no diff. */
export const CATALOG_CHECKSUM = ${quote(checksum)};

export type WeaponQuality = ${[...new Set(weapons.map((w) => w.quality))]
    .sort()
    .map(quote)
    .join(" | ")};

export type WeaponType = ${[...new Set(weapons.map((w) => w.type))]
    .sort()
    .map(quote)
    .join(" | ")};

export interface CatalogWeapon {
  name: string;
  type: WeaponType;
  quality: WeaponQuality;
}

/** Brand sets (${brands.length}). Excludes the non-brand placeholder(s) used for crafted gear. */
export const BRANDS: readonly string[] = [
${brands.map((b) => `  ${quote(b)},`).join("\n")}
];

/** Gear sets (${gearSets.length}). */
export const GEAR_SETS: readonly string[] = [
${gearSets.map((g) => `  ${quote(g)},`).join("\n")}
];

/** Every weapon (${weapons.length}), deduplicated and sorted by quality, then type, then name. */
export const WEAPONS: readonly CatalogWeapon[] = [
${weapons
  .map((w) => `  { name: ${quote(w.name)}, type: ${quote(w.type)}, quality: ${quote(w.quality)} },`)
  .join("\n")}
];

export type GearSlot = ${[...new Set(gear.map((g) => g.slot))].sort().map(quote).join(" | ")};

export type GearQuality = ${[...new Set(gear.map((g) => g.quality))].sort().map(quote).join(" | ")};

export interface CatalogGear {
  name: string;
  slot: GearSlot;
  quality: GearQuality;
}

/**
 * Named and Exotic gear pieces (${gear.length}).
 *
 * High End and Gearset rows are excluded on purpose: upstream lists those by brand or set name
 * rather than item name, and those names already live in BRANDS and GEAR_SETS.
 */
export const GEAR: readonly CatalogGear[] = [
${gear
  .map((g) => `  { name: ${quote(g.name)}, slot: ${quote(g.slot)}, quality: ${quote(g.quality)} },`)
  .join("\n")}
];

export type TalentKind = "weapon" | "gear";

export type TalentQuality = ${[...new Set(talents.map((t) => t.quality))]
    .sort()
    .map(quote)
    .join(" | ")};

export interface CatalogTalent {
  name: string;
  kind: TalentKind;
  quality: TalentQuality;
}

/** Weapon and gear talents (${talents.length}), deduplicated by kind and name. */
export const TALENTS: readonly CatalogTalent[] = [
${talents
  .map((t) => `  { name: ${quote(t.name)}, kind: ${quote(t.kind)}, quality: ${quote(t.quality)} },`)
  .join("\n")}
];

/** Distinct attribute names across gear and weapons (${attributes.length}). */
export const ATTRIBUTES: readonly string[] = [
${attributes.map((a) => `  ${quote(a)},`).join("\n")}
];
`;

  await writeFile(OUT, body, "utf8");

  const tally = <T,>(list: readonly T[], key: (item: T) => string): string => {
    const counts: Record<string, number> = {};
    for (const item of list) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
    return Object.entries(counts)
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ");
  };

  console.log(`\nWrote ${OUT}`);
  console.log(`  checksum   ${checksum}`);
  console.log(`  brands     ${brands.length}`);
  console.log(`  gear sets  ${gearSets.length}`);
  console.log(`  weapons    ${weapons.length}  (${tally(weapons, (w) => w.quality)})`);
  console.log(`  gear       ${gear.length}  (${tally(gear, (g) => g.quality)})`);
  console.log(`  talents    ${talents.length}  (${tally(talents, (t) => t.kind)})`);
  console.log(`  attributes ${attributes.length}`);
}

main().catch((err: unknown) => {
  console.error(`Catalog sync failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
