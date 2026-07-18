import type { Client } from "@libsql/client";
import { addRule, listRules, removeRule, type StoredRule } from "../../src/db/store.js";
import {
  ComponentType,
  type Interaction,
  type InteractionResponse,
  InteractionResponseType,
  InteractionType,
  interactionUserId,
  MessageFlags,
  type MessageComponent,
} from "./discord.js";
import { presetByKey, RULE_PRESETS } from "./presets.js";

const ADD_SELECT_ID = "wishlist:add";
const REMOVE_SELECT_ID = "wishlist:remove";

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
    case "list":
      return renderList(await listRules(client, userId));
    case "add":
      return renderAddMenu();
    case "remove":
      return renderRemoveMenu(await listRules(client, userId));
    default:
      return ephemeral("Unknown subcommand.");
  }
}

async function handleComponent(
  interaction: Interaction,
  client: Client,
): Promise<InteractionResponse> {
  const userId = interactionUserId(interaction);
  if (!userId) return ephemeral("Could not identify your account.");

  const customId = interaction.data?.custom_id;
  const values = interaction.data?.values ?? [];

  if (customId === ADD_SELECT_ID) {
    const preset = values[0] ? presetByKey(values[0]) : undefined;
    if (!preset) return updateEphemeral("That option is no longer available.");
    await addRule(client, userId, preset.rule);
    const rules = await listRules(client, userId);
    return updateList(`Added **${preset.label}** to your wishlist.`, rules);
  }

  if (customId === REMOVE_SELECT_ID) {
    const ruleId = Number(values[0]);
    const removed = Number.isFinite(ruleId) && (await removeRule(client, userId, ruleId));
    const rules = await listRules(client, userId);
    const note = removed ? "Removed that rule." : "That rule was already gone.";
    return updateList(note, rules);
  }

  return updateEphemeral("Unknown action.");
}

function describeRule(rule: StoredRule): string {
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
    return "Your wishlist is empty. Use `/wishlist add` to start watching items.";
  }
  const lines = rules.map((rule) => `• ${describeRule(rule)}`);
  return `**Your watch rules (${rules.length}):**\n${lines.join("\n")}`;
}

function renderList(rules: StoredRule[]): InteractionResponse {
  return ephemeral(rulesText(rules));
}

function renderAddMenu(): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: MessageFlags.EPHEMERAL,
      content: "Pick a rule to add to your wishlist:",
      components: [selectRow(ADD_SELECT_ID, "Choose an item type…", presetOptions())],
    },
  };
}

function renderRemoveMenu(rules: StoredRule[]): InteractionResponse {
  if (rules.length === 0) return ephemeral("You have no rules to remove.");
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: MessageFlags.EPHEMERAL,
      content: "Pick a rule to remove:",
      components: [selectRow(REMOVE_SELECT_ID, "Choose a rule to remove…", removeOptions(rules))],
    },
  };
}

function updateList(note: string, rules: StoredRule[]): InteractionResponse {
  return {
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: { flags: MessageFlags.EPHEMERAL, content: `${note}\n\n${rulesText(rules)}`, components: [] },
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

interface SelectOption {
  label: string;
  value: string;
  description?: string;
}

function presetOptions(): SelectOption[] {
  return RULE_PRESETS.map((preset) => ({
    label: preset.label,
    value: preset.key,
    description: preset.description,
  }));
}

function removeOptions(rules: StoredRule[]): SelectOption[] {
  // Discord caps a string select at 25 options.
  return rules.slice(0, 25).map((rule) => ({
    label: describeRule(rule).slice(0, 100),
    value: String(rule.id),
  }));
}

function selectRow(
  customId: string,
  placeholder: string,
  options: SelectOption[],
): MessageComponent {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.STRING_SELECT,
        custom_id: customId,
        placeholder,
        options,
      },
    ],
  };
}
