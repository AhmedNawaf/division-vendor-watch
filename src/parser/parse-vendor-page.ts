import { load } from "cheerio";
import { ParserError } from "../errors.js";
import type {
  AttributeUnit,
  ItemCategory,
  VendorAttribute,
  VendorItem,
  VendorReset,
} from "../types/vendor.js";
import type { PayloadType, RawVendorData } from "../source/vendor-source.js";

export interface ParseOptions {
  /** Reject the whole reset if fewer than this many items were normalized. */
  minTotalItems?: number;
  /** Sections that must be non-empty; a missing section signals a source change. */
  requiredSections?: PayloadType[];
}

const DEFAULTS: Required<ParseOptions> = {
  minTotalItems: 10,
  requiredSections: ["gear", "weapons"],
};

/** Division 2 skill platforms; a mod whose attribute is prefixed by one is a skill mod. */
const SKILL_PLATFORMS = [
  "Drone",
  "Turret",
  "Hive",
  "Pulse",
  "Trap",
  "Seeker Mine",
  "Shield",
  "Firefly",
  "Decoy",
  "Chem Launcher",
  "Sticky Bomb",
  "Reviver Hive",
  "Reinforcer",
  "Banshee",
];

/** Collapse runs of whitespace and trim; safe for names, vendors, attribute text. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Split a fragment on <br> boundaries into individual attribute chunks. */
function splitOnBreaks(fragment: string): string[] {
  return fragment
    .split(/<br\s*\/?>/i)
    .map((part) => part)
    .filter((part) => part.trim().length > 0);
}

function extractRole(fragment: string): string | undefined {
  const match = fragment.match(/class=["']?icon-([a-z0-9]+)/i);
  return match ? match[1]!.toLowerCase() : undefined;
}

function stripToText(fragment: string): string {
  return normalizeWhitespace(load(fragment).root().text());
}

/** Parse "5.7% Critical Hit Chance" / "16,335 Health" / "1 Skill Tier" into an attribute. */
export function parseAttribute(fragment: string, role?: string): VendorAttribute {
  const resolvedRole = role ?? extractRole(fragment);
  const text = stripToText(fragment);
  const attr: VendorAttribute = { name: text, rawValue: text, unit: "unknown", role: resolvedRole };

  const match = text.match(/^([\d][\d.,]*)\s*([%kKmM]?)\s*(.*)$/);
  if (!match) return attr;

  const [, rawNumber, suffix, rest] = match;
  const numeric = Number.parseFloat(rawNumber!.replace(/,/g, ""));
  if (Number.isNaN(numeric)) return attr;

  let value = numeric;
  let unit: AttributeUnit = "flat";
  if (suffix === "%") {
    unit = "%";
  } else if (suffix === "k" || suffix === "K") {
    value = numeric * 1000;
  }

  const name = normalizeWhitespace(rest ?? "");
  return {
    name: name.length > 0 ? name : text,
    value,
    unit,
    rawValue: text,
    role: resolvedRole,
  };
}

/** Parse a multi-attribute fragment (may contain several <br>-separated stats). */
function parseAttributeList(fragment: string | undefined): VendorAttribute[] {
  if (!fragment || fragment.trim() === "-") return [];
  return splitOnBreaks(fragment)
    .map((part) => parseAttribute(part, extractRole(part)))
    .filter((attr) => attr.rawValue.length > 0 && attr.rawValue !== "-");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ParserError("Vendor record was not an object; source structure likely changed", {
      received: typeof value,
    });
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, type: PayloadType): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ParserError(`Missing required "${key}" on a ${type} record`, {
      key,
      type,
      record,
    });
  }
  return normalizeWhitespace(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const cleaned = stripToText(value);
  return cleaned.length > 0 && cleaned !== "-" ? cleaned : undefined;
}

interface ModShape {
  category: ItemCategory;
  /** Skill platform for skill mods (e.g. "Drone"), when present. */
  platform?: string;
  attributes: VendorAttribute[];
}

/**
 * A mod whose attribute fragment starts with a skill platform (e.g. "Drone<br/>4.2% Damage")
 * is a skill mod; the platform is context, not a roll, so it is stripped from attributes.
 */
function classifyMod(attributesFragment: string | undefined): ModShape {
  if (!attributesFragment || attributesFragment.trim() === "-") {
    return { category: "gear-mod", attributes: [] };
  }
  const chunks = splitOnBreaks(attributesFragment);
  const firstText = normalizeWhitespace(stripToText(chunks[0] ?? ""));
  const platform = SKILL_PLATFORMS.find((p) => firstText.toLowerCase() === p.toLowerCase());

  if (platform) {
    const statChunks = chunks.slice(1);
    return {
      category: "skill-mod",
      platform,
      attributes: statChunks.map((c) => parseAttribute(c, extractRole(c))),
    };
  }
  return { category: "gear-mod", attributes: parseAttributeList(attributesFragment) };
}

function normalizeGear(record: Record<string, unknown>): VendorItem {
  const rarity = typeof record.rarity === "string" ? record.rarity : "";
  const isGearSet = rarity === "header-gs";
  const brandField = optionalString(record, "brand");
  const coreList = parseAttributeList(record.core as string | undefined);

  return {
    vendor: requireString(record, "vendor", "gear"),
    name: requireString(record, "name", "gear"),
    category: "gear",
    slot: optionalString(record, "slot"),
    brand: isGearSet ? undefined : brandField,
    gearSet: isGearSet ? brandField : undefined,
    talent: optionalString(record, "talents"),
    coreAttribute: coreList[0],
    attributes: parseAttributeList(record.attributes as string | undefined),
    isNamed: rarity === "header-named",
    rawText: JSON.stringify(record),
  };
}

function normalizeWeapon(record: Record<string, unknown>): VendorItem {
  const attributes = [record.attribute1, record.attribute2, record.attribute3]
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => parseAttributeList(value));

  return {
    vendor: requireString(record, "vendor", "weapons"),
    name: requireString(record, "name", "weapons"),
    category: "weapon",
    talent: optionalString(record, "talent"),
    attributes,
    isNamed: record.rarity === "header-named",
    rawText: JSON.stringify(record),
  };
}

function normalizeMod(record: Record<string, unknown>): VendorItem {
  const shape = classifyMod(record.attributes as string | undefined);
  return {
    vendor: requireString(record, "vendor", "mods"),
    name: requireString(record, "name", "mods"),
    category: shape.category,
    attributes: shape.attributes,
    isNamed: record.rarity === "header-named",
    rawText: JSON.stringify(record),
  };
}

const NORMALIZERS: Record<PayloadType, (record: Record<string, unknown>) => VendorItem> = {
  gear: normalizeGear,
  weapons: normalizeWeapon,
  mods: normalizeMod,
};

/**
 * Fields we read off each payload. Individual records may legitimately omit an optional field,
 * but a field absent from *every* record in a payload means the upstream shape changed —
 * which would otherwise degrade silently into items with no talents, no attributes, and no
 * matches, i.e. a watcher that quietly stops alerting.
 */
const EXPECTED_FIELDS: Record<PayloadType, string[]> = {
  gear: ["vendor", "name", "rarity", "brand", "slot", "core", "attributes", "talents"],
  weapons: ["vendor", "name", "rarity", "talent", "attribute1", "attribute2", "attribute3"],
  mods: ["vendor", "name", "rarity", "attributes"],
};

/**
 * Absence is only evidence at scale. Real payloads carry 40-55 records, so a field missing from
 * all of them is a shape change; in a handful of records it is just a sparse week. Below this
 * threshold we stay quiet and let the item-count check speak instead.
 */
const MIN_RECORDS_FOR_SHAPE_CHECK = 10;

function assertPayloadShape(type: PayloadType, records: Record<string, unknown>[]): void {
  if (records.length < MIN_RECORDS_FOR_SHAPE_CHECK) return;
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) seen.add(key);
  }
  const absent = EXPECTED_FIELDS[type].filter((field) => !seen.has(field));
  if (absent.length > 0) {
    throw new ParserError(
      `Source shape changed: no ${type} record contains ${absent.join(", ")}`,
      { type, absent, present: [...seen].sort(), records: records.length },
    );
  }
}

/** Normalize raw source data into a validated VendorReset. Throws ParserError on bad structure. */
export function parseVendorData(raw: RawVendorData, options: ParseOptions = {}): VendorReset {
  const config = { ...DEFAULTS, ...options };
  const items: VendorItem[] = [];
  const countsByType: Record<string, number> = {};

  const recordsByType: Array<[PayloadType, Record<string, unknown>[]]> = [];
  for (const payload of raw.payloads) {
    const normalize = NORMALIZERS[payload.type];
    const records = payload.records.map(asRecord);
    recordsByType.push([payload.type, records]);
    for (const record of records) items.push(normalize(record));
    countsByType[payload.type] = records.length;
  }

  if (items.length === 0) {
    throw new ParserError("No items were parsed from the vendor source", {
      countsByType,
      sourceUrl: raw.sourceUrl,
    });
  }

  const vendors = new Set(items.map((item) => item.vendor));
  if (vendors.size === 0) {
    throw new ParserError("No vendors were found in the parsed items", {
      sourceUrl: raw.sourceUrl,
    });
  }

  for (const section of config.requiredSections) {
    if (!countsByType[section]) {
      throw new ParserError(`Required section "${section}" produced no items`, {
        section,
        countsByType,
      });
    }
  }

  if (items.length < config.minTotalItems) {
    throw new ParserError(
      `Unexpectedly low item count (${items.length} < ${config.minTotalItems}); source may have changed`,
      { count: items.length, minTotalItems: config.minTotalItems, countsByType },
    );
  }

  // Last: the payload is big enough to be real, so a field missing everywhere is a shape change.
  for (const [type, records] of recordsByType) assertPayloadShape(type, records);

  return {
    sourceUrl: raw.sourceUrl,
    updatedAt: raw.resetDate,
    fetchedAt: raw.fetchedAt,
    items,
  };
}
