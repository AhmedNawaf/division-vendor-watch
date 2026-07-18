import { readFile } from "node:fs/promises";
import { ConfigError } from "../errors.js";
import { parseWatchlist, type Watchlist } from "./watchlist-schema.js";

// Re-export the (Node-free) schema surface so existing importers keep the same entry point.
export {
  parseWatchlist,
  watchRuleSchema,
  watchlistSchema,
  type WatchRule,
  type Watchlist,
} from "./watchlist-schema.js";

/** Load and validate a watchlist JSON file from disk. */
export async function loadWatchlist(path: string): Promise<Watchlist> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Could not read watchlist file at ${path}`, { path }, { cause: err });
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Watchlist at ${path} is not valid JSON`, { path }, { cause: err });
  }

  return parseWatchlist(data, path);
}
