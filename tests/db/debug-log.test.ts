import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { DEBUG_LOG_LIMIT, initSchema, writeDebug } from "../../src/db/store.js";

describe("debug log", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
  });

  const count = async (): Promise<number> =>
    Number((await client.execute("SELECT COUNT(*) AS n FROM debug_log")).rows[0]!.n);

  it("records what it is given", async () => {
    await writeDebug(client, "interaction", "type=5 -> 4 in 40ms");
    const rows = (await client.execute("SELECT kind, detail FROM debug_log")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("interaction");
    expect(String(rows[0]!.detail)).toContain("type=5");
  });

  it("keeps the log bounded, retaining the newest entries", async () => {
    // Without pruning this table grows for the life of the deployment.
    for (let i = 0; i < DEBUG_LOG_LIMIT + 25; i += 1) {
      await writeDebug(client, "interaction", `entry ${i}`);
    }

    expect(await count()).toBeLessThanOrEqual(DEBUG_LOG_LIMIT);

    const newest = (
      await client.execute("SELECT detail FROM debug_log ORDER BY id DESC LIMIT 1")
    ).rows[0];
    expect(String(newest!.detail)).toBe(`entry ${DEBUG_LOG_LIMIT + 24}`);

    // The oldest entries are the ones dropped.
    const oldest = (await client.execute("SELECT detail FROM debug_log ORDER BY id LIMIT 1")).rows[0];
    expect(String(oldest!.detail)).not.toBe("entry 0");
  });

  it("truncates oversized details rather than storing them whole", async () => {
    await writeDebug(client, "error", "x".repeat(5000));
    const row = (await client.execute("SELECT detail FROM debug_log")).rows[0];
    expect(String(row!.detail).length).toBeLessThanOrEqual(2000);
  });

  it("never throws, so logging cannot break what it observes", async () => {
    const broken = createClient({ url: ":memory:" }); // no schema applied
    await expect(writeDebug(broken, "interaction", "detail")).resolves.toBeUndefined();
  });
});
