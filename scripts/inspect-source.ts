/**
 * Inspection helper: fetch the live vendor source, print a structural summary,
 * and refresh the local fixtures under testdata/. Run with `npm run inspect`.
 *
 * This is a developer tool, not part of the shipped app. It exists so you can
 * re-verify selectors/URLs whenever the source site changes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fetchVendorData } from "../src/source/vendor-source.js";
import { parseVendorData } from "../src/parser/parse-vendor-page.js";

const vendorUrl =
  process.env.VENDOR_URL || "https://rubenalamina.mx/the-division-weekly-vendor-reset/";

async function main(): Promise<void> {
  const raw = await fetchVendorData({ vendorUrl });
  console.log(`Source: ${raw.sourceUrl}`);
  console.log(`Reset date: ${raw.resetDate ?? "(not found)"}`);

  await mkdir("testdata", { recursive: true });
  for (const payload of raw.payloads) {
    console.log(`  ${payload.type}: ${payload.records.length} records  <- ${payload.url}`);
    await writeFile(`testdata/${payload.type}.json`, JSON.stringify(payload.records, null, 1), "utf8");
  }

  const reset = parseVendorData(raw);
  const byCategory = new Map<string, number>();
  for (const item of reset.items) {
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
  }
  console.log(`Normalized ${reset.items.length} items:`);
  for (const [category, count] of byCategory) console.log(`  ${category}: ${count}`);
  console.log(`Vendors: ${[...new Set(reset.items.map((i) => i.vendor))].join(", ")}`);
  console.log("Fixtures refreshed under testdata/.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
