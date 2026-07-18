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
  ruleScope,
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
export async function handleInteraction(
  interaction: Interaction,
  getClient: () => Client,
): Promise<InteractionResponse> {
  switch (interaction.type) {
    case InteractionType.PING:
      return { type: InteractionResponseType.PONG };
    case InteractionType.APPLICATION_COMMAND:
      return handleCommand(interaction, getClient());
    case InteractionType.MESSAGE_COMPONENT:
      return handleComponent(interaction, getClient());
    case InteractionType.MODAL_SUBMIT:
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
      return buildGearModal(await bareRules(client, userId), await loadStock(client));
    case "weapons":
      return buildWeaponsModal(await bareRules(client, userId), await loadStock(client));
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
async function loadStock(client: Client): Promise<StockIndex> {
  try {
    const cached = await getLatestVendorCache(client);
    return cached ? indexStock(cached.items) : EMPTY_STOCK;
  } catch {
    return EMPTY_STOCK;
  }
}

async function loadStockItems(client: Client): Promise<VendorItem[]> {
  try {
    return (await getLatestVendorCache(client))?.items ?? [];
  } catch {
    return [];
  }
}

async function handleComponent(
  interaction: Interaction,
  client: Client,
): Promise<InteractionResponse> {
  const userId = interactionUserId(interaction);
  if (!userId) return ephemeral("Could not identify your account.");

  switch (interaction.data?.custom_id) {
    case BUTTON_EDIT_GEAR:
      return buildGearModal(await bareRules(client, userId), await loadStock(client));
    case BUTTON_EDIT_WEAPONS:
      return buildWeaponsModal(await bareRules(client, userId), await loadStock(client));
    default:
      return updateEphemeral("That action is no longer available.");
  }
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
  const inScope = existing.filter((rule) => ruleScope(stripId(rule)) === scope);
  const { added, removed } = diffRules(inScope.map(stripId), desired);

  if (added.length > 0 || removed.length > 0) {
    await replaceRules(
      client,
      userId,
      inScope.map((rule) => rule.id),
      desired,
    );
  }

  const after = await listRules(client, userId);
  const preview = previewMatches(await loadStockItems(client), after.map(stripId));
  return ephemeral(summarize(scope, added, removed, rejected, after, preview));
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
  all: StoredRule[],
  preview: string[],
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

function rulesText(rules: StoredRule[]): string {
  if (rules.length === 0) {
    return [
      "**Your wishlist is empty.**",
      "",
      "Pick what you want to watch with the buttons below. After each Tuesday vendor reset,",
      "you'll get a DM listing anything in stock that matches.",
    ].join("\n");
  }

  const gear = rules.filter((r) => ruleScope(stripId(r)) === "gear");
  const weapons = rules.filter((r) => ruleScope(stripId(r)) === "weapons");
  const lines = [`**Your wishlist (${rules.length})**`];

  for (const [heading, group] of [
    ["🎽 Gear, sets & brands", gear],
    ["🔫 Weapons", weapons],
  ] as const) {
    if (group.length === 0) continue;
    lines.push("", heading);
    // Keep well inside Discord's 2000-character message limit.
    for (const rule of group.slice(0, 20)) lines.push(`• ${describeRule(stripId(rule))}`);
    if (group.length > 20) lines.push(`…and ${group.length - 20} more`);
  }
  return lines.join("\n");
}

function renderOverview(rules: StoredRule[]): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: MessageFlags.EPHEMERAL,
      content: rulesText(rules),
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

function ephemeral(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL, content },
  };
}

function updateEphemeral(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { flags: MessageFlags.EPHEMERAL, content, components: [] },
  };
}
