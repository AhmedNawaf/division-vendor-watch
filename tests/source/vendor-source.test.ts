import { describe, expect, it } from "vitest";
import {
  discoverPayloadUrls,
  fetchVendorData,
} from "../../src/source/vendor-source.js";
import { VendorSourceError } from "../../src/errors.js";
import { makeFakeFetch, hangingFetch, readFixture } from "../helpers.js";

const VENDOR_URL = "https://rubenalamina.mx/the-division-weekly-vendor-reset/";

const gearJson = JSON.stringify([{ type: "gear", vendor: "V", name: "N" }]);
const weaponsJson = JSON.stringify([{ type: "weapon", vendor: "V", name: "N" }]);
const modsJson = JSON.stringify([{ type: "mod", vendor: "V", name: "N" }]);

function successRoutes(html: string) {
  return [
    { match: "the-division-weekly-vendor-reset", route: { contentType: "text/html", body: html } },
    { match: "gear.json", route: { body: gearJson } },
    { match: "weapons.json", route: { body: weaponsJson } },
    { match: "mods.json", route: { body: modsJson } },
  ];
}

describe("discoverPayloadUrls", () => {
  it("extracts the three JSON URLs and the reset date from the loader script", () => {
    const html = readFixture("vendor-page.html");
    const { urls, resetDate } = discoverPayloadUrls(html, VENDOR_URL);
    expect(urls.gear).toContain("/division/gear.json");
    expect(urls.weapons).toContain("/division/weapons.json");
    expect(urls.mods).toContain("/division/mods.json");
    expect(resetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("throws when the loader script is missing", () => {
    expect(() => discoverPayloadUrls("<html><body>no loader here</body></html>", VENDOR_URL)).toThrow(
      VendorSourceError,
    );
  });
});

describe("fetchVendorData", () => {
  const html = readFixture("vendor-page.html");

  it("fetches HTML then all three JSON payloads on success", async () => {
    const { fetchImpl, calls } = makeFakeFetch(successRoutes(html));
    const raw = await fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl });
    expect(raw.payloads.map((p) => p.type)).toEqual(["gear", "weapons", "mods"]);
    expect(raw.resetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls).toHaveLength(4);
  });

  it("throws VendorSourceError on an HTTP error status", async () => {
    const { fetchImpl } = makeFakeFetch([
      {
        match: "the-division-weekly-vendor-reset",
        route: { status: 503, contentType: "text/html", body: "server error page padding".repeat(40) },
      },
    ]);
    await expect(fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl })).rejects.toThrowError(
      /HTTP 503/,
    );
  });

  it("throws VendorSourceError on a timeout", async () => {
    await expect(
      fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl: hangingFetch, timeoutMs: 20 }),
    ).rejects.toThrowError(/Timed out/);
  });

  it("throws VendorSourceError on the wrong content type for the page", async () => {
    const { fetchImpl } = makeFakeFetch([
      {
        match: "the-division-weekly-vendor-reset",
        route: { contentType: "application/json", body: "{}".repeat(400) },
      },
    ]);
    await expect(fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl })).rejects.toThrowError(
      /content-type/,
    );
  });

  it("throws VendorSourceError on a suspiciously small page", async () => {
    const { fetchImpl } = makeFakeFetch([
      { match: "the-division-weekly-vendor-reset", route: { contentType: "text/html", body: "<html></html>" } },
    ]);
    await expect(fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl })).rejects.toThrowError(
      /Suspiciously small/,
    );
  });

  it("throws VendorSourceError when a JSON payload is the wrong content type", async () => {
    const routes = successRoutes(html);
    routes[1]!.route = { contentType: "text/html", body: gearJson };
    const { fetchImpl } = makeFakeFetch(routes);
    await expect(fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl })).rejects.toThrowError(
      /content-type/,
    );
  });

  it("throws VendorSourceError when a JSON payload is not an array", async () => {
    const routes = successRoutes(html);
    routes[1]!.route = { body: '{"not":"an array"}' };
    const { fetchImpl } = makeFakeFetch(routes);
    await expect(fetchVendorData({ vendorUrl: VENDOR_URL, fetchImpl })).rejects.toThrowError(
      /JSON array/,
    );
  });
});
