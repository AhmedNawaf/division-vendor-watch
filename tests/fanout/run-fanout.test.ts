import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, initSchema, loadAlertedSet } from "../../src/db/store.js";
import { runFanout, type FanoutConfig } from "../../src/fanout/run-fanout.js";
import { readFixture } from "../helpers.js";

const RESET_DATE = "2026-07-14"; // canonical reset for the injected clock below
const NOW = () => new Date("2026-07-17T12:00:00Z");

/** Fetch serving the real vendor page + JSON fixtures (no Discord — delivery is injected). */
function vendorFetch(): typeof fetch {
  const html = readFixture("vendor-page.html");
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("gear.json")) return json(readFixture("gear.json"));
    if (url.includes("weapons.json")) return json(readFixture("weapons.json"));
    if (url.includes("mods.json")) return json(readFixture("mods.json"));
    if (url.includes("the-division-weekly-vendor-reset")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

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

describe("runFanout", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
  });

  it("DMs only subscribers with matching new items and records their fingerprints", async () => {
    await addRule(client, "match-user", { category: "weapon", namedOnly: true });
    await addRule(client, "no-match-user", { itemName: "definitely-not-in-stock-zzz" });

    const sent: Array<{ userId: string; count: number }> = [];
    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl: vendorFetch(),
      now: NOW,
      sendDm: (userId, messages) => {
        sent.push({ userId, count: messages.length });
        return Promise.resolve();
      },
    });

    expect(result.subscribers).toBe(2);
    expect(result.usersAlerted).toBe(1);
    expect(result.usersFailed).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.userId).toBe("match-user");

    // The matched user's fingerprints were recorded; the non-matching user's were not.
    expect((await loadAlertedSet(client, "match-user", RESET_DATE)).size).toBeGreaterThan(0);
    expect((await loadAlertedSet(client, "no-match-user", RESET_DATE)).size).toBe(0);
  });

  it("sends nothing on a second run (per-user duplicate prevention)", async () => {
    await addRule(client, "match-user", { category: "weapon", namedOnly: true });

    const deps = (sent: string[]) => ({
      client,
      fetchImpl: vendorFetch(),
      now: NOW,
      sendDm: (userId: string) => {
        sent.push(userId);
        return Promise.resolve();
      },
    });

    const first: string[] = [];
    const r1 = await runFanout(baseConfig(), deps(first));
    expect(r1.usersAlerted).toBe(1);
    expect(first).toEqual(["match-user"]);

    const second: string[] = [];
    const r2 = await runFanout(baseConfig(), deps(second));
    expect(r2.usersAlerted).toBe(0);
    expect(second).toEqual([]);
  });

  it("isolates a failed delivery: others still get DMs and the failed user is not recorded", async () => {
    await addRule(client, "user-ok", { category: "weapon", namedOnly: true });
    await addRule(client, "user-fail", { category: "weapon", namedOnly: true });

    const delivered: string[] = [];
    const result = await runFanout(baseConfig(), {
      client,
      fetchImpl: vendorFetch(),
      now: NOW,
      sendDm: (userId, messages) => {
        if (userId === "user-fail") return Promise.reject(new Error("DMs closed"));
        delivered.push(userId);
        return Promise.resolve(messages.length ? "" : "").then(() => undefined);
      },
    });

    expect(result.usersAlerted).toBe(1);
    expect(result.usersFailed).toBe(1);
    expect(delivered).toEqual(["user-ok"]);
    // The failed user keeps no history, so they retry next run.
    expect((await loadAlertedSet(client, "user-fail", RESET_DATE)).size).toBe(0);
    expect((await loadAlertedSet(client, "user-ok", RESET_DATE)).size).toBeGreaterThan(0);
  });

  it("dry-run evaluates but sends nothing and records nothing", async () => {
    await addRule(client, "match-user", { category: "weapon", namedOnly: true });

    const sent: string[] = [];
    const result = await runFanout(baseConfig({ dryRun: true }), {
      client,
      fetchImpl: vendorFetch(),
      now: NOW,
      sendDm: (userId) => {
        sent.push(userId);
        return Promise.resolve();
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.usersAlerted).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await loadAlertedSet(client, "match-user", RESET_DATE)).size).toBe(0);
  });
});
