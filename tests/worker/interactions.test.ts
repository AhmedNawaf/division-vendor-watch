import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { initSchema, listRules } from "../../src/db/store.js";
import {
  ComponentType,
  type Interaction,
  InteractionResponseType,
  InteractionType,
} from "../../worker/src/discord.js";
import { handleInteraction } from "../../worker/src/interactions.js";

const USER = "user-123";

function command(sub: string): Interaction {
  return {
    id: "1",
    application_id: "app",
    type: InteractionType.APPLICATION_COMMAND,
    token: "t",
    user: { id: USER },
    data: { name: "wishlist", options: [{ name: sub, type: 1 }] },
  };
}

function component(customId: string, values: string[]): Interaction {
  return {
    id: "1",
    application_id: "app",
    type: InteractionType.MESSAGE_COMPONENT,
    token: "t",
    member: { user: { id: USER } },
    data: { custom_id: customId, values },
  };
}

describe("handleInteraction", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
  });

  it("answers PING with PONG", async () => {
    const res = await handleInteraction(
      { id: "1", application_id: "app", type: InteractionType.PING, token: "t" },
      () => client,
    );
    expect(res.type).toBe(InteractionResponseType.PONG);
  });

  it("shows an empty wishlist for /wishlist list", async () => {
    const res = await handleInteraction(command("list"), () => client);
    expect(res.data?.content).toContain("empty");
  });

  it("renders a select menu for /wishlist add", async () => {
    const res = await handleInteraction(command("add"), () => client);
    const row = res.data?.components?.[0] as { components?: Array<{ type: number }> };
    expect(row.components?.[0]?.type).toBe(ComponentType.STRING_SELECT);
  });

  it("adds a preset rule when a menu option is chosen", async () => {
    const res = await handleInteraction(component("wishlist:add", ["named-weapons"]), () => client);
    expect(res.type).toBe(InteractionResponseType.UPDATE_MESSAGE);
    expect(res.data?.content).toContain("Named weapons");

    const rules = await listRules(client, USER);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ category: "weapon", namedOnly: true });
  });

  it("removes a rule chosen from the remove menu", async () => {
    await handleInteraction(component("wishlist:add", ["gear"]), () => client);
    const [rule] = await listRules(client, USER);

    const res = await handleInteraction(component("wishlist:remove", [String(rule!.id)]), () => client);
    expect(res.data?.content).toContain("Removed");
    expect(await listRules(client, USER)).toHaveLength(0);
  });

  it("does not remove another user's rule via the predicate", async () => {
    await handleInteraction(component("wishlist:add", ["gear"]), () => client);
    const [rule] = await listRules(client, USER);

    // A component interaction from a different user attempting the same rule id.
    const other: Interaction = {
      id: "1",
      application_id: "app",
      type: InteractionType.MESSAGE_COMPONENT,
      token: "t",
      user: { id: "intruder" },
      data: { custom_id: "wishlist:remove", values: [String(rule!.id)] },
    };
    const res = await handleInteraction(other, () => client);
    expect(res.data?.content).toContain("already gone");
    expect(await listRules(client, USER)).toHaveLength(1);
  });
});
