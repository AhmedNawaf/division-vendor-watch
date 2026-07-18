export type ItemCategory =
  | "weapon"
  | "gear"
  | "gear-mod"
  | "skill-mod"
  | "unknown";

export type AttributeUnit = "%" | "flat" | "unknown";

export interface VendorAttribute {
  /** Human-readable attribute name, e.g. "Critical Hit Chance". */
  name: string;
  /** Parsed numeric value when one could be extracted, e.g. 5.7 for "5.7%". */
  value?: number;
  unit?: AttributeUnit;
  /** The exact text this attribute was derived from, e.g. "5.7% Critical Hit Chance". */
  rawValue: string;
  /** Role marker from the source icon: offensive/defensive/utility/weapon/skill/active. */
  role?: string;
}

export interface VendorItem {
  vendor: string;
  name: string;
  category: ItemCategory;
  /** Armour slot for gear — Mask, Chest, Backpack, Gloves, Holster, Kneepads. */
  slot?: string;
  brand?: string;
  gearSet?: string;
  talent?: string;
  /** The "core"/primary attribute for gear, when present. */
  coreAttribute?: VendorAttribute;
  attributes: VendorAttribute[];
  /** Named ("exotic-name" tier) item flag. */
  isNamed: boolean;
  /** The untouched source record text, preserved so parser failures are debuggable. */
  rawText: string;
}

export interface VendorReset {
  sourceUrl: string;
  /** The weekly reset date discovered from the source (YYYY-MM-DD), when available. */
  updatedAt?: string;
  /** ISO timestamp of when this run fetched the data. */
  fetchedAt: string;
  items: VendorItem[];
}
