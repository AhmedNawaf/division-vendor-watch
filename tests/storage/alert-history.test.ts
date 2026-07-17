import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlertHistory, computeFingerprint } from "../../src/storage/alert-history.js";
import { StorageError } from "../../src/errors.js";
import type { VendorItem } from "../../src/types/vendor.js";

async function tmpFile(name = "history.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dvw-"));
  return join(dir, name);
}

const item: VendorItem = {
  vendor: "White House",
  name: "Sleight",
  category: "gear",
  attributes: [{ name: "Critical Hit Chance", value: 5.7, unit: "%", rawValue: "5.7% Critical Hit Chance" }],
  talent: "Perfect Protected Reload",
  isNamed: true,
  rawText: "{}",
};

describe("computeFingerprint", () => {
  it("is stable for the same item and reset date", () => {
    expect(computeFingerprint(item, "2026-07-17")).toBe(computeFingerprint(item, "2026-07-17"));
  });

  it("changes when the reset date changes", () => {
    expect(computeFingerprint(item, "2026-07-17")).not.toBe(computeFingerprint(item, "2026-07-24"));
  });

  it("changes when attributes change", () => {
    const rolled: VendorItem = {
      ...item,
      attributes: [{ name: "Critical Hit Chance", value: 6.0, unit: "%", rawValue: "6% Critical Hit Chance" }],
    };
    expect(computeFingerprint(item, "2026-07-17")).not.toBe(computeFingerprint(rolled, "2026-07-17"));
  });
});

describe("AlertHistory", () => {
  it("reports a new fingerprint as not sent", async () => {
    const history = await AlertHistory.load(await tmpFile());
    expect(history.has(computeFingerprint(item))).toBe(false);
  });

  it("reports an added fingerprint as sent", async () => {
    const history = await AlertHistory.load(await tmpFile());
    const fp = computeFingerprint(item);
    history.add(fp);
    expect(history.has(fp)).toBe(true);
  });

  it("persists and reloads fingerprints", async () => {
    const path = await tmpFile();
    const first = await AlertHistory.load(path);
    const fp = computeFingerprint(item, "2026-07-17");
    first.add(fp);
    await first.save();

    const second = await AlertHistory.load(path);
    expect(second.has(fp)).toBe(true);
    expect(second.size).toBe(1);
  });

  it("treats a missing file as empty history", async () => {
    const history = await AlertHistory.load(join(tmpdir(), "does-not-exist-dvw", "h.json"));
    expect(history.size).toBe(0);
  });

  it("throws StorageError on corrupt history", async () => {
    const path = await tmpFile();
    await writeFile(path, "{ not json", "utf8");
    await expect(AlertHistory.load(path)).rejects.toThrow(StorageError);
  });

  it("throws StorageError when persistence fails", async () => {
    // A path whose parent is a file, not a directory, cannot be written.
    const filePath = await tmpFile("afile.json");
    await writeFile(filePath, "{}", "utf8");
    const badPath = join(filePath, "nested", "history.json");
    const history = new AlertHistory(badPath);
    history.add("abc");
    await expect(history.save()).rejects.toThrow(StorageError);
  });

  it("writes valid JSON that round-trips", async () => {
    const path = await tmpFile();
    const history = await AlertHistory.load(path);
    history.add("fp-1", "2026-07-17T00:00:00.000Z");
    await history.save();
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.sent["fp-1"]).toBe("2026-07-17T00:00:00.000Z");
  });
});
