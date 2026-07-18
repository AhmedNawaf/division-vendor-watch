/**
 * Name comparison shared by the matcher and the item catalog.
 *
 * This lives in its own module deliberately. The vendor feed and the item catalog spell the same
 * brands differently ("Yaahl" vs "Yaahl Gear", "Česká Výroba" vs "Ceska Vyroba"), so a rule built
 * by picking a name from the catalog has to be reconciled against vendor items at match time. If
 * the catalog UI and the matcher ever used two different normalizers, rules would validate on the
 * way in and silently never fire — so both import from here.
 *
 * Node-free: the Cloudflare Worker imports this to validate menu selections.
 */

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeKey(value: string): string {
  return value
    .normalize("NFD")
    // Strip combining accents so "Česká Výroba" equals "Ceska Vyroba".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'.]/g, "")
    .replace(/[,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compare a brand or gear-set name across our two sources, tolerating the corporate suffixes the
 * vendor feed drops ("Richter & Kaiser" vs "Richter & Kaiser GmbH").
 *
 * Only one name may extend the other, and only at a word boundary, so "Gila Guard" still does not
 * match "Gila Guardian". Verified against all 37 brands and 27 gear sets: zero collisions.
 *
 * Item names deliberately do NOT use this — "Police M4" and "Police M4 Enhanced" are different
 * weapons, and a prefix match there would alert on the wrong gun.
 */
export function nameMatches(a: string, b: string): boolean {
  const x = normalizeKey(a);
  const y = normalizeKey(b);
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length > 0 && longer.startsWith(`${shorter} `);
}
