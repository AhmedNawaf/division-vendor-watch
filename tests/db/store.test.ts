import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import type { WatchRule } from "../../src/config/load-watchlist.js";
import {
  addRule,
  getLatestVendorCache,
  getWatchlist,
  initSchema,
  listRules,
  listSubscriberIds,
  loadAlertedSet,
  recordAlerts,
  removeRule,
  saveVendorCache,
} from "../../src/db/store.js";
import type { VendorItem } from "../../src/types/vendor.js";

function vendorItem(overrides: Partial<VendorItem> = {}): VendorItem {
  return {
    vendor: "The Castle",
    name: "The White Death",
    category: "weapon",
    attributes: [],
    isNamed: true,
    rawText: "{}",
    ...overrides,
  };
}

describe("store", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
  });

  it("round-trips rules and assembles a watchlist", async () => {
    const rule: WatchRule = {
      category: "weapon",
      namedOnly: true,
      requiredAttributes: ["Critical Hit Chance"],
      minimumRollPercentage: 90,
      label: "Named rifles",
    };
    const id = await addRule(client, "user-1", rule);
    expect(id).toBeGreaterThan(0);

    const rules = await listRules(client, "user-1");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id, ...rule });

    const watchlist = await getWatchlist(client, "user-1");
    expect(watchlist).not.toBeNull();
    expect(watchlist!.rules).toEqual([rule]);
  });

  it("returns null watchlist for a user with no rules", async () => {
    expect(await getWatchlist(client, "ghost")).toBeNull();
  });

  it("scopes rule removal to the owner", async () => {
    const mine = await addRule(client, "user-1", { category: "gear" });
    await addRule(client, "user-2", { category: "weapon" });

    expect(await removeRule(client, "user-2", mine)).toBe(false);
    expect(await listRules(client, "user-1")).toHaveLength(1);

    expect(await removeRule(client, "user-1", mine)).toBe(true);
    expect(await listRules(client, "user-1")).toHaveLength(0);
  });

  it("lists distinct subscriber ids", async () => {
    await addRule(client, "user-b", { category: "weapon" });
    await addRule(client, "user-a", { category: "gear" });
    await addRule(client, "user-a", { category: "skill-mod" });

    expect(await listSubscriberIds(client)).toEqual(["user-a", "user-b"]);
  });

  it("records and loads alerted fingerprints per reset week, idempotently", async () => {
    const week = "2026-07-21";
    expect(await loadAlertedSet(client, "user-1", week)).toEqual(new Set());

    await recordAlerts(client, "user-1", week, ["fp-a", "fp-b"]);
    await recordAlerts(client, "user-1", week, ["fp-a"]); // duplicate ignored

    const alerted = await loadAlertedSet(client, "user-1", week);
    expect(alerted).toEqual(new Set(["fp-a", "fp-b"]));

    // Another user's history is isolated.
    expect(await loadAlertedSet(client, "user-2", week)).toEqual(new Set());
  });

  it("no-ops recordAlerts with an empty fingerprint list", async () => {
    await recordAlerts(client, "user-1", "2026-07-21", []);
    expect(await loadAlertedSet(client, "user-1", "2026-07-21")).toEqual(new Set());
  });

  it("upserts vendor cache and returns the latest reset week", async () => {
    await saveVendorCache(client, "2026-07-14", [vendorItem({ name: "Old Stock" })]);
    await saveVendorCache(client, "2026-07-21", [vendorItem({ name: "New Stock" })]);

    const latest = await getLatestVendorCache(client);
    expect(latest).not.toBeNull();
    expect(latest!.resetWeek).toBe("2026-07-21");
    expect(latest!.items).toHaveLength(1);
    expect(latest!.items[0]!.name).toBe("New Stock");
  });

  it("overwrites the cache for the same reset week", async () => {
    await saveVendorCache(client, "2026-07-21", [vendorItem({ name: "First" })]);
    await saveVendorCache(client, "2026-07-21", [
      vendorItem({ name: "Second" }),
      vendorItem({ name: "Third" }),
    ]);

    const latest = await getLatestVendorCache(client);
    expect(latest!.items.map((i) => i.name)).toEqual(["Second", "Third"]);
  });

  it("returns null when no vendor cache exists", async () => {
    expect(await getLatestVendorCache(client)).toBeNull();
  });
});
