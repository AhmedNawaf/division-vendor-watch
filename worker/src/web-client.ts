import { createClient, type Client } from "@libsql/client/web";

/**
 * Create a libSQL client for the Cloudflare Worker runtime. Uses the `/web` entry point, which
 * talks to Turso over HTTP (no Node net/TLS) — the Node CLI/Actions side uses `../src/db/node-client`
 * instead. The shared query layer in `../src/db/store` runs on top of either client.
 */
export function createWebClient(url: string, authToken: string): Client {
  return createClient({ url, authToken });
}
