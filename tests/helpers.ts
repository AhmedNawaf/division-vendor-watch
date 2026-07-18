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
  /** Extra response headers, e.g. `last-modified`. */
  headers?: Record<string, string>;
  /** Throw instead of responding, to exercise transport-failure paths. */
  throws?: Error;
}

/** A route may react to the request (e.g. answer 304 when `if-modified-since` matches). */
export type FakeRouteResolver = FakeRoute | ((init?: RequestInit) => FakeRoute);

export function requestHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/**
 * Build a fake fetch that matches a request URL against substrings.
 * Honors AbortSignal so timeout paths can be exercised.
 */
export function makeFakeFetch(routes: Array<{ match: string; route: FakeRouteResolver }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const found = routes.find((r) => url.includes(r.match));
    if (!found) throw new Error(`No fake route for ${url}`);
    const resolved = typeof found.route === "function" ? found.route(init) : found.route;
    if (resolved.throws) throw resolved.throws;
    const { status = 200, contentType = "application/json", body, headers = {} } = resolved;
    // 304 must carry no body, matching what a real server sends.
    return new Response(status === 304 ? null : body, {
      status,
      headers: { "content-type": contentType, ...headers },
    });
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
