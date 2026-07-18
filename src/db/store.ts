import type { Client, Row } from "@libsql/client";
import type { WatchRule, Watchlist } from "../config/load-watchlist.js";
import type { VendorItem } from "../types/vendor.js";
import { SCHEMA_SQL } from "./schema.js";

/**
 * Data-access layer over libSQL/Turso. Every function takes a `Client` so the same queries
 * run under the Node client (CLI / GitHub Actions fan-out) and the web client (Cloudflare
 * Worker) — the dependency on `@libsql/client` here is type-only, so nothing is bundled.
 */

export interface StoredRule extends WatchRule {
  id: number;
}

export interface VendorCacheEntry {
  resetWeek: string;
  fetchedAt: string;
  items: VendorItem[];
}

/** Apply the schema (idempotent). Handy for tests and local setup. */
export async function initSchema(client: Client): Promise<void> {
  await client.executeMultiple(SCHEMA_SQL);
}

/** Ensure a users row exists; refresh updated_at if it already does. */
export async function upsertUser(client: Client, userId: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO users (id) VALUES (?)
          ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
    args: [userId],
  });
}

/** Insert one rule for a user, returning the new rule id. */
export async function addRule(client: Client, userId: string, rule: WatchRule): Promise<number> {
  await upsertUser(client, userId);
  const result = await client.execute({
    sql: `INSERT INTO rules
            (user_id, item_name, brand, gear_set, category, required_attributes,
             talent, named_only, minimum_roll_percentage, label)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      userId,
      rule.itemName ?? null,
      rule.brand ?? null,
      rule.gearSet ?? null,
      rule.category ?? null,
      rule.requiredAttributes ? JSON.stringify(rule.requiredAttributes) : null,
      rule.talent ?? null,
      rule.namedOnly == null ? null : rule.namedOnly ? 1 : 0,
      rule.minimumRollPercentage ?? null,
      rule.label ?? null,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function listRules(client: Client, userId: string): Promise<StoredRule[]> {
  const result = await client.execute({
    sql: `SELECT * FROM rules WHERE user_id = ? ORDER BY id`,
    args: [userId],
  });
  return result.rows.map(rowToRule);
}

/** Delete a rule, scoped to its owner so users can't remove each other's rules. */
export async function removeRule(client: Client, userId: string, ruleId: number): Promise<boolean> {
  const result = await client.execute({
    sql: `DELETE FROM rules WHERE id = ? AND user_id = ?`,
    args: [ruleId, userId],
  });
  return result.rowsAffected > 0;
}

/** Assemble a user's rules into a Watchlist for the matcher, or null if they have none. */
export async function getWatchlist(client: Client, userId: string): Promise<Watchlist | null> {
  const rules = await listRules(client, userId);
  if (rules.length === 0) return null;
  const bare = rules.map(({ id: _id, ...rule }) => rule);
  return { rules: bare as Watchlist["rules"] };
}

/** User ids that have at least one rule — the fan-out audience. */
export async function listSubscriberIds(client: Client): Promise<string[]> {
  const result = await client.execute(`SELECT DISTINCT user_id FROM rules ORDER BY user_id`);
  return result.rows.map((row) => String(row.user_id));
}

/** Load a user's already-alerted fingerprints for a reset week, for the dedup predicate. */
export async function loadAlertedSet(
  client: Client,
  userId: string,
  resetWeek: string,
): Promise<Set<string>> {
  const result = await client.execute({
    sql: `SELECT fingerprint FROM alert_history WHERE user_id = ? AND reset_week = ?`,
    args: [userId, resetWeek],
  });
  return new Set(result.rows.map((row) => String(row.fingerprint)));
}

/** Record delivered fingerprints. Idempotent via the (user_id, fingerprint) primary key. */
export async function recordAlerts(
  client: Client,
  userId: string,
  resetWeek: string,
  fingerprints: string[],
  sentAt: string = new Date().toISOString(),
): Promise<void> {
  if (fingerprints.length === 0) return;
  await client.batch(
    fingerprints.map((fingerprint) => ({
      sql: `INSERT OR IGNORE INTO alert_history (user_id, reset_week, fingerprint, sent_at)
            VALUES (?, ?, ?, ?)`,
      args: [userId, resetWeek, fingerprint, sentAt],
    })),
    "write",
  );
}

/** Upsert the parsed vendor stock for a reset week (fetched once, shared by all users). */
export async function saveVendorCache(
  client: Client,
  resetWeek: string,
  items: VendorItem[],
  fetchedAt: string = new Date().toISOString(),
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO vendor_cache (reset_week, fetched_at, items_json) VALUES (?, ?, ?)
          ON CONFLICT(reset_week) DO UPDATE SET
            fetched_at = excluded.fetched_at,
            items_json = excluded.items_json`,
    args: [resetWeek, fetchedAt, JSON.stringify(items)],
  });
}

/** Most recent cached vendor stock (for `/preview` and menu option generation). */
export async function getLatestVendorCache(client: Client): Promise<VendorCacheEntry | null> {
  const result = await client.execute(
    `SELECT reset_week, fetched_at, items_json FROM vendor_cache ORDER BY reset_week DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    resetWeek: String(row.reset_week),
    fetchedAt: String(row.fetched_at),
    items: JSON.parse(String(row.items_json)) as VendorItem[],
  };
}

function rowToRule(row: Row): StoredRule {
  const rule: StoredRule = { id: Number(row.id) };
  if (row.item_name != null) rule.itemName = String(row.item_name);
  if (row.brand != null) rule.brand = String(row.brand);
  if (row.gear_set != null) rule.gearSet = String(row.gear_set);
  if (row.category != null) rule.category = String(row.category) as WatchRule["category"];
  if (row.required_attributes != null) {
    const parsed = JSON.parse(String(row.required_attributes)) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      rule.requiredAttributes = parsed as [string, ...string[]];
    }
  }
  if (row.talent != null) rule.talent = String(row.talent);
  if (row.named_only != null) rule.namedOnly = Number(row.named_only) === 1;
  if (row.minimum_roll_percentage != null) {
    rule.minimumRollPercentage = Number(row.minimum_roll_percentage);
  }
  if (row.label != null) rule.label = String(row.label);
  return rule;
}
