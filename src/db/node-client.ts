import { createClient, type Client } from "@libsql/client";

/**
 * Create a libSQL client for Node runtimes (CLI and the GitHub Actions fan-out).
 * The Cloudflare Worker must NOT import this — it uses `@libsql/client/web` instead.
 *
 * `url` examples: `libsql://<db>.turso.io` (with an auth token) or `file:local.db` /
 * `:memory:` for local development and tests.
 */
export function createNodeClient(url: string, authToken?: string): Client {
  return createClient(authToken ? { url, authToken } : { url });
}
