import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, getDeliveryState, initSchema } from "../../src/db/store.js";
import { runFanout, type FanoutConfig } from "../../src/fanout/run-fanout.js";
import { DiscordUndeliverableError } from "../../src/discord/send-dm.js";
import { makeFakeFetch, readFixture } from "../helpers.js";
import type { FakeRoute } from "../helpers.js";

const NOW = () => new Date("2026-07-17T12:00:00Z");

function baseConfig(overrides: Partial<FanoutConfig> = {}): FanoutConfig {
  return {
    vendorUrl: "https://rubenalamina.mx/the-division-weekly-vendor-reset/",
    requestTimeoutMs: 5000,
    botToken: "test-token",
    databaseUrl: ":memory:",
    dryRun: false,
    useMirror: false,
    perUserDelayMs: 0,
    ...overrides,
  };
}

function vendorRoutes() {
  const html = readFixture("vendor-page.html");
  return [
    {
      match: "the-division-weekly-vendor-reset",
      route: { contentType: "text/html", body: html } as FakeRoute,
    },
    { match: "gear.json", route: { body: readFixture("gear.json") } as FakeRoute },
    { match: "weapons.json", route: { body: readFixture("weapons.json") } as FakeRoute },
    { match: "mods.json", route: { body: readFixture("mods.json") } as FakeRoute },
  ];
}

describe("fan-out delivery state", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
    await addRule(client, "user-a", { category: "weapon", namedOnly: true });
  });

  it("caches the DM channel id so later runs open no channels at all", async () => {
    const seen: Array<string | undefined> = [];
    const deps = () => ({
      client,
      fetchImpl: makeFakeFetch(vendorRoutes()).fetchImpl,
      now: NOW,
      sendDm: (_u: string, _m: string[], cached?: string) => {
        seen.push(cached);
        return Promise.resolve({ channelId: "chan-1", openedChannel: cached === undefined });
      },
    });

    const first = await runFanout(baseConfig(), deps());
    expect(first.channelsOpened).toBe(1);
    expect(seen[0]).toBeUndefined();
    expect((await getDeliveryState(client, "user-a"))?.dmChannelId).toBe("chan-1");

    // A new week's worth of matches for the same user: the cached channel must be reused.
    await client.execute("DELETE FROM alert_history");
    const second = await runFanout(baseConfig(), deps());

    expect(seen[1]).toBe("chan-1");
    expect(second.channelsOpened).toBe(0); // steady state: zero Create DM calls
  });

  it("marks a permanently refused user undeliverable instead of counting a failure", async () => {
    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl: makeFakeFetch(vendorRoutes()).fetchImpl,
      now: NOW,
      sendDm: () =>
        Promise.reject(
          new DiscordUndeliverableError("Discord will not deliver to this user (HTTP 403)", {
            discordCode: 50007,
          }),
        ),
    });

    expect(result.usersFailed).toBe(1);
    const state = await getDeliveryState(client, "user-a");
    expect(state?.undeliverableReason).toMatch(/will not deliver/);
    expect(state?.failureCount).toBe(1);
  });

  it("skips an undeliverable user on subsequent runs rather than re-earning a 403", async () => {
    // First run: permanently refused.
    await runFanout(baseConfig(), {
      client,
      fetchImpl: makeFakeFetch(vendorRoutes()).fetchImpl,
      now: NOW,
      sendDm: () => Promise.reject(new DiscordUndeliverableError("blocked", {})),
    });

    // Second run: they must not be attempted at all.
    let attempts = 0;
    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl: makeFakeFetch(vendorRoutes()).fetchImpl,
      now: NOW,
      sendDm: () => {
        attempts += 1;
        return Promise.resolve();
      },
    });

    expect(attempts).toBe(0);
    expect(result.usersSkipped).toBe(1);
    expect(result.usersFailed).toBe(0);
  });

  it("keeps retrying a transient failure and clears the count after success", async () => {
    await runFanout(baseConfig(), {
      client,
      fetchImpl: makeFakeFetch(vendorRoutes()).fetchImpl,
      now: NOW,
      sendDm: () => Promise.reject(new Error("socket hang up")),
    });

    const afterFailure = await getDeliveryState(client, "user-a");
    expect(afterFailure?.failureCount).toBe(1);
    expect(afterFailure?.undeliverableReason).toBeUndefined(); // transient, so still attempted

    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl: makeFakeFetch(vendorRoutes()).fetchImpl,
      now: NOW,
      sendDm: () => Promise.resolve({ channelId: "chan-1", openedChannel: true }),
    });

    expect(result.usersAlerted).toBe(1);
    expect((await getDeliveryState(client, "user-a"))?.failureCount).toBe(0);
  });
});
