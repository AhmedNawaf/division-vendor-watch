import { createClient, type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { addRule, initSchema, listRules, saveVendorCache } from "../../src/db/store.js";
import { parseVendorData } from "../../src/parser/parse-vendor-page.js";
import { rawFromFixtures } from "../helpers.js";
import { handleInteraction, resetStockCache } from "../../worker/src/interactions.js";
import {
  ComponentType,
  InteractionResponseType,
  InteractionType,
  type Interaction,
  type MessageComponent,
} from "../../worker/src/discord.js";
import { GEAR_MODAL_ID, WEAPONS_MODAL_ID } from "../../worker/src/wishlist-modal.js";
import { BRANDS, GEAR_SETS, WEAPONS, resolveWeapon } from "../../src/catalog/index.js";

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
    // The Worker memoizes stock across requests; clear it so cases stay independent.
    resetStockCache();
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
        geartype: ["gear"],
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
    await handleInteraction(submit(WEAPONS_MODAL_ID, { weapontype: ["named-weapons"] }), db);
    await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["gear"] }), db);

    const rules = await listRules(client, USER);
    expect(rules.some((r) => r.namedOnly === true)).toBe(true);
    expect(rules.some((r) => r.category === "gear" && !r.namedOnly)).toBe(true);
  });

  it("submitting an empty form clears that scope and reports it", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["gear"] }), db);
    const res = await handleInteraction(submit(GEAR_MODAL_ID, {}), db);

    expect(res.data?.content).toContain("removed 1");
    expect(await listRules(client, USER)).toHaveLength(0);
  });

  it("says nothing changed when a form is submitted untouched", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["gear"] }), db);
    const res = await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["gear"] }), db);

    expect(res.data?.content).toContain("No changes");
    expect(await listRules(client, USER)).toHaveLength(1);
  });

  it("ignores values that are not in the catalog instead of storing dead rules", async () => {
    const res = await handleInteraction(
      submit(GEAR_MODAL_ID, { "brand:0": ["Totally Made Up Brand"], geartype: ["gear"] }),
      db,
    );

    expect(res.data?.content).toContain("Ignored 1");
    const rules = await listRules(client, USER);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.category).toBe("gear");
  });

  it("offers no exotics anywhere — vendors never stock them", async () => {
    const exotics = new Set(WEAPONS.filter((w) => w.quality === "Exotic").map((w) => w.name));
    for (const sub of ["gear", "weapons"]) {
      const res = await handleInteraction(command(sub), db);
      const values = selects(res.data?.components).flatMap((s) =>
        ((s.options as Array<{ value: string }>) ?? []).map((o) => o.value),
      );
      expect(values.filter((v) => exotics.has(v))).toEqual([]);
      expect(values).not.toContain("exotic-weapons");
    }
  });

  it("refuses an exotic submitted directly, since it could never fire", async () => {
    const exotic = WEAPONS.find((w) => w.quality === "Exotic")!.name;
    const res = await handleInteraction(submit(WEAPONS_MODAL_ID, { "weapon:0": [exotic] }), db);
    expect(res.data?.content).toContain("Ignored 1");
    expect(await listRules(client, USER)).toHaveLength(0);
  });

  it("watches named gear, and keeps it in the gear form's scope", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["named-gear"] }), db);
    const rules = await listRules(client, USER);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.category).toBe("gear");
    expect(rules[0]!.namedOnly).toBe(true);

    // It must survive a weapons-form submit — namedOnly alone must not route it to weapons.
    await handleInteraction(submit(WEAPONS_MODAL_ID, {}), db);
    expect(await listRules(client, USER)).toHaveLength(1);
  });

  it("scopes edits to the invoking user", async () => {
    await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["gear"] }, "other-user"), db);
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

  it("keeps every response inside Discord's 2000-character limit", async () => {
    // Selecting everything is entirely reachable, and an over-long body is rejected outright —
    // which the user sees as "this interaction failed" with no clue why.
    const res = await handleInteraction(
      submit(GEAR_MODAL_ID, {
        geartype: ["gear", "gear-mod", "skill-mod", "named-gear"],
        "gearset:0": [...GEAR_SETS].slice(0, 25),
        "gearset:1": [...GEAR_SETS].slice(25),
        "brand:0": [...BRANDS].slice(0, 25),
        "brand:1": [...BRANDS].slice(25),
      }),
      db,
    );

    expect(await listRules(client, USER)).toHaveLength(GEAR_SETS.length + BRANDS.length + 4);
    expect(res.data?.content!.length).toBeLessThanOrEqual(2000);
  });

  it("keeps the overview inside the limit with a large wishlist", async () => {
    for (const brand of BRANDS) await addRule(client, USER, { brand, label: brand });
    const res = await handleInteraction(command("show"), db);
    expect(res.data?.content!.length).toBeLessThanOrEqual(2000);
  });

  describe("deferred submits", () => {
    it("acknowledges immediately and does the work afterwards", async () => {
      let work: (() => Promise<string>) | undefined;
      const res = await handleInteraction(
        submit(GEAR_MODAL_ID, { geartype: ["gear"] }),
        db,
        (w) => {
          work = w;
        },
      );

      // Discord gets an ack straight away — no database round trips inside the 3s budget.
      expect(res.type).toBe(InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE);
      expect(await listRules(client, USER)).toHaveLength(0);

      // ...and the real work runs after, producing the follow-up message.
      expect(work).toBeDefined();
      const content = await work!();
      expect(content).toContain("Saved");
      expect(await listRules(client, USER)).toHaveLength(1);
    });

    it("still applies the submit inline when no defer hook is supplied", async () => {
      const res = await handleInteraction(submit(GEAR_MODAL_ID, { geartype: ["gear"] }), db);
      expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
      expect(await listRules(client, USER)).toHaveLength(1);
    });

    it("only defers modal submits — commands must answer directly", async () => {
      let deferred = false;
      const res = await handleInteraction(command("gear"), db, () => {
        deferred = true;
      });
      // A modal cannot be deferred: it has to be the immediate response.
      expect(res.type).toBe(InteractionResponseType.MODAL);
      expect(deferred).toBe(false);
    });
  });

  it("degrades gracefully on an unknown component or form", async () => {
    expect((await handleInteraction(button("wishlist:gone"), db)).data?.content).toContain(
      "no longer available",
    );
    expect((await handleInteraction(submit("wishlist:modal:gone", {}), db)).data?.content).toContain(
      "no longer available",
    );
  });

  describe("form separation", () => {
    const valuesIn = async (sub: string, client: () => Client): Promise<string[]> => {
      const res = await handleInteraction(command(sub), client);
      return selects(res.data?.components).flatMap((s) =>
        ((s.options as Array<{ value: string }>) ?? []).map((o) => o.value),
      );
    };

    it("keeps weapons out of the gear form", async () => {
      // The gear form previously offered "All weapons", which made no sense in a form about gear.
      const values = await valuesIn("gear", db);
      expect(values).not.toContain("weapon");
      expect(values).not.toContain("named-weapons");
      expect(values).not.toContain("exotic-weapons");
    });

    it("keeps gear out of the weapons form", async () => {
      const values = await valuesIn("weapons", db);
      expect(values).not.toContain("gear");
      expect(values).not.toContain("gear-mod");
      expect(values).not.toContain("skill-mod");
    });

    it("routes an 'all weapons' rule to the weapons form's scope", async () => {
      await handleInteraction(submit(WEAPONS_MODAL_ID, { weapontype: ["weapon"] }), db);
      // Editing gear must not disturb it, even though it is a category rule.
      await handleInteraction(submit(GEAR_MODAL_ID, {}), db);
      const rules = await listRules(client, USER);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.category).toBe("weapon");
    });
  });

  describe("with this week's stock cached", () => {
    beforeEach(async () => {
      const { items } = parseVendorData(rawFromFixtures());
      await saveVendorCache(client, "2026-07-14", items);
    });

    it("leads with what is in stock and says how much", async () => {
      const res = await handleInteraction(command("gear"), db);
      const labels = (res.data?.components ?? []).map((c) => (c as { label?: string }).label ?? "");

      expect(labels[0]).toContain("in stock now");
      expect(labels[1]).toContain("not in stock");
    });

    it("labels options with where they can be bought", async () => {
      const res = await handleInteraction(command("gear"), db);
      const described = selects(res.data?.components)
        .flatMap((s) => (s.options as Array<{ description?: string }>) ?? [])
        .filter((o) => o.description?.includes("in stock"));

      expect(described.length).toBeGreaterThan(0);
      expect(described[0]!.description).toMatch(/\d+ in stock — /);
    });

    it("previews what a saved wishlist matches right now", async () => {
      const res = await handleInteraction(
        submit(WEAPONS_MODAL_ID, { weapontype: ["named-weapons"] }),
        db,
      );
      // Feedback beats a bare receipt — it proves the rule works before the user waits a week.
      expect(res.data?.content).toMatch(/\d+ in stock right now/);
    });

    it("says so plainly when a saved wishlist matches nothing yet", async () => {
      const res = await handleInteraction(
        submit(GEAR_MODAL_ID, { "gearset:1": [notInStockGearSet()] }),
        db,
      );
      expect(res.data?.content).toContain("Nothing in stock matches right now");
    });

    it("lists the named weapons actually at vendors this week", async () => {
      const res = await handleInteraction(command("weapons"), db);
      const labels = (res.data?.components ?? []).map((c) => (c as { label?: string }).label ?? "");
      expect(labels[0]).toContain("in stock now");

      // Feed names like "Pyromaniac - Police M4" must resolve to the catalog's "Pyromaniac",
      // or the section would always render empty.
      const first = selects(res.data?.components)[0]!;
      const values = (first.options as Array<{ value: string }>).map((o) => o.value);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((v) => WEAPONS.some((w) => w.name === v && w.quality === "Named"))).toBe(true);
    });

    it("never deletes watches the form ran out of room to display", async () => {
      // A select holds 25 options. Watch more absent weapons than that, so the form physically
      // cannot show them all — without the safeguard, submitting would wipe the overflow.
      const absent = WEAPONS.filter(
        (w) => w.quality === "Named" && !stockedWeaponNames().has(w.name),
      ).slice(0, 30);
      expect(absent.length).toBe(30);
      for (const w of absent) await addRule(client, USER, { itemName: w.name, label: w.name });

      const res = await handleInteraction(submit(WEAPONS_MODAL_ID, {}), db);

      // The 25 the form could show were cleared; the rest survive and are reported.
      const remaining = await listRules(client, USER);
      expect(remaining).toHaveLength(5);
      expect(res.data?.content).toMatch(/weren't shown in this form/);
    });

    it("shows watched-but-absent weapons so they can still be removed", async () => {
      const absent = WEAPONS.find(
        (w) => w.quality === "Named" && !stockedWeaponNames().has(w.name),
      )!.name;
      await addRule(client, USER, { itemName: absent, label: absent });

      const res = await handleInteraction(command("weapons"), db);
      const labels = (res.data?.components ?? []).map((c) => (c as { label?: string }).label ?? "");
      expect(labels.some((l) => l.includes("you're watching"))).toBe(true);

      // Deselecting it in that section removes it.
      await handleInteraction(submit(WEAPONS_MODAL_ID, { "weapon:1": [] }), db);
      expect(await listRules(client, USER)).toHaveLength(0);
    });
  });
});

/** Catalog-canonical weapon names the fixture week stocks. */
function stockedWeaponNames(): Set<string> {
  const { items } = parseVendorData(rawFromFixtures());
  const names = new Set<string>();
  for (const item of items) {
    if (item.category !== "weapon") continue;
    const hit = resolveWeapon(item.name);
    if (hit) names.add(hit.name);
  }
  return names;
}

/** A gear set the fixture week does not stock, for the empty-preview case. */
function notInStockGearSet(): string {
  const { items } = parseVendorData(rawFromFixtures());
  const stocked = new Set(items.map((i) => i.gearSet).filter(Boolean));
  const absent = GEAR_SETS.find((g) => !stocked.has(g));
  if (!absent) throw new Error("fixture stocks every gear set; pick another fixture");
  return absent;
}
