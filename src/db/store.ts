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

/**
 * Apply a wishlist edit in one batch: drop the listed rule ids and insert the given rules.
 *
 * The modal forms replace a whole scope at once (all gear rules, or all weapon rules), so this
 * has to be atomic — a partial apply would leave the form showing something different from what
 * is stored, and the next submit would compound the drift. Deletes are owner-scoped so one user
 * can never remove another's rules.
 */
export async function replaceRules(
  client: Client,
  userId: string,
  removeIds: readonly number[],
  add: readonly WatchRule[],
): Promise<void> {
  if (removeIds.length === 0 && add.length === 0) return;
  await upsertUser(client, userId);

  const statements = [
    ...removeIds.map((id) => ({
      sql: `DELETE FROM rules WHERE id = ? AND user_id = ?`,
      args: [id, userId] as (number | string)[],
    })),
    ...add.map((rule) => ({
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
      ] as (string | number | null)[],
    })),
  ];

  await client.batch(statements, "write");
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

/** Cached vendor stock for one specific reset week, or null if we have none for it. */
export async function getVendorCache(
  client: Client,
  resetWeek: string,
): Promise<VendorCacheEntry | null> {
  const result = await client.execute({
    sql: `SELECT reset_week, fetched_at, items_json FROM vendor_cache WHERE reset_week = ?`,
    args: [resetWeek],
  });
  return rowToCacheEntry(result.rows[0]);
}

/** Most recent cached vendor stock (for `/preview` and menu option generation). */
export async function getLatestVendorCache(client: Client): Promise<VendorCacheEntry | null> {
  const result = await client.execute(
    `SELECT reset_week, fetched_at, items_json FROM vendor_cache ORDER BY reset_week DESC LIMIT 1`,
  );
  return rowToCacheEntry(result.rows[0]);
}

function rowToCacheEntry(row: Row | undefined): VendorCacheEntry | null {
  if (!row) return null;
  return {
    resetWeek: String(row.reset_week),
    fetchedAt: String(row.fetched_at),
    items: JSON.parse(String(row.items_json)) as VendorItem[],
  };
}

export interface DeliveryState {
  userId: string;
  /** Cached DM channel id — reused forever so we stop calling Create DM. */
  dmChannelId?: string;
  /** Set when the user permanently cannot be DMed (blocked us, DMs closed). */
  undeliverableReason?: string;
  failureCount: number;
  lastFailureAt?: string;
}

export async function getDeliveryState(
  client: Client,
  userId: string,
): Promise<DeliveryState | null> {
  const result = await client.execute({
    sql: `SELECT user_id, dm_channel_id, undeliverable_reason, failure_count, last_failure_at
          FROM delivery_state WHERE user_id = ?`,
    args: [userId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    dmChannelId: row.dm_channel_id == null ? undefined : String(row.dm_channel_id),
    undeliverableReason:
      row.undeliverable_reason == null ? undefined : String(row.undeliverable_reason),
    failureCount: Number(row.failure_count ?? 0),
    lastFailureAt: row.last_failure_at == null ? undefined : String(row.last_failure_at),
  };
}

/** Remember a user's DM channel id so later runs skip the Create DM call entirely. */
export async function saveDmChannelId(
  client: Client,
  userId: string,
  channelId: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO delivery_state (user_id, dm_channel_id) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            dm_channel_id = excluded.dm_channel_id,
            updated_at = datetime('now')`,
    args: [userId, channelId],
  });
}

/** Record a permanent refusal so the fan-out stops attempting this user every week. */
export async function markUndeliverable(
  client: Client,
  userId: string,
  reason: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO delivery_state (user_id, undeliverable_reason, failure_count, last_failure_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            undeliverable_reason = excluded.undeliverable_reason,
            failure_count = delivery_state.failure_count + 1,
            last_failure_at = excluded.last_failure_at,
            updated_at = datetime('now')`,
    args: [userId, reason, at],
  });
}

/** Count a transient failure without marking the user off-limits. */
export async function recordDeliveryFailure(
  client: Client,
  userId: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO delivery_state (user_id, failure_count, last_failure_at) VALUES (?, 1, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            failure_count = delivery_state.failure_count + 1,
            last_failure_at = excluded.last_failure_at,
            updated_at = datetime('now')`,
    args: [userId, at],
  });
}

/** Clear failure state after a successful delivery. */
export async function clearDeliveryFailures(client: Client, userId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE delivery_state
          SET failure_count = 0, undeliverable_reason = NULL, updated_at = datetime('now')
          WHERE user_id = ?`,
    args: [userId],
  });
}

/**
 * Record a diagnostic line. Best-effort: a logging failure must never break the thing it is
 * observing, so this swallows its own errors.
 */
export async function writeDebug(client: Client, kind: string, detail: string): Promise<void> {
  try {
    await client.execute({
      sql: `INSERT INTO debug_log (kind, detail) VALUES (?, ?)`,
      args: [kind.slice(0, 100), detail.slice(0, 2000)],
    });
  } catch {
    // ignore
  }
}

/** Read a source-bookkeeping value (see `source_meta`), or null if unset. */
export async function getSourceMeta(client: Client, key: string): Promise<string | null> {
  const result = await client.execute({
    sql: `SELECT value FROM source_meta WHERE key = ?`,
    args: [key],
  });
  const row = result.rows[0];
  return row ? String(row.value) : null;
}

/** Write a source-bookkeeping value, replacing any previous one. */
export async function setSourceMeta(client: Client, key: string, value: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO source_meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [key, value],
  });
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
