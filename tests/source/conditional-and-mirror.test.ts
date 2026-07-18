import { describe, expect, it } from "vitest";
import { fetchVendorData } from "../../src/source/vendor-source.js";
import { VendorSourceError } from "../../src/errors.js";
import { makeFakeFetch, readFixture, requestHeader, type FakeRoute } from "../helpers.js";

const VENDOR_URL = "https://rubenalamina.mx/the-division-weekly-vendor-reset/";
const LM = "Tue, 14 Jul 2026 08:30:00 GMT";
const RESET_INSTANT = new Date("2026-07-14T08:30:00Z");

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

    expect(raw.origin).toBe("primary");
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

describe("mirror fallback", () => {
  const html = readFixture("vendor-page.html");
  const MIRROR_BASE = "https://mirror.test/vendors";
  const COMMITS_API = "https://api.test/commits";
  const mirror = { baseUrl: MIRROR_BASE, commitsApi: COMMITS_API };

  function mirrorRoutes(opts: {
    primaryFails?: boolean;
    freshness: Record<string, string | null>;
  }) {
    const routes: Array<{ match: string; route: FakeRoute | ((init?: RequestInit) => FakeRoute) }> =
      [];
    routes.push({
      match: "the-division-weekly-vendor-reset",
      route: opts.primaryFails
        ? { throws: new TypeError("connect ECONNREFUSED"), body: "" }
        : { contentType: "text/html", body: html },
    });
    for (const file of ["gear", "weapons", "mods"]) {
      // Commit API lookups are matched before the raw file URLs by ordering.
      routes.push({
        match: `${COMMITS_API}?path=${encodeURIComponent(`public/vendors/${file}.json`)}`,
        route: () => {
          const date = opts.freshness[file];
          if (date === null || date === undefined) return { status: 404, body: "[]" };
          return { body: JSON.stringify([{ commit: { committer: { date } } }]) };
        },
      });
    }
    for (const file of ["gear", "weapons", "mods"]) {
      routes.push({
        match: `${MIRROR_BASE}/${file}.json`,
        // GitHub raw serves JSON as text/plain — the mirror path must tolerate that.
        route: { contentType: "text/plain; charset=utf-8", body: BODIES[`${file}.json`]! },
      });
    }
    return routes;
  }

  it("serves only mirror payloads newer than the current reset", async () => {
    const { fetchImpl } = makeFakeFetch(
      mirrorRoutes({
        primaryFails: true,
        freshness: {
          gear: "2026-07-14T09:00:00Z", // after the reset → trusted
          weapons: "2026-07-14T09:00:00Z",
          mods: "2021-02-23T17:49:01Z", // the real mirror's dead mods.json
        },
      }),
    );

    const raw = await fetchVendorData({
      vendorUrl: VENDOR_URL,
      fetchImpl,
      mirror,
      mirrorFresherThan: RESET_INSTANT,
    });

    expect(raw.origin).toBe("mirror");
    expect(raw.payloads.map((p) => p.type)).toEqual(["gear", "weapons"]);
    expect(raw.missing).toEqual(["mods"]);
    // Mirror stamps must never seed conditional requests against the primary source.
    for (const payload of raw.payloads) expect(payload.lastModified).toBeUndefined();
  });

  it("drops a payload whose freshness cannot be established", async () => {
    const { fetchImpl } = makeFakeFetch(
      mirrorRoutes({
        primaryFails: true,
        freshness: { gear: "2026-07-14T09:00:00Z", weapons: "2026-07-14T09:00:00Z", mods: null },
      }),
    );

    const raw = await fetchVendorData({
      vendorUrl: VENDOR_URL,
      fetchImpl,
      mirror,
      mirrorFresherThan: RESET_INSTANT,
    });

    expect(raw.missing).toEqual(["mods"]);
  });

  it("throws rather than serving stock when nothing on the mirror is fresh enough", async () => {
    const { fetchImpl } = makeFakeFetch(
      mirrorRoutes({
        primaryFails: true,
        freshness: {
          gear: "2026-07-07T09:00:00Z", // last week
          weapons: "2026-07-07T09:00:00Z",
          mods: "2021-02-23T17:49:01Z",
        },
      }),
    );

    await expect(
      fetchVendorData({
        vendorUrl: VENDOR_URL,
        fetchImpl,
        mirror,
        mirrorFresherThan: RESET_INSTANT,
      }),
    ).rejects.toThrow(/no mirror payload was fresh enough/);
  });

  it("does not fall back when the primary source changed shape", async () => {
    // A page that loads fine but no longer contains the loader calls: the mirror carries a copy
    // of the same upstream data, so falling back here would bury the breakage.
    const { fetchImpl, calls } = makeFakeFetch([
      {
        match: "the-division-weekly-vendor-reset",
        route: { contentType: "text/html", body: "<html><body>" + "x".repeat(600) + "</body></html>" },
      },
    ]);

    await expect(
      fetchVendorData({
        vendorUrl: VENDOR_URL,
        fetchImpl,
        mirror,
        mirrorFresherThan: RESET_INSTANT,
      }),
    ).rejects.toThrow(VendorSourceError);

    expect(calls.some((c) => c.url.includes(MIRROR_BASE))).toBe(false);
  });

  it("is not used at all unless a freshness bound is supplied", async () => {
    const { fetchImpl, calls } = makeFakeFetch(
      mirrorRoutes({ primaryFails: true, freshness: { gear: "2026-07-14T09:00:00Z" } }),
    );

    await expect(fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl, mirror })).rejects.toThrow(
      VendorSourceError,
    );
    expect(calls.some((c) => c.url.includes(MIRROR_BASE))).toBe(false);
  });
});
