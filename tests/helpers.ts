import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PayloadType, RawVendorData } from "../src/source/vendor-source.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..");
export const TESTDATA = join(REPO_ROOT, "testdata");

export function readFixture(name: string): string {
  return readFileSync(join(TESTDATA, name), "utf8");
}

export function readJsonFixture(name: string): unknown[] {
  return JSON.parse(readFixture(name)) as unknown[];
}

/** Build a RawVendorData from the on-disk fixtures (no network). */
export function rawFromFixtures(resetDate = "2026-07-17"): RawVendorData {
  const types: PayloadType[] = ["gear", "weapons", "mods"];
  return {
    sourceUrl: "https://rubenalamina.mx/the-division-weekly-vendor-reset/",
    resetDate,
    fetchedAt: new Date().toISOString(),
    payloads: types.map((type) => ({
      type,
      url: `https://rubenalamina.mx/division/${type}.json`,
      records: readJsonFixture(`${type}.json`),
    })),
  };
}

export interface FakeRoute {
  status?: number;
  contentType?: string;
  body: string;
}

/**
 * Build a fake fetch that matches a request URL against substrings.
 * Honors AbortSignal so timeout paths can be exercised.
 */
export function makeFakeFetch(
  routes: Array<{ match: string; route: FakeRoute }>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const found = routes.find((r) => url.includes(r.match));
    if (!found) throw new Error(`No fake route for ${url}`);
    const { status = 200, contentType = "application/json", body } = found.route;
    return new Response(body, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that never resolves until its AbortSignal fires, then rejects like the platform does. */
export const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}) as typeof fetch;
