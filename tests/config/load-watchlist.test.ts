import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWatchlist, parseWatchlist } from "../../src/config/load-watchlist.js";
import { ConfigError } from "../../src/errors.js";

describe("parseWatchlist", () => {
  it("accepts a valid watchlist", () => {
    const wl = parseWatchlist({
      rules: [
        { itemName: "Fox's Prayer" },
        { brand: "Grupo Sombra S.A.", requiredAttributes: ["Critical Hit Chance"] },
      ],
    });
    expect(wl.rules).toHaveLength(2);
  });

  it("rejects an empty rules array", () => {
    expect(() => parseWatchlist({ rules: [] })).toThrow(ConfigError);
  });

  it("rejects a rule with no conditions", () => {
    expect(() => parseWatchlist({ rules: [{}] })).toThrow(ConfigError);
  });

  it("rejects unknown keys", () => {
    expect(() => parseWatchlist({ rules: [{ itemName: "X", bogus: true }] })).toThrow(ConfigError);
  });

  it("rejects an invalid category", () => {
    expect(() => parseWatchlist({ rules: [{ category: "sidearm" }] })).toThrow(ConfigError);
  });

  it("rejects an out-of-range minimumRollPercentage", () => {
    expect(() => parseWatchlist({ rules: [{ minimumRollPercentage: 250 }] })).toThrow(ConfigError);
  });
});

describe("loadWatchlist", () => {
  it("loads and validates a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dvw-wl-"));
    const path = join(dir, "watchlist.json");
    await writeFile(path, JSON.stringify({ rules: [{ itemName: "Test" }] }), "utf8");
    const wl = await loadWatchlist(path);
    expect(wl.rules[0]!.itemName).toBe("Test");
  });

  it("throws ConfigError for a missing file", async () => {
    await expect(loadWatchlist(join(tmpdir(), "nope-dvw", "missing.json"))).rejects.toThrow(
      ConfigError,
    );
  });

  it("throws ConfigError for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dvw-wl-"));
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(loadWatchlist(path)).rejects.toThrow(ConfigError);
  });
});
