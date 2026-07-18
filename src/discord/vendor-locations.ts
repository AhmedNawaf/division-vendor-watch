import { normalizeKey } from "../matcher/normalize.js";

/**
 * Short "where do I go" hints for the vendors that appear in the weekly reset.
 *
 * An alert that says an item is at "The Bridge" is only useful if you know where that is. These
 * are deliberately terse — enough to orient someone, not a walkthrough.
 *
 * A vendor with no entry simply renders without a hint. That is the important property: the feed
 * can introduce a vendor at any time, and showing a name alone is fine, whereas guessing a
 * location and being wrong sends someone across the map for nothing.
 */
const VENDOR_LOCATIONS: Record<string, string> = {
  // Washington DC
  "white house": "Base of Operations, DC",
  clan: "White House East Wing, DC",
  "the campus": "Downtown West settlement, DC",
  "the theater": "Downtown East settlement, DC",
  "the castle": "East Mall settlement, DC",

  // Dark Zones — each vendor sits in the checkpoint safe room.
  "dz west": "Dark Zone West checkpoint",
  "dz south": "Dark Zone South checkpoint",
  "dz east": "Dark Zone East checkpoint",

  // New York
  haven: "New York settlement",
  "the bridge": "Brooklyn settlement",

  // The only vendor without a fixed location: she appears once you find the Snitch, and moves.
  // No dash inside the hint: it is rendered after an em-dash, and "Cassie — Roaming — find…"
  // reads as a stutter.
  cassie: "Roaming (find the Snitch first)",

  // Deliberately absent: "Benitez". Roy Benitez is a New York NPC, but whether the vendor sits
  // in Haven or in The Bridge could not be confirmed, and sending someone to the wrong borough
  // is worse than showing the name alone.
};

/** Prefix that keeps the vendor line scannable against the item and stat lines around it. */
const PIN = "📍";

export function vendorLocation(vendor: string): string | undefined {
  return VENDOR_LOCATIONS[normalizeKey(vendor)];
}

/** "📍 White House — Base of Operations", or just "📍 White House" when unknown. */
export function vendorLine(vendor: string): string {
  const where = vendorLocation(vendor);
  return where ? `${PIN} ${vendor} — ${where}` : `${PIN} ${vendor}`;
}
