import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StorageError } from "../errors.js";
import type { VendorItem } from "../types/vendor.js";

interface HistoryFile {
  version: 1;
  /** fingerprint -> ISO timestamp when the alert was sent. */
  sent: Record<string, string>;
}

/**
 * Build a stable fingerprint from reset date + vendor + item + attributes + talent.
 * The same item in the same weekly reset always yields the same fingerprint, so an
 * alert is never sent twice.
 */
export function computeFingerprint(item: VendorItem, resetDate?: string): string {
  const norm = (value: string | undefined) => (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const attributes = [
    ...(item.coreAttribute ? [item.coreAttribute] : []),
    ...item.attributes,
  ]
    .map((attr) => norm(attr.rawValue))
    .sort();

  const canonical = [
    norm(resetDate),
    norm(item.vendor),
    norm(item.name),
    norm(item.category),
    norm(item.talent),
    norm(item.gearSet),
    norm(item.brand),
    attributes.join(","),
  ].join("|");

  return createHash("sha256").update(canonical).digest("hex");
}

/** In-memory view over the on-disk history file, with load/has/add/save. */
export class AlertHistory {
  private readonly path: string;
  private data: HistoryFile;

  constructor(path: string, data?: HistoryFile) {
    this.path = path;
    this.data = data ?? { version: 1, sent: {} };
  }

  static async load(path: string): Promise<AlertHistory> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new AlertHistory(path);
      }
      throw new StorageError(`Could not read alert history at ${path}`, { path }, { cause: err });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StorageError(`Alert history at ${path} is corrupt (invalid JSON)`, { path }, {
        cause: err,
      });
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as HistoryFile).sent !== "object"
    ) {
      throw new StorageError(`Alert history at ${path} has an unexpected shape`, { path });
    }

    return new AlertHistory(path, { version: 1, sent: (parsed as HistoryFile).sent });
  }

  has(fingerprint: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.sent, fingerprint);
  }

  /** Record a fingerprint as sent (in memory only until save()). */
  add(fingerprint: string, at: string = new Date().toISOString()): void {
    this.data.sent[fingerprint] = at;
  }

  get size(): number {
    return Object.keys(this.data.sent).length;
  }

  /** Persist to disk atomically (write temp file, then rename). */
  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
      await rename(tmp, this.path);
    } catch (err) {
      throw new StorageError(`Could not write alert history at ${this.path}`, { path: this.path }, {
        cause: err,
      });
    }
  }
}
