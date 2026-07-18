import type { Client } from "@libsql/client";
import { getLatestVendorCache, listRules, replaceRules, type StoredRule } from "../../src/db/store.js";
import type { WatchRule } from "../../src/config/watchlist-schema.js";
import { matchItems } from "../../src/matcher/match-items.js";
import type { VendorItem } from "../../src/types/vendor.js";
import { EMPTY_STOCK, indexStock, type StockIndex } from "./stock.js";
import {
  ButtonStyle,
  collectModalValues,
  ComponentType,
  type Interaction,
  type InteractionResponse,
  InteractionResponseType,
  InteractionType,
  interactionUserId,
  MessageFlags,
  type MessageComponent,
} from "./discord.js";
import {
  buildGearModal,
  buildWeaponsModal,
  diffRules,
  GEAR_MODAL_ID,
  parseSubmission,
  renderedValues,
  ruleScope,
  ruleValue,
  WEAPONS_MODAL_ID,
  type ModalScope,
} from "./wishlist-modal.js";

const BUTTON_EDIT_GEAR = "wishlist:edit:gear";
const BUTTON_EDIT_WEAPONS = "wishlist:edit:weapons";

/**
 * Route a verified interaction to the right handler. `getClient` is called only when a handler
 * actually needs the database — PING must answer without touching Turso (and as fast as possible),
 * so its client is never constructed.
 */
/**
 * Schedules work to finish after the interaction has already been acknowledged.
 *
 * Discord allows 3 seconds. A round trip to Turso measures ~0.8–1.2s from the edge, and applying
 * a submitted form needs three of them (read rules, read ~95KB of stock, write the batch), so the
 * work simply does not fit. Deferring acknowledges immediately and edits the message when the
 * work is done, which removes the deadline instead of racing it.
 */
export type Defer = (work: () => Promise<string>) => void;

export async function handleInteraction(
  interaction: Interaction,
  getClient: () => Client,
  defer?: Defer,
): Promise<InteractionResponse> {
  switch (interaction.type) {
    case InteractionType.PING:
      return { type: InteractionResponseType.PONG };
    case InteractionType.APPLICATION_COMMAND:
      return handleCommand(interaction, getClient());
    case InteractionType.MESSAGE_COMPONENT:
      return handleComponent(interaction, getClient());
    case InteractionType.MODAL_SUBMIT:
      if (defer) {
        // Capture the client lazily so the deferred work opens its own connection.
        defer(async () => {
          const result = await handleModalSubmit(interaction, getClient());
          return result.data?.content ?? "Saved.";
        });
        return {
          type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: MessageFlags.EPHEMERAL },
        };
      }
      // Without a defer hook (tests, and as a fallback) do the work inline.
      return handleModalSubmit(interaction, getClient());
    default:
      return ephemeral("Unsupported interaction.");
  }
}

async function handleCommand(
  interaction: Interaction,
  client: Client,
): Promise<InteractionResponse> {
  const userId = interactionUserId(interaction);
  if (!userId) return ephemeral("Could not identify your account.");

  if (interaction.data?.name !== "wishlist") return ephemeral("Unknown command.");

  const sub = interaction.data.options?.[0]?.name;
  switch (sub) {
    case "gear":
    case "weapons": {
      // Run both reads at once. Sequentially these are ~1.2s + ~1.5s, which alone consumed the
      // 3-second budget and left Discord treating the interaction as expired — so the modal
      // opened but submitting it failed.
      const [rules, stock] = await Promise.all([bareRules(client, userId), loadStock(client)]);
      return sub === "gear" ? buildGearModal(rules, stock.index) : buildWeaponsModal(rules, stock.index);
    }
    case undefined:
    case "show":
      return renderOverview(await listRules(client, userId));
    default:
      return ephemeral("Unknown subcommand.");
  }
}

/**
 * This week's stock, used to label options with what is actually available.
 *
 * Read straight from the cache rather than a precomputed summary so the counts shown in the form
 * come from the same items the matcher will evaluate — a separate summary could drift. Never
 * throws: a form with no stock labels is far better than a form that fails to open.
 */
interface CachedStock {
  index: StockIndex;
  items: VendorItem[];
}

const NO_STOCK: CachedStock = { index: EMPTY_STOCK, items: [] };

/**
 * Stock held in isolate memory between requests.
 *
 * Reading it costs ~1.5s — it is ~95KB and the database is far from the edge — while a modal must
 * be returned inside Discord's 3-second limit and, unlike a message, cannot be deferred. Vendor
 * stock only changes once a week, so re-reading it per interaction buys nothing. A cold isolate
 * pays the cost once; everything after is free.
 */
let stockMemo: { at: number; value: CachedStock } | undefined;
const STOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Drop the memo. Isolate-level state persists between requests, which is the point in production
 * but makes tests order-dependent — one case's stock would leak into the next.
 */
export function resetStockCache(): void {
  stockMemo = undefined;
}

async function loadStock(client: Client): Promise<CachedStock> {
  if (stockMemo && Date.now() - stockMemo.at < STOCK_TTL_MS) return stockMemo.value;
  try {
    const cached = await getLatestVendorCache(client);
    const value = cached ? { index: indexStock(cached.items), items: cached.items } : NO_STOCK;
    stockMemo = { at: Date.now(), value };
    return value;
  } catch {
    // Never fail an interaction over decoration: a form without stock labels still works.
    return stockMemo?.value ?? NO_STOCK;
  }
}

async function handleComponent(
  interaction: Interaction,
  client: Client,
): Promise<InteractionResponse> {
  const userId = interactionUserId(interaction);
  if (!userId) return ephemeral("Could not identify your account.");

  const custom = interaction.data?.custom_id;
  if (custom === BUTTON_EDIT_GEAR || custom === BUTTON_EDIT_WEAPONS) {
    const [rules, stock] = await Promise.all([bareRules(client, userId), loadStock(client)]);
    return custom === BUTTON_EDIT_GEAR
      ? buildGearModal(rules, stock.index)
      : buildWeaponsModal(rules, stock.index);
  }
  return updateEphemeral("That action is no longer available.");
}

/**
 * Apply a submitted form. Each modal owns a scope and replaces it wholesale, so what the form
 * showed is exactly what ends up stored — no merge semantics to reason about, and editing gear
 * can never disturb weapon picks.
 */
async function handleModalSubmit(
  interaction: Interaction,
  client: Client,
): Promise<InteractionResponse> {
  const userId = interactionUserId(interaction);
  if (!userId) return ephemeral("Could not identify your account.");

  const scope: ModalScope | undefined =
    interaction.data?.custom_id === GEAR_MODAL_ID
      ? "gear"
      : interaction.data?.custom_id === WEAPONS_MODAL_ID
        ? "weapons"
        : undefined;
  if (!scope) return ephemeral("That form is no longer available.");

  const submitted = collectModalValues(interaction.data?.components);
  const { rules: desired, rejected } = parseSubmission(scope, submitted);

  const existing = await listRules(client, userId);
  const stock = await loadStock(client);
  const inScope = existing.filter((rule) => ruleScope(stripId(rule)) === scope);
  const outOfScope = existing.filter((rule) => ruleScope(stripId(rule)) !== scope);

  // A form may only remove what it could actually display. The weapons form shows a slice of 101
  // named weapons, so without this a submit would silently delete every watch it left out.
  const shown = renderedValues(scope, inScope.map(stripId), stock.index);
  const editable = inScope.filter((rule) => shown.has(ruleValue(stripId(rule))));
  const withheldRules = inScope.filter((rule) => !shown.has(ruleValue(stripId(rule))));

  const { added, removed } = diffRules(editable.map(stripId), desired);

  if (added.length > 0 || removed.length > 0) {
    await replaceRules(
      client,
      userId,
      editable.map((rule) => rule.id),
      desired,
    );
  }

  // Derive the resulting wishlist locally rather than re-querying: we know exactly what was
  // replaced, and a round trip here is one we cannot afford inside the 3-second budget.
  const after: WatchRule[] = [
    ...outOfScope.map(stripId),
    ...withheldRules.map(stripId),
    ...desired,
  ];
  const preview = previewMatches(stock.items, after);
  return ephemeral(
    summarize(scope, added, removed, rejected, after, preview, withheldRules.length),
  );
}

/**
 * What the user's rules would alert on right now, using the real matcher so the preview cannot
 * disagree with what actually gets delivered on Tuesday.
 */
function previewMatches(items: VendorItem[], rules: WatchRule[]): string[] {
  if (items.length === 0 || rules.length === 0) return [];
  return matchItems(items, { rules: rules as [WatchRule, ...WatchRule[]] }).map(
    (m) => `${m.item.name} — ${m.item.vendor}`,
  );
}

function summarize(
  scope: ModalScope,
  added: WatchRule[],
  removed: WatchRule[],
  rejected: string[],
  all: readonly WatchRule[],
  preview: string[],
  withheld: number,
): string {
  const lines: string[] = [];
  if (added.length === 0 && removed.length === 0) {
    lines.push(`No changes to your ${scope} watches.`);
  } else {
    const parts: string[] = [];
    if (added.length > 0) parts.push(`added ${added.length}`);
    if (removed.length > 0) parts.push(`removed ${removed.length}`);
    lines.push(`✅ Saved — ${parts.join(", ")}.`);
  }
  if (withheld > 0) {
    // Say so explicitly: silently keeping rules would be as confusing as silently dropping them.
    lines.push(`(${withheld} watch(es) weren't shown in this form and were left unchanged.)`);
  }
  if (rejected.length > 0) {
    lines.push(`⚠️ Ignored ${rejected.length} unrecognised value(s): ${rejected.slice(0, 5).join(", ")}`);
  }

  // Immediate feedback beats a bare receipt: it shows the rules actually work, and catches a
  // watchlist that matches nothing (or far too much) before the user waits a week to find out.
  if (all.length > 0) {
    if (preview.length === 0) {
      lines.push("", "Nothing in stock matches right now — you'll be DMed when something does.");
    } else {
      lines.push("", `**${preview.length} in stock right now:**`);
      for (const line of preview.slice(0, 8)) lines.push(`• ${line}`);
      if (preview.length > 8) lines.push(`…and ${preview.length - 8} more`);
    }
  }

  lines.push("", rulesText(all));
  return lines.join("\n");
}

/** Rules without their database ids, which is what the matcher and form builders work with. */
async function bareRules(client: Client, userId: string): Promise<WatchRule[]> {
  return (await listRules(client, userId)).map(stripId);
}

function stripId(rule: StoredRule): WatchRule {
  const { id: _id, ...bare } = rule;
  return bare as WatchRule;
}

function describeRule(rule: WatchRule): string {
  if (rule.label) return rule.label;
  const parts: string[] = [];
  if (rule.namedOnly) parts.push("named");
  if (rule.category) parts.push(rule.category);
  if (rule.brand) parts.push(`brand: ${rule.brand}`);
  if (rule.gearSet) parts.push(`set: ${rule.gearSet}`);
  if (rule.talent) parts.push(`talent: ${rule.talent}`);
  if (rule.itemName) parts.push(`"${rule.itemName}"`);
  return parts.length > 0 ? parts.join(" ") : "any item";
}

function rulesText(rules: readonly WatchRule[]): string {
  if (rules.length === 0) {
    return [
      "**Your wishlist is empty.**",
      "",
      "Pick what you want to watch with the buttons below. After each Tuesday vendor reset,",
      "you'll get a DM listing anything in stock that matches.",
    ].join("\n");
  }

  const gear = rules.filter((r) => ruleScope(r) === "gear");
  const weapons = rules.filter((r) => ruleScope(r) === "weapons");
  const lines = [`**Your wishlist (${rules.length})**`];

  for (const [heading, group] of [
    ["🎽 Gear, sets & brands", gear],
    ["🔫 Weapons", weapons],
  ] as const) {
    if (group.length === 0) continue;
    lines.push("", heading);
    // Listing every rule can blow Discord's 2000-character limit, and an over-long body is
    // rejected outright — which surfaces to the user as "this interaction failed".
    for (const rule of group.slice(0, 12)) lines.push(`• ${describeRule(rule)}`);
    if (group.length > 12) lines.push(`…and ${group.length - 12} more`);
  }
  return lines.join("\n");
}

function renderOverview(rules: readonly WatchRule[]): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: MessageFlags.EPHEMERAL,
      content: clamp(rulesText(rules)),
      components: [editButtons()],
    },
  };
}

function editButtons(): MessageComponent {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.PRIMARY,
        custom_id: BUTTON_EDIT_GEAR,
        label: "Edit gear, sets & brands",
      },
      {
        type: ComponentType.BUTTON,
        style: ButtonStyle.PRIMARY,
        custom_id: BUTTON_EDIT_WEAPONS,
        label: "Edit weapons",
      },
    ],
  };
}

/** Discord rejects a message over this, and rejection surfaces as "this interaction failed". */
const MAX_CONTENT = 2000;

function clamp(content: string): string {
  if (content.length <= MAX_CONTENT) return content;
  const notice = "\n…truncated";
  return `${content.slice(0, MAX_CONTENT - notice.length)}${notice}`;
}

function ephemeral(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL, content: clamp(content) },
  };
}

function updateEphemeral(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { flags: MessageFlags.EPHEMERAL, content: clamp(content), components: [] },
  };
}
