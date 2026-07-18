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
const MINIMUMS = { brands: 30, gearSets: 20, weapons: 250 };

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
    .update(JSON.stringify({ brands, gearSets, weapons }))
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
`;

  await writeFile(OUT, body, "utf8");

  const byQuality: Record<string, number> = {};
  for (const w of weapons) byQuality[w.quality] = (byQuality[w.quality] ?? 0) + 1;

  console.log(`\nWrote ${OUT}`);
  console.log(`  checksum  ${checksum}`);
  console.log(`  brands    ${brands.length}`);
  console.log(`  gear sets ${gearSets.length}`);
  console.log(`  weapons   ${weapons.length}  (${Object.entries(byQuality)
    .map(([q, n]) => `${q}: ${n}`)
    .join(", ")})`);
}

main().catch((err: unknown) => {
  console.error(`Catalog sync failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
