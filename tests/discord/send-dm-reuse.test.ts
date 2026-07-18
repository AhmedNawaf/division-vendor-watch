import { describe, expect, it } from "vitest";
import {
  DiscordUndeliverableError,
  sendDirectMessages,
  type SendDmOptions,
} from "../../src/discord/send-dm.js";
import { DiscordDeliveryError } from "../../src/errors.js";

const API = "https://discord.example/api/v10";
const CHANNEL = "555000111";

interface Call {
  path: string;
  body: unknown;
}

/**
 * A fake Discord that records paths. `channelResponses` lets a test make the first POST to a
 * cached channel fail (e.g. 10003) so the reopen path can be exercised.
 */
function fakeDiscord(opts: {
  createDmStatus?: number;
  createDmBody?: unknown;
  messageStatuses?: Array<{ status: number; body?: unknown }>;
}) {
  const calls: Call[] = [];
  let messageIndex = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(API, "");
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (path === "/users/@me/channels") {
      const status = opts.createDmStatus ?? 200;
      return new Response(JSON.stringify(opts.createDmBody ?? { id: CHANNEL }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    const planned = opts.messageStatuses?.[messageIndex];
    messageIndex += 1;
    if (planned) {
      return new Response(JSON.stringify(planned.body ?? {}), {
        status: planned.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function options(fetchImpl: typeof fetch): SendDmOptions {
  return { botToken: "t", fetchImpl, apiBase: API, sleep: () => Promise.resolve() };
}

describe("sendDirectMessages channel reuse", () => {
  it("opens a DM channel when none is cached, and reports the id to cache", async () => {
    const { fetchImpl, calls } = fakeDiscord({});
    const result = await sendDirectMessages("u1", ["hi"], options(fetchImpl));

    expect(result.channelId).toBe(CHANNEL);
    expect(result.openedChannel).toBe(true);
    expect(calls.map((c) => c.path)).toEqual([
      "/users/@me/channels",
      `/channels/${CHANNEL}/messages`,
    ]);
  });

  it("skips the Create DM call entirely when a channel id is cached", async () => {
    const { fetchImpl, calls } = fakeDiscord({});
    const result = await sendDirectMessages("u1", ["hi", "again"], options(fetchImpl), CHANNEL);

    expect(result.openedChannel).toBe(false);
    // This is the whole point: no /users/@me/channels call, which is what gets bots quarantined.
    expect(calls.every((c) => c.path !== "/users/@me/channels")).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("reopens once when a cached channel has gone stale (10003)", async () => {
    const { fetchImpl, calls } = fakeDiscord({
      messageStatuses: [{ status: 404, body: { code: 10003, message: "Unknown Channel" } }],
    });

    const result = await sendDirectMessages("u1", ["hi"], options(fetchImpl), "stale-channel");

    expect(result.openedChannel).toBe(true);
    expect(result.channelId).toBe(CHANNEL);
    expect(calls.map((c) => c.path)).toEqual([
      "/channels/stale-channel/messages", // fails 10003
      "/users/@me/channels", // reopen
      `/channels/${CHANNEL}/messages`, // retry
    ]);
  });

  it("treats 50007 as permanently undeliverable rather than retryable", async () => {
    const { fetchImpl } = fakeDiscord({
      messageStatuses: [
        { status: 403, body: { code: 50007, message: "Cannot send messages to this user" } },
      ],
    });

    await expect(sendDirectMessages("u1", ["hi"], options(fetchImpl), CHANNEL)).rejects.toBeInstanceOf(
      DiscordUndeliverableError,
    );
  });

  it("treats a 400 from Create DM as undeliverable (blocked bot / DMs closed)", async () => {
    // Discord answers 400 here rather than 403 when the recipient refuses DMs.
    const { fetchImpl } = fakeDiscord({
      createDmStatus: 400,
      createDmBody: { code: 50007, message: "Cannot send messages to this user" },
    });

    await expect(sendDirectMessages("u1", ["hi"], options(fetchImpl))).rejects.toBeInstanceOf(
      DiscordUndeliverableError,
    );
  });

  it("still reports an ordinary rejection as a plain delivery error", async () => {
    const { fetchImpl } = fakeDiscord({
      messageStatuses: [{ status: 404, body: { code: 10003, message: "Unknown Channel" } }],
    });

    // No cached id, so the channel was opened this run — a 10003 is then genuinely unexpected
    // and must not be silently papered over by reopening in a loop.
    const err = await sendDirectMessages("u1", ["hi"], options(fetchImpl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordDeliveryError);
    expect(err).not.toBeInstanceOf(DiscordUndeliverableError);
  });
});
