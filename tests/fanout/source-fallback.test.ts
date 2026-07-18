import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, getSourceMeta, initSchema, saveVendorCache } from "../../src/db/store.js";
import { LAST_MODIFIED_KEY, runFanout, type FanoutConfig } from "../../src/fanout/run-fanout.js";
import { parseVendorData } from "../../src/parser/parse-vendor-page.js";
import { makeFakeFetch, rawFromFixtures, readFixture, requestHeader } from "../helpers.js";
import type { FakeRoute } from "../helpers.js";

const NOW = () => new Date("2026-07-17T12:00:00Z");
const RESET_DATE = "2026-07-14";
const LM = "Tue, 14 Jul 2026 08:30:00 GMT";

function baseConfig(overrides: Partial<FanoutConfig> = {}): FanoutConfig {
  return {
    vendorUrl: "https://rubenalamina.mx/the-division-weekly-vendor-reset/",
    requestTimeoutMs: 5000,
    botToken: "test-token",
    databaseUrl: ":memory:",
    dryRun: false,
    perUserDelayMs: 0, // don't pace the test suite
    ...overrides,
  };
}

/** The real fixture payloads, served with Last-Modified and 304 support. */
function sourceRoutes(opts: { fails?: boolean; stamp?: string } = {}) {
  const html = readFixture("vendor-page.html");
  const stamp = opts.stamp ?? LM;
  const jsonRoute =
    (file: string) =>
    (init?: RequestInit): FakeRoute => {
      if (requestHeader(init, "if-modified-since") === stamp) {
        return { status: 304, body: "", headers: { "last-modified": stamp } };
      }
      return { body: readFixture(file), headers: { "last-modified": stamp } };
    };
  return [
    {
      match: "the-division-weekly-vendor-reset",
      route: opts.fails
        ? ({ throws: new TypeError("connect ECONNREFUSED"), body: "" } as FakeRoute)
        : ({ contentType: "text/html", body: html } as FakeRoute),
    },
    { match: "gear.json", route: jsonRoute("gear.json") },
    { match: "weapons.json", route: jsonRoute("weapons.json") },
    { match: "mods.json", route: jsonRoute("mods.json") },
  ];
}

/** Seed the cache with the fixture stock for a given reset week. */
async function seedCache(client: Client, resetWeek: string): Promise<number> {
  const items = parseVendorData(rawFromFixtures()).items;
  await saveVendorCache(client, resetWeek, items);
  return items.length;
}

describe("fan-out source resilience", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
    await addRule(client, "user-a", { category: "weapon", namedOnly: true });
  });

  it("stores Last-Modified after a fresh fetch so the next run can be conditional", async () => {
    const { fetchImpl } = makeFakeFetch(sourceRoutes());
    await runFanout(baseConfig(), { client, fetchImpl, now: NOW, sendDm: () => Promise.resolve() });

    const stored = await getSourceMeta(client, LAST_MODIFIED_KEY);
    expect(JSON.parse(stored!)).toEqual({ gear: LM, weapons: LM, mods: LM });
  });

  it("evaluates cached stock on a 304 so newly added rules still match", async () => {
    // First run: fetch, alert user-a, store stamps + cache.
    const first: string[] = [];
    const { fetchImpl } = makeFakeFetch(sourceRoutes());
    const r1 = await runFanout(baseConfig(), {
      client,
      fetchImpl,
      now: NOW,
      sendDm: (u) => {
        first.push(u);
        return Promise.resolve();
      },
    });
    expect(r1.usersAlerted).toBe(1);
    expect(r1.degraded).toBe(false);

    // A different user subscribes mid-week. The source has not changed, so it answers 304 —
    // but their brand-new rule must still be evaluated against the cached stock.
    await addRule(client, "user-b", { category: "weapon", namedOnly: true });

    const second: string[] = [];
    const { fetchImpl: fetch2, calls } = makeFakeFetch(sourceRoutes());
    const r2 = await runFanout(baseConfig(), {
      client,
      fetchImpl: fetch2,
      now: NOW,
      sendDm: (u) => {
        second.push(u);
        return Promise.resolve();
      },
    });

    expect(second).toEqual(["user-b"]); // user-a already alerted; user-b is new
    expect(r2.totalItems).toBe(r1.totalItems); // served from cache, same stock
    expect(r2.degraded).toBe(false); // a 304 is current data, not degraded
    // Every JSON request was conditional and answered 304 — no bodies transferred.
    expect(calls.filter((c) => c.url.includes(".json"))).toHaveLength(3);
  });

  it("falls back to this week's cache when the source is unreachable, and flags it", async () => {
    const cachedCount = await seedCache(client, RESET_DATE);

    const sent: string[] = [];
    const messages: string[][] = [];
    const { fetchImpl } = makeFakeFetch(sourceRoutes({ fails: true }));
    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl,
      now: NOW,
      sendDm: (u, m) => {
        sent.push(u);
        messages.push(m);
        return Promise.resolve();
      },
    });

    expect(result.totalItems).toBe(cachedCount);
    expect(result.degraded).toBe(true);
    expect(sent).toEqual(["user-a"]);
    expect(messages[0]!.join("\n")).toContain("using this week's cached stock");
  });

  it("refuses to alert from a previous week's cache", async () => {
    // Only last week's stock is cached. Alerting from it would point users at items that
    // are no longer for sale, so the run must fail instead.
    await seedCache(client, "2026-07-07");

    const sent: string[] = [];
    const { fetchImpl } = makeFakeFetch(sourceRoutes({ fails: true }));

    await expect(
      runFanout(baseConfig(), {
        client,
        fetchImpl,
        now: NOW,
        sendDm: (u) => {
          sent.push(u);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/Network error|ECONNREFUSED/);

    expect(sent).toEqual([]);
  });

  it("re-fetches in full when the source says 304 but nothing is cached for this week", async () => {
    // Stamps present without a matching cache entry (e.g. the cache was cleared).
    const { fetchImpl } = makeFakeFetch(sourceRoutes());
    await runFanout(baseConfig(), { client, fetchImpl, now: NOW, sendDm: () => Promise.resolve() });
    await client.execute("DELETE FROM vendor_cache");

    const { fetchImpl: fetch2 } = makeFakeFetch(sourceRoutes());
    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl: fetch2,
      now: NOW,
      sendDm: () => Promise.resolve(),
    });

    expect(result.totalItems).toBeGreaterThan(0);
    expect(result.degraded).toBe(false);
  });

  it("dry-run writes neither the cache nor the Last-Modified stamps", async () => {
    const { fetchImpl } = makeFakeFetch(sourceRoutes());
    await runFanout(baseConfig({ dryRun: true }), {
      client,
      fetchImpl,
      now: NOW,
      sendDm: () => Promise.resolve(),
    });

    expect(await getSourceMeta(client, LAST_MODIFIED_KEY)).toBeNull();
    const cached = await client.execute("SELECT COUNT(*) AS n FROM vendor_cache");
    expect(Number(cached.rows[0]!.n)).toBe(0);
  });
});
