import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { ItemCategory } from "../types/vendor.js";

/**
 * The watchlist schema and its validators, kept free of any Node-only imports (no `fs`) so it
 * can be bundled into the Cloudflare Worker. `load-watchlist.ts` adds the filesystem loader on
 * top of this for the CLI / GitHub Actions runtimes.
 */

const CATEGORY_VALUES: readonly [ItemCategory, ...ItemCategory[]] = [
  "weapon",
  "gear",
  "gear-mod",
  "skill-mod",
  "unknown",
];

/** A single watch rule. All present conditions must hold for the rule to match. */
export const watchRuleSchema = z
  .object({
    itemName: z.string().min(1).optional(),
    brand: z.string().min(1).optional(),
    gearSet: z.string().min(1).optional(),
    category: z.enum(CATEGORY_VALUES).optional(),
    requiredAttributes: z.array(z.string().min(1)).nonempty().optional(),
    talent: z.string().min(1).optional(),
    namedOnly: z.boolean().optional(),
    minimumRollPercentage: z.number().min(0).max(100).optional(),
    /** Optional human label to make match reasons friendlier. */
    label: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (rule) =>
      Object.keys(rule).some((key) =>
        [
          "itemName",
          "brand",
          "gearSet",
          "category",
          "requiredAttributes",
          "talent",
          "namedOnly",
          "minimumRollPercentage",
        ].includes(key),
      ),
    { message: "A rule must specify at least one matching condition" },
  );

export const watchlistSchema = z
  .object({
    rules: z.array(watchRuleSchema).nonempty("Watchlist must contain at least one rule"),
  })
  .strict();

export type WatchRule = z.infer<typeof watchRuleSchema>;
export type Watchlist = z.infer<typeof watchlistSchema>;

/** Validate an already-parsed object as a Watchlist. Throws ConfigError on failure. */
export function parseWatchlist(data: unknown, source = "<memory>"): Watchlist {
  const result = watchlistSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError(`Invalid watchlist (${source})`, {
      source,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
