# Division Vendor Watch

A small, personal tool that checks **The Division 2** weekly vendor reset and sends a
Discord alert when any item matches your watchlist. It runs on demand or on a weekly
GitHub Actions schedule, and it remembers what it has already alerted on so you never
get the same notification twice.

- Fetches the weekly vendor reset data and normalizes every vendor item.
- Matches items against rules you define in `config/watchlist.json`.
- Formats concise Discord messages (grouped, and split to respect the 2000-char limit).
- Sends via a Discord webhook with retry + rate-limit handling.
- De-duplicates alerts using a fingerprint history, so repeat runs stay quiet.
- Fails loudly if the source structure changes or yields no items.

## How it gets the data

The vendor page loads its stock from JSON endpoints referenced by a loader script on the
page (not from static HTML tables). This tool reads the page, discovers those endpoint
URLs and the reset date dynamically, then fetches the gear / weapons / mods JSON. This is
the most reliable extraction path — it avoids scraping presentational HTML that changes
often. If the loader script or any of the three sections goes missing, the run fails with
a clear `VendorSourceError` / `ParserError` rather than silently sending nothing.

### Reset date & time

The page's JSON cache-buster (e.g. `?20260717`) is the site's *last-updated* date, not the
in-game reset. The tool instead computes the real weekly reset — **Tuesday, ~08:30 UTC** — in
[`src/source/reset-schedule.ts`](src/source/reset-schedule.ts), and displays it in your time
zone (`RESET_TIMEZONE`, default `Asia/Riyadh`), e.g. `Tue, 14 Jul 2026, 11:30 GMT+3`. If the
game's reset time ever changes, adjust `RESET_HOUR_UTC` / `RESET_MINUTE_UTC` in that file. The
canonical reset **date** (not the display time) is what keys duplicate-prevention fingerprints,
so it stays stable for every run within the same vendor week.

## Requirements

- Node.js **>= 20** (uses the native `fetch`).
- A Discord webhook URL (only needed to actually send alerts).

## Install

```bash
npm install
```

## Configure your watchlist

Rules live in [`config/watchlist.json`](config/watchlist.json). A rule matches an item
only when **all** of its conditions hold. Matching is case- and punctuation-insensitive.

| Field                   | Type     | Matches when…                                                        |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `itemName`              | string   | the item name equals this (fuzzy: case/punctuation-insensitive)      |
| `brand`                 | string   | the item's brand equals this                                         |
| `gearSet`               | string   | the item belongs to this gear set                                    |
| `category`              | enum     | one of `weapon`, `gear`, `gear-mod`, `skill-mod`, `unknown`          |
| `requiredAttributes`    | string[] | the item has **all** of these attributes (by name)                   |
| `talent`                | string   | the item's talent matches this                                       |
| `namedOnly`             | boolean  | `true` → only named/exotic items                                     |
| `minimumRollPercentage` | number   | a `%` roll meets this threshold (applies to `requiredAttributes` if given, else any `%` attribute) |
| `label`                 | string   | optional friendly label prepended to the match reason               |

Every rule needs at least one condition (`label` alone is not enough). Example:

```json
{
  "rules": [
    { "itemName": "Fox's Prayer", "label": "Fox's Prayer (named holster)" },
    { "gearSet": "Tip of the Spear", "requiredAttributes": ["Weapon Damage"] },
    { "brand": "Grupo Sombra S.A.", "requiredAttributes": ["Critical Hit Chance", "Critical Hit Damage"] },
    { "category": "weapon", "namedOnly": true },
    { "category": "gear", "requiredAttributes": ["Critical Hit Chance"], "minimumRollPercentage": 5.5 }
  ]
}
```

## Environment variables

Copy [`.env.example`](.env.example) to `.env` (it's gitignored) or set these in your shell / CI.

| Variable              | Default                              | Purpose                                                        |
| --------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `DISCORD_WEBHOOK_URL` | _(none)_                             | Discord webhook to post to. Required to send; omit for dry-run. |
| `VENDOR_URL`          | the rubenalamina weekly reset page   | Source page to read.                                            |
| `WATCHLIST_PATH`      | `config/watchlist.json`              | Path to your watchlist.                                        |
| `ALERT_HISTORY_PATH`  | `data/alert-history.json`            | Where sent-alert fingerprints are stored.                     |
| `REQUEST_TIMEOUT_MS`  | `15000`                              | Per-request timeout.                                          |
| `DRY_RUN`             | `false`                              | `true` → preview **all** current matches (history ignored), but don't send or write history. |
| `SHOW_REASONS`        | `true`                               | Include the per-item "Reason:" section in alerts; `false` to hide it. |
| `RESET_TIMEZONE`      | `Asia/Riyadh`                        | IANA time zone for the displayed reset stamp (any IANA zone).  |

The webhook URL is treated as a secret: it is never logged and never included in error messages.

## Running locally

`npm run dev` and `npm start` auto-load a local `.env` file if present (via Node's native
`--env-file-if-exists`), so once you've filled in `.env` you don't need to export anything.
Real environment variables still take precedence over `.env`, and CI (which has no `.env`)
is unaffected.

Dry run (no webhook needed — previews every current match regardless of history, writes nothing):

```bash
DRY_RUN=true npm run dev
```

Real run (sends alerts and records fingerprints), reading `DISCORD_WEBHOOK_URL` from `.env`:

```bash
npm run dev
```

Or pass it inline instead of using `.env`:

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…" npm run dev
```

Or build first and run the compiled output:

```bash
npm run build
DISCORD_WEBHOOK_URL="…" npm start
```

Refresh the local test fixtures from the live site (dev helper):

```bash
npm run inspect
```

## Tests, types, and lint

```bash
npm test        # Vitest unit + integration suite
npm run typecheck
npm run lint
npm run build
```

The integration test drives the whole pipeline (saved HTML → parser → matcher → formatter →
mocked webhook) without touching the network.

## Automating with GitHub Actions

The workflow at [`.github/workflows/vendor-watch.yml`](.github/workflows/vendor-watch.yml):

- runs every **Tuesday 16:00 UTC** (shortly after the weekly reset) and on manual dispatch,
- installs, lints, tests, builds, then runs the checker,
- commits the updated `data/alert-history.json` back to the repo so duplicate-prevention
  state survives between runs (the file is gitignored locally, force-added in CI).

### Set the webhook secret

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `DISCORD_WEBHOOK_URL`
- Value: your webhook URL

### Manual trigger

**Actions → Vendor Watch → Run workflow.** Tick the `dry_run` box to parse and print
without sending or writing history — handy for testing rule changes.

## Creating a Discord webhook

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Pick the channel, optionally rename it, and **Copy Webhook URL**.
3. Use that URL as `DISCORD_WEBHOOK_URL` locally and as the `DISCORD_WEBHOOK_URL` GitHub secret.

Treat the URL like a password — anyone with it can post to your channel. Don't commit it.

## Duplicate prevention

Each alerted item gets a fingerprint derived from the reset date, vendor, item name,
attributes, and talent. Fingerprints are stored in `ALERT_HISTORY_PATH` and are only
written **after** a successful Discord delivery — so a failed send won't suppress a retry.
A new weekly reset produces new fingerprints, so genuinely new stock always alerts.

## Multi-user Discord bot (in progress)

Alongside the single-user webhook flow above, the repo is growing a **multi-user bot** so
anyone can install it, pick a wishlist from menus (no typing), and get their own alerts. The
shared matching/formatting logic lives in [`src/core`](src/core) and is reused by both paths.

**Architecture (all on free tiers):**

- **Cloudflare Worker** ([`worker/`](worker)) — the Discord *HTTP interactions* endpoint. It
  verifies the Ed25519 request signature, routes `/wishlist` slash commands and menu clicks,
  and stores each user's rules. No always-on server.
- **Turso / libSQL** — the database. The same query layer in [`src/db/store.ts`](src/db/store.ts)
  runs under the Worker (`@libsql/client/web`) and Node (`@libsql/client`) via an injected client.
- **GitHub Actions** (weekly, planned) — the fan-out that fetches vendor stock once, matches it
  against every subscriber's rules, and DMs alerts. It uses the Node runtime (no Worker CPU cap).

### Provision the pieces

1. **Discord application** — at <https://discord.com/developers/applications>, create an app.
   Note the **Application ID** and **Public Key** (General Information), and a **Bot token**
   (Bot tab). Under **Installation**, enable **User Install**.
2. **Turso database** — create a database and grab its `libsql://…` URL and an auth token
   (`turso db create`, `turso db show`, `turso db tokens create`). Apply the schema once with
   the SQL in [`src/db/schema.ts`](src/db/schema.ts) (`turso db shell <db> < schema.sql`, or call
   `initSchema(client)` from a Node script).
3. **Register the slash commands** — from `worker/`:
   ```bash
   npm install
   DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run register
   ```

### Configure & deploy the Worker

Secrets are set with Wrangler, never committed:

```bash
cd worker
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npm run deploy
```

Then set the deployed URL as the app's **Interactions Endpoint URL** in the Discord portal —
Discord sends a signed PING that the Worker must answer (it does). Once saved, `/wishlist add`,
`/wishlist list`, and `/wishlist remove` work in DMs.

> Going **public** (listed, installable by strangers) adds obligations: a Privacy Policy and
> Terms of Service, verification at 100 installs, and DM-rate-limit hygiene. The current slice
> targets you and friends first; treat public distribution as a later, deliberate step.

## Troubleshooting

- **`[VENDOR_SOURCE] …` / `[PARSER] …`** — the source page or its data endpoints changed
  shape (loader script missing, a section empty, or item count implausibly low). The error
  context shows what was found. Run `npm run inspect` to re-capture fixtures and inspect them.
- **`[CONFIG] Invalid watchlist …`** — a rule has an unknown key, an invalid category, an
  out-of-range `minimumRollPercentage`, or no conditions. The error lists the offending paths.
- **`[DISCORD_DELIVERY] …`** — delivery failed. Transient 5xx / network errors and 429 rate
  limits are retried automatically; a permanent 4xx (e.g. a bad/expired webhook) fails fast.
  Check that the webhook URL is correct and still exists.
- **No alerts but you expected some** — you may have already been alerted this reset (check
  the history file), or nothing in stock matched. Use `DRY_RUN=true` to see current matches.
