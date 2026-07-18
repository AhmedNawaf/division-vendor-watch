/**
 * The libSQL/Turso schema, kept as a string (not a .sql file) so it can be applied from any
 * runtime — the Worker has no filesystem, and tests apply it in-memory. Run it with
 * `client.executeMultiple(SCHEMA_SQL)` or feed it to `turso db shell < ...` during setup.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- Discord user id
  timezone      TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  show_reasons  INTEGER NOT NULL DEFAULT 1, -- 0/1
  delivery      TEXT NOT NULL DEFAULT 'dm', -- 'dm' now; 'channel' reserved for server support
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name                TEXT,
  brand                    TEXT,
  gear_set                 TEXT,
  category                 TEXT,   -- weapon|gear|gear-mod|skill-mod|unknown
  required_attributes      TEXT,   -- JSON array of attribute names
  talent                   TEXT,
  named_only               INTEGER,-- 0/1/null
  minimum_roll_percentage  REAL,
  label                    TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rules_user ON rules(user_id);

CREATE TABLE IF NOT EXISTS alert_history (
  user_id     TEXT NOT NULL,
  reset_week  TEXT NOT NULL,   -- canonical Tuesday reset day, YYYY-MM-DD
  fingerprint TEXT NOT NULL,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_history_user_week ON alert_history(user_id, reset_week);

CREATE TABLE IF NOT EXISTS vendor_cache (
  reset_week  TEXT PRIMARY KEY,  -- canonical Tuesday reset day
  fetched_at  TEXT NOT NULL,
  items_json  TEXT NOT NULL      -- JSON array of normalized VendorItem
);

-- Per-user delivery bookkeeping. Separate from users so it can be added to an existing
-- database without a column migration.
--
-- dm_channel_id is the single most important column here: Discord's Create DM endpoint warns
-- that opening many DMs quickly can get a bot "blocked from opening new ones", and DM channel
-- ids are stable and reusable. Caching them means we open a channel once per user, ever, and
-- steady-state runs issue no Create DM calls at all.
--
-- undeliverable_reason records a *permanent* refusal (user blocked the bot, DMs closed) so we
-- stop retrying them every week — both to avoid a pointless 403 every run and to keep the
-- failure count meaningful.
CREATE TABLE IF NOT EXISTS delivery_state (
  user_id              TEXT PRIMARY KEY,
  dm_channel_id        TEXT,
  undeliverable_reason TEXT,
  failure_count        INTEGER NOT NULL DEFAULT 0,
  last_failure_at      TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Interaction diagnostics. Cloudflare's wrangler tail is live-only, so a failure that happens
-- while nobody is watching leaves no trace; writing here instead means the record survives and
-- can be read at any time. Written after the response is sent, so it costs no latency.
CREATE TABLE IF NOT EXISTS debug_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  kind   TEXT NOT NULL,
  detail TEXT
);

-- Small key/value bag for source bookkeeping (e.g. per-payload Last-Modified stamps used
-- for conditional requests). Kept separate from vendor_cache so it can be added to an
-- existing database without a column migration.
CREATE TABLE IF NOT EXISTS source_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reserved for the later server-channel delivery mode; unused while delivery = 'dm'.
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id      TEXT PRIMARY KEY,
  channel_id    TEXT,
  configured_by TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
