import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, getFanoutHealth, initSchema, recordFanoutHealth } from "../../src/db/store.js";
import { runFanout, type FanoutConfig } from "../../src/fanout/run-fanout.js";
import { handleInteraction, resetStockCache } from "../../worker/src/interactions.js";
import { InteractionType, type Interaction } from "../../worker/src/discord.js";
import { makeFakeFetch, readFixture } from "../helpers.js";
import type { FakeRoute } from "../helpers.js";

const NOW = () => new Date("2026-07-17T12:00:00Z");
const USER = "1234567890";

function baseConfig(overrides: Partial<FanoutConfig> = {}): FanoutConfig {
  return {
    vendorUrl: "https://rubenalamina.mx/the-division-weekly-vendor-reset/",
    requestTimeoutMs: 5000,
    botToken: "test-token",
    databaseUrl: ":memory:",
    dryRun: false,
    perUserDelayMs: 0,
    ...overrides,
  };
}

function vendorRoutes(fails = false) {
  return [
    {
      match: "the-division-weekly-vendor-reset",
      route: fails
        ? ({ throws: new TypeError("connect ECONNREFUSED"), body: "" } as FakeRoute)
        : ({ contentType: "text/html", body: readFixture("vendor-page.html") } as FakeRoute),
    },
    { match: "gear.json", route: { body: readFixture("gear.json") } as FakeRoute },
    { match: "weapons.json", route: { body: readFixture("weapons.json") } as FakeRoute },
    { match: "mods.json", route: { body: readFixture("mods.json") } as FakeRoute },
  ];
}

function showCommand(): Interaction {
  return {
    id: "i",
    application_id: "a",
    type: InteractionType.APPLICATION_COMMAND,
    token: "t",
    user: { id: USER },
    data: { name: "wishlist", options: [{ name: "show", type: 1 }] },
  };
}

describe("fan-out health", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
    resetStockCache();
  });

  it("records a heartbeat after a successful run", async () => {
    await addRule(client, USER, { category: "weapon", namedOnly: true });
    const { fetchImpl } = makeFakeFetch(vendorRoutes());
    await runFanout(baseConfig(), { client, fetchImpl, now: NOW, sendDm: () => Promise.resolve() });

    const health = await getFanoutHealth(client);
    expect(health?.ok).toBe(true);
    expect(health?.items).toBeGreaterThan(0);
    expect(health?.subscribers).toBe(1);
  });

  it("does not record a heartbeat for a dry run", async () => {
    // A preview must never make a broken schedule look healthy.
    const { fetchImpl } = makeFakeFetch(vendorRoutes());
    await runFanout(baseConfig({ dryRun: true }), {
      client,
      fetchImpl,
      now: NOW,
      sendDm: () => Promise.resolve(),
    });

    expect(await getFanoutHealth(client)).toBeNull();
  });
});

describe("health shown in /wishlist show", () => {
  let client: Client;
  const db = (): Client => client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
    resetStockCache();
  });

  const contentOf = async (): Promise<string> =>
    (await handleInteraction(showCommand(), db)).data?.content ?? "";

  it("says plainly when nothing has ever run", async () => {
    expect(await contentOf()).toContain("No vendor check has run yet");
  });

  it("confirms a recent successful check", async () => {
    await recordFanoutHealth(client, {
      at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      ok: true,
      items: 144,
      subscribers: 1,
    });
    const content = await contentOf();
    expect(content).toContain("✅ Last checked 2h ago");
    expect(content).toContain("144 items");
  });

  it("warns when the weekly run has plainly been missed", async () => {
    // The whole point: silence from a broken schedule must look different from a quiet week.
    await recordFanoutHealth(client, {
      at: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      ok: true,
      items: 144,
      subscribers: 1,
    });
    expect(await contentOf()).toContain("may have stopped");
  });

  it("surfaces the reason when the last run failed", async () => {
    await recordFanoutHealth(client, {
      at: new Date(Date.now() - 3_600_000).toISOString(),
      ok: false,
      error: "Network error fetching vendor page",
    });
    const content = await contentOf();
    expect(content).toContain("failed");
    expect(content).toContain("Network error fetching vendor page");
  });

  it("still renders the wishlist when health cannot be read", async () => {
    await addRule(client, USER, { category: "gear", label: "All gear" });
    await client.execute("DROP TABLE source_meta");
    // Health is decoration; losing it must not take the command down with it.
    expect(await contentOf()).toContain("All gear");
  });
});
