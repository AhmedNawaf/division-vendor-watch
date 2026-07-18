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

### Where the data actually comes from

There is no official Ubisoft API for vendor stock, and the weekly rotation is server-side, so
it cannot be datamined from game files. Every community tool in this space ultimately reads the
same three JSON files, which **Ruben Alamina compiles by hand each week** and publishes for
free — no terms of use, no rate limits, fully open `robots.txt`. We are guests on someone's
personal server, so the tool is built to be a considerate one:

- **Conditional requests.** Each payload's `Last-Modified` is stored and echoed back as
  `If-Modified-Since`. An unchanged week costs three `304`s and transfers no bodies.
- **Attribution.** Alerts carry a `📖 Data: rubenalamina.mx` credit line.
- **A cache, not a retry storm.** Parsed stock is cached per reset week; a failed fetch serves
  that cache instead of hammering the source.

> **Note:** the site is updated *several times a week*, not just at reset — Cassie's stock is
> added on Wednesdays and corrections land later. A Tuesday-only run will miss those. Because
> conditional requests make a no-op check nearly free, polling daily is the cheaper-than-it-looks
> option, and per-item fingerprints mean nothing gets alerted twice.

### Resilience and degraded sources

`resolveStock` in [`src/fanout/run-fanout.ts`](src/fanout/run-fanout.ts) degrades in the order
that keeps alerts *truthful* — the guiding rule being that alerting on stock nobody can buy is
worse than alerting nothing:

1. Fresh conditional fetch from the primary source.
2. On `304` — this reset week's cached stock. It is still evaluated, because watchlists change
   independently of the stock: a rule added yesterday must still match today.
3. On failure — the same cached copy, flagged degraded (alerts say so in their header).
4. On failure with no usable cache — the run fails rather than alerting on anything older.

The cache is always scoped to the current reset week; a previous week's stock is never served.

A **community mirror was tried and removed.**
[`mxswat/mx-division-builds`](https://github.com/mxswat/mx-division-builds) syncs the same three
JSON files, so it looks like an obvious fallback — but its sync runs at ~03:30 UTC on Tuesday,
*before* the 08:30 reset, so its copy always predates the current week, and its `mods.json` has
not been updated since **February 2021**. A freshness gate keyed on the GitHub commit date
correctly rejected 100% of its payloads. It was working code that could never fire, so the cache
is the only fallback, and it is the one that was carrying the weight anyway.

### Knowing it still works

A weekly job that stops is invisible: no message on Tuesday looks exactly like a Tuesday where
nothing matched. So each fan-out records its outcome to `source_meta` under `fanout:lastRun`, and
`/wishlist show` reports it:

```
✅ Last checked 2h ago — 144 items, 1 subscriber(s).
⚠️ Last successful check was 12 days ago — the weekly run may have stopped.
⚠️ The last vendor check (3h ago) failed: Network error fetching vendor page
```

Because the check is "when did a run last succeed", it catches every cause at once — a crash, a
missing secret, an expired token, or GitHub disabling the schedule after 60 days of repository
inactivity. Dry runs deliberately do **not** write a heartbeat: a preview must never make a broken
schedule look healthy.

The one case this cannot cover is the database itself being unreachable, since that is where the
heartbeat lives. For that, the workflow's own red run is the signal — GitHub emails you when a
scheduled workflow fails, provided notifications are enabled for the repository.

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

### DM delivery safety

The realistic way to lose this bot is not a rate limit — it is **quarantine**. Discord's Create
DM endpoint carries an explicit warning that opening "a significant amount of DMs too quickly"
can get a bot *blocked from opening new ones*, and
[discord-api-docs#5987](https://github.com/discord/discord-api-docs/issues/5987) documents
legitimate bots being quarantined indefinitely with no published threshold and no appeal path.
The trigger correlates with **channel opens**, not messages sent. The fan-out is built around
that fact:

- **DM channel ids are cached forever** (`delivery_state.dm_channel_id`). We open a channel once
  per user, ever; steady-state runs make zero Create DM calls. Verified against production —
  a second send to a cached id issues only `/channels/{id}/messages`. If an id ever goes stale
  (`10003`), we reopen once and re-cache. This is the single biggest risk reduction available.
- **Everything is paced** through one shared token bucket (`RateLimiter`), default 5 req/s
  against Discord's 50 req/s ceiling, plus a 1s gap between users. A weekly digest is not
  second-sensitive, so there is no reason to burst.
- **A global 429 halts the whole run**, not just the offending route — continuing to send on
  other routes during a global limit is what escalates a 429 into an IP-level ban.
- **Permanent refusals stop being retried.** A `50007`, a `403`, or a `400` from Create DM
  (which is how Discord reports "blocked the bot / DMs closed") raises
  `DiscordUndeliverableError`; the user is recorded in `delivery_state.undeliverable_reason`
  and skipped thereafter. Discord bans an IP after 10,000 invalid (401/403/429) requests in
  10 minutes, so re-earning a 403 every week across a fleet is an availability risk, not just
  log noise. Transient failures still retry and clear on success.

Keep DM content strictly functional. Discord's Developer Policy permits messages "directly
related to maintaining or improving an Application's functionality" — adding changelogs,
promotion, or anything unrelated would move this from compliant to violating.

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
