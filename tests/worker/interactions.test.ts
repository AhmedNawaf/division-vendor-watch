import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, initSchema, listRules } from "../../src/db/store.js";
import { handleInteraction } from "../../worker/src/interactions.js";
import {
  ComponentType,
  InteractionResponseType,
  InteractionType,
  type Interaction,
  type MessageComponent,
} from "../../worker/src/discord.js";
import { GEAR_MODAL_ID, WEAPONS_MODAL_ID } from "../../worker/src/wishlist-modal.js";
import { BRANDS, GEAR_SETS } from "../../src/catalog/index.js";

const USER = "1234567890";

function command(sub: string | undefined, userId = USER): Interaction {
  return {
    id: "i",
    application_id: "a",
    type: InteractionType.APPLICATION_COMMAND,
    token: "t",
    user: { id: userId },
    data: { name: "wishlist", options: sub ? [{ name: sub, type: 1 }] : [] },
  };
}

function button(customId: string, userId = USER): Interaction {
  return {
    id: "i",
    application_id: "a",
    type: InteractionType.MESSAGE_COMPONENT,
    token: "t",
    user: { id: userId },
    data: { custom_id: customId },
  };
}

/** A MODAL_SUBMIT payload: Discord nests each answer inside the Label that wrapped it. */
function submit(modalId: string, fields: Record<string, string[]>, userId = USER): Interaction {
  return {
    id: "i",
    application_id: "a",
    type: InteractionType.MODAL_SUBMIT,
    token: "t",
    user: { id: userId },
    data: {
      custom_id: modalId,
      components: Object.entries(fields).map(([custom_id, values]) => ({
        type: ComponentType.LABEL,
        component: { type: ComponentType.STRING_SELECT, custom_id, values },
      })),
    },
  };
}

/** Every string-select inside a modal response, flattened out of its Label wrapper. */
function selects(components: MessageComponent[] | undefined): Array<Record<string, unknown>> {
  return (components ?? []).map(
    (label) => ((label as { component?: Record<string, unknown> }).component ?? {}),
  );
}

describe("handleInteraction", () => {
  let client: Client;
  const db = (): Client => client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await initSchema(client);
  });

  it("answers PING with PONG without touching the database", async () => {
    const res = await handleInteraction(
      { id: "i", application_id: "a", type: InteractionType.PING, token: "t" },
      () => {
        throw new Error("PING must not construct a database client");
      },
    );
    expect(res.type).toBe(InteractionResponseType.PONG);
  });

  it("onboards a user with an empty wishlist rather than showing a bare empty list", async () => {
    const res = await handleInteraction(command("show"), db);
    expect(res.data?.content).toContain("wishlist is empty");
    expect(res.data?.content).toMatch(/Tuesday/);
    expect(res.data?.components).toHaveLength(1);
  });

  it("opens the gear modal with all five sections", async () => {
    const res = await handleInteraction(command("gear"), db);
    expect(res.type).toBe(InteractionResponseType.MODAL);
    expect(res.data?.custom_id).toBe(GEAR_MODAL_ID);
    // Categories + 2 gear-set pages + 2 brand pages, Discord's maximum.
    expect(res.data?.components).toHaveLength(5);
    expect(res.data?.title?.length ?? 0).toBeLessThanOrEqual(45);
  });

  it("keeps every modal select inside Discord's 25-option cap", async () => {
    for (const sub of ["gear", "weapons"]) {
      const res = await handleInteraction(command(sub), db);
      for (const select of selects(res.data?.components)) {
        expect((select.options as unknown[]).length).toBeLessThanOrEqual(25);
        expect(select.max_values as number).toBeLessThanOrEqual(25);
      }
    }
  });

  it("splits pages evenly rather than leaving a stub page", async () => {
    const res = await handleInteraction(command("gear"), db);
    const sizes = selects(res.data?.components).map((s) => (s.options as unknown[]).length);
    // 27 gear sets must not come out as 25 + 2.
    expect(sizes).not.toContain(2);
  });

  it("stores the rules a submitted gear form represents", async () => {
    const res = await handleInteraction(
      submit(GEAR_MODAL_ID, {
        categories: ["gear"],
        "gearset:0": [GEAR_SETS[0]!],
        "brand:0": [BRANDS[0]!],
      }),
      db,
    );

    expect(res.data?.content).toContain("Saved");
    const rules = await listRules(client, USER);
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.category ?? r.gearSet ?? r.brand).sort()).toEqual(
      ["gear", GEAR_SETS[0]!, BRANDS[0]!].sort(),
    );
  });

  it("pre-selects existing choices so the form doubles as the edit flow", async () => {
    await addRule(client, USER, { gearSet: GEAR_SETS[0]!, label: GEAR_SETS[0]! });

    const res = await handleInteraction(command("gear"), db);
    const chosen = selects(res.data?.components)
      .flatMap((s) => (s.options as Array<{ value: string; default?: boolean }>) ?? [])
      .filter((o) => o.default)
      .map((o) => o.value);

    expect(chosen).toEqual([GEAR_SETS[0]!]);
  });

  it("replaces the scope, so deselecting removes a rule", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { "brand:0": [BRANDS[0]!, BRANDS[1]!] }), db);
    expect(await listRules(client, USER)).toHaveLength(2);

    // Re-submit with only one brand still selected.
    await handleInteraction(submit(GEAR_MODAL_ID, { "brand:0": [BRANDS[0]!] }), db);
    const rules = await listRules(client, USER);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.brand).toBe(BRANDS[0]!);
  });

  it("leaves the other form's rules alone — editing gear must not wipe weapons", async () => {
    await handleInteraction(submit(WEAPONS_MODAL_ID, { quick: ["named-weapons"] }), db);
    await handleInteraction(submit(GEAR_MODAL_ID, { categories: ["gear"] }), db);

    const rules = await listRules(client, USER);
    expect(rules.some((r) => r.namedOnly === true)).toBe(true);
    expect(rules.some((r) => r.category === "gear" && !r.namedOnly)).toBe(true);
  });

  it("submitting an empty form clears that scope and reports it", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { categories: ["gear"] }), db);
    const res = await handleInteraction(submit(GEAR_MODAL_ID, {}), db);

    expect(res.data?.content).toContain("removed 1");
    expect(await listRules(client, USER)).toHaveLength(0);
  });

  it("says nothing changed when a form is submitted untouched", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { categories: ["gear"] }), db);
    const res = await handleInteraction(submit(GEAR_MODAL_ID, { categories: ["gear"] }), db);

    expect(res.data?.content).toContain("No changes");
    expect(await listRules(client, USER)).toHaveLength(1);
  });

  it("ignores values that are not in the catalog instead of storing dead rules", async () => {
    const res = await handleInteraction(
      submit(GEAR_MODAL_ID, { "brand:0": ["Totally Made Up Brand"], categories: ["gear"] }),
      db,
    );

    expect(res.data?.content).toContain("Ignored 1");
    const rules = await listRules(client, USER);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.category).toBe("gear");
  });

  it("expands the 'any exotic' quick pick into per-weapon rules", async () => {
    const res = await handleInteraction(submit(WEAPONS_MODAL_ID, { quick: ["exotic-weapons"] }), db);
    expect(res.data?.content).toContain("Saved");
    const rules = await listRules(client, USER);
    expect(rules.length).toBeGreaterThan(20);
    expect(rules.every((r) => r.itemName)).toBe(true);
  });

  it("scopes edits to the invoking user", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { categories: ["gear"] }, "other-user"), db);
    await handleInteraction(submit(GEAR_MODAL_ID, {}), db); // USER clears their (empty) scope

    expect(await listRules(client, "other-user")).toHaveLength(1);
    expect(await listRules(client, USER)).toHaveLength(0);
  });

  it("opens the right modal from each edit button", async () => {
    expect((await handleInteraction(button("wishlist:edit:gear"), db)).data?.custom_id).toBe(
      GEAR_MODAL_ID,
    );
    expect((await handleInteraction(button("wishlist:edit:weapons"), db)).data?.custom_id).toBe(
      WEAPONS_MODAL_ID,
    );
  });

  it("degrades gracefully on an unknown component or form", async () => {
    expect((await handleInteraction(button("wishlist:gone"), db)).data?.content).toContain(
      "no longer available",
    );
    expect((await handleInteraction(submit("wishlist:modal:gone", {}), db)).data?.content).toContain(
      "no longer available",
    );
  });
});
