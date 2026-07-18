/** Bindings configured in wrangler.toml (vars) and via `wrangler secret put` (secrets). */
export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  DISCORD_BOT_TOKEN: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
}
