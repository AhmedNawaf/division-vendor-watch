import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVendorWatch, type RuntimeConfig } from "../../src/run.js";
import { readFixture } from "../helpers.js";

const VENDOR_URL = "https://rubenalamina.mx/the-division-weekly-vendor-reset/";
const WEBHOOK = "https://discord.com/api/webhooks/123/abc";

/** Fake fetch serving the real HTML page + JSON fixtures, and capturing Discord posts. */
function pipelineFetch() {
  const html = readFixture("vendor-page.html");
  const gear = readFixture("gear.json");
  const weapons = readFixture("weapons.json");
  const mods = readFixture("mods.json");
  const posts: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api/webhooks")) {
      posts.push(JSON.parse(String(init?.body)).content);
      return new Response(null, { status: 204 });
    }
    if (url.includes("gear.json")) return json(gear);
    if (url.includes("weapons.json")) return json(weapons);
    if (url.includes("mods.json")) return json(mods);
    if (url.includes("the-division-weekly-vendor-reset")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  return { fetchImpl, posts };
}

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

async function baseConfig(overrides: Partial<RuntimeConfig> = {}): Promise<RuntimeConfig> {
  const dir = await mkdtemp(join(tmpdir(), "dvw-int-"));
  await writeFile(
    join(dir, "watchlist.json"),
    JSON.stringify({ rules: [{ category: "weapon", namedOnly: true }, { gearSet: "Tip of the Spear" }] }),
    "utf8",
  );
  return {
    vendorUrl: VENDOR_URL,
    watchlistPath: join(dir, "watchlist.json"),
    alertHistoryPath: join(dir, "history.json"),
    requestTimeoutMs: 5000,
    dryRun: false,
    webhookUrl: WEBHOOK,
    ...overrides,
  };
}

describe("full pipeline: saved HTML -> parser -> matcher -> formatter -> mocked webhook", () => {
  it("delivers alerts and records fingerprints", async () => {
    const { fetchImpl, posts } = pipelineFetch();
    const config = await baseConfig();

    const result = await runVendorWatch(config, { fetchImpl, sleep: () => Promise.resolve() });

    expect(result.totalItems).toBeGreaterThan(100);
    expect(result.newMatches).toBeGreaterThan(0);
    expect(result.messagesSent).toBe(posts.length);
    expect(posts.join("\n")).toContain("Weekly Vendor Watch");

    const history = JSON.parse(await readFile(config.alertHistoryPath, "utf8"));
    expect(Object.keys(history.sent).length).toBe(result.newMatches);
  });

  it("sends nothing on a second run (duplicate prevention)", async () => {
    const config = await baseConfig();

    const first = pipelineFetch();
    await runVendorWatch(config, { fetchImpl: first.fetchImpl, sleep: () => Promise.resolve() });

    const second = pipelineFetch();
    const result = await runVendorWatch(config, {
      fetchImpl: second.fetchImpl,
      sleep: () => Promise.resolve(),
    });

    expect(result.newMatches).toBe(0);
    expect(second.posts).toHaveLength(0);
  });

  it("does not record fingerprints when Discord delivery fails", async () => {
    const html = readFixture("vendor-page.html");
    const config = await baseConfig();

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api/webhooks")) return new Response("bad", { status: 400 });
      if (url.includes("gear.json")) return json(readFixture("gear.json"));
      if (url.includes("weapons.json")) return json(readFixture("weapons.json"));
      if (url.includes("mods.json")) return json(readFixture("mods.json"));
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    await expect(
      runVendorWatch(config, { fetchImpl, sleep: () => Promise.resolve() }),
    ).rejects.toThrow();

    // History file must not exist / contain fingerprints after a failed delivery.
    const historyExists = await readFile(config.alertHistoryPath, "utf8").then(
      () => true,
      () => false,
    );
    expect(historyExists).toBe(false);
  });

  it("dry-run prints without sending or writing history", async () => {
    const { fetchImpl, posts } = pipelineFetch();
    const config = await baseConfig({ dryRun: true });

    const result = await runVendorWatch(config, { fetchImpl, sleep: () => Promise.resolve() });

    expect(result.newMatches).toBeGreaterThan(0);
    expect(result.messagesSent).toBe(0);
    expect(posts).toHaveLength(0);
    const historyExists = await readFile(config.alertHistoryPath, "utf8").then(
      () => true,
      () => false,
    );
    expect(historyExists).toBe(false);
  });
});
