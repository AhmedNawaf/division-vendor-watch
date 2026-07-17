import { describe, expect, it, vi } from "vitest";
import { sendDiscordMessage, sendDiscordMessages } from "../../src/discord/send-webhook.js";
import { DiscordDeliveryError } from "../../src/errors.js";

const WEBHOOK = "https://discord.com/api/webhooks/123/abc";
const noSleep = () => Promise.resolve();

function response(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body || null, { status, headers });
}

describe("sendDiscordMessage", () => {
  it("resolves on a 204 success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(204));
    await sendDiscordMessage("hello", { webhookUrl: WEBHOOK, fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1];
    expect(JSON.parse(init.body)).toEqual({ content: "hello" });
  });

  it("retries on a 5xx and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(500))
      .mockResolvedValueOnce(response(204));
    await sendDiscordMessage("hi", { webhookUrl: WEBHOOK, fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors a 429 rate limit then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(429, JSON.stringify({ retry_after: 0.2 })))
      .mockResolvedValueOnce(response(204));
    await sendDiscordMessage("hi", { webhookUrl: WEBHOOK, fetchImpl, sleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("fails fast on a permanent 4xx without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(400, "bad request"));
    await expect(
      sendDiscordMessage("hi", { webhookUrl: WEBHOOK, fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(DiscordDeliveryError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on persistent network errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      sendDiscordMessage("hi", { webhookUrl: WEBHOOK, fetchImpl, sleep: noSleep, maxRetries: 2 }),
    ).rejects.toThrow(/Network error/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid webhook URL", async () => {
    const fetchImpl = vi.fn();
    await expect(sendDiscordMessage("hi", { webhookUrl: "not-a-url", fetchImpl })).rejects.toThrow(
      DiscordDeliveryError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never includes the webhook URL in thrown errors", async () => {
    const secret = "https://discord.com/api/webhooks/SECRET/TOKEN";
    const fetchImpl = vi.fn().mockResolvedValue(response(403, "forbidden"));
    const err = await sendDiscordMessage("hi", { webhookUrl: secret, fetchImpl, sleep: noSleep }).catch(
      (e) => e as Error,
    );
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("TOKEN");
  });
});

describe("sendDiscordMessages", () => {
  it("sends messages in order", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(204));
    await sendDiscordMessages(["one", "two"], { webhookUrl: WEBHOOK, fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).content).toBe("one");
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).content).toBe("two");
  });
});
