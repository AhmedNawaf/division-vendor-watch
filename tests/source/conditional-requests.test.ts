import { describe, expect, it } from "vitest";
import { fetchVendorData } from "../../src/source/vendor-source.js";
import { makeFakeFetch, readFixture, requestHeader, type FakeRoute } from "../helpers.js";

const VENDOR_URL = "https://rubenalamina.mx/the-division-weekly-vendor-reset/";
const LM = "Tue, 14 Jul 2026 08:30:00 GMT";

const gearJson = JSON.stringify([{ type: "gear", vendor: "V", name: "G" }]);
const weaponsJson = JSON.stringify([{ type: "weapon", vendor: "V", name: "W" }]);
const modsJson = JSON.stringify([{ type: "mod", vendor: "V", name: "M" }]);
const BODIES: Record<string, string> = {
  "gear.json": gearJson,
  "weapons.json": weaponsJson,
  "mods.json": modsJson,
};

/** A primary source that answers 304 when the request's If-Modified-Since matches `LM`. */
function conditionalRoutes(html: string, stamps: Record<string, string> = {}) {
  const jsonRoute =
    (file: string) =>
    (init?: RequestInit): FakeRoute => {
      const ims = requestHeader(init, "if-modified-since");
      if (ims && ims === (stamps[file] ?? LM)) {
        return { status: 304, body: "", headers: { "last-modified": stamps[file] ?? LM } };
      }
      return { body: BODIES[file]!, headers: { "last-modified": stamps[file] ?? LM } };
    };
  return [
    { match: "the-division-weekly-vendor-reset", route: { contentType: "text/html", body: html } },
    { match: "gear.json", route: jsonRoute("gear.json") },
    { match: "weapons.json", route: jsonRoute("weapons.json") },
    { match: "mods.json", route: jsonRoute("mods.json") },
  ];
}

describe("conditional requests", () => {
  const html = readFixture("vendor-page.html");

  it("captures Last-Modified so the next run can send If-Modified-Since", async () => {
    const { fetchImpl } = makeFakeFetch(conditionalRoutes(html));
    const raw = await fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl });

    expect(raw.notModified).toBeUndefined();
    expect(raw.payloads.map((p) => p.lastModified)).toEqual([LM, LM, LM]);
  });

  it("reports notModified with no payloads when every file answers 304", async () => {
    const { fetchImpl, calls } = makeFakeFetch(conditionalRoutes(html));
    const raw = await fetchVendorData({
      vendorUrl: VENDOR_URL,
      fetchImpl,
      ifModifiedSince: { gear: LM, weapons: LM, mods: LM },
    });

    expect(raw.notModified).toBe(true);
    expect(raw.payloads).toEqual([]);
    // The page plus one conditional GET each — no bodies transferred.
    expect(calls.filter((c) => c.url.includes(".json"))).toHaveLength(3);
  });

  it("re-fetches the unchanged files in full when any file changed", async () => {
    // weapons has a newer stamp, so our stored value no longer matches and it returns 200.
    const routes = conditionalRoutes(html, { "weapons.json": "Wed, 15 Jul 2026 09:00:00 GMT" });
    const { fetchImpl, calls } = makeFakeFetch(routes);

    const raw = await fetchVendorData({
      vendorUrl: VENDOR_URL,
      fetchImpl,
      ifModifiedSince: { gear: LM, weapons: LM, mods: LM },
    });

    expect(raw.notModified).toBeUndefined();
    // A complete set, despite gear and mods having answered 304 on the first pass.
    expect(raw.payloads.map((p) => p.type)).toEqual(["gear", "weapons", "mods"]);
    for (const payload of raw.payloads) expect(payload.records).toHaveLength(1);
    // gear and mods were fetched twice: once conditionally, once in full.
    expect(calls.filter((c) => c.url.includes("gear.json"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("weapons.json"))).toHaveLength(1);
  });
});
