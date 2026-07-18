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

-- Reserved for the later server-channel delivery mode; unused while delivery = 'dm'.
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id      TEXT PRIMARY KEY,
  channel_id    TEXT,
  configured_by TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
