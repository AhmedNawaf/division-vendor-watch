/**
 * A minimal slice of the Discord interactions API — just the enums and shapes this bot uses.
 * Full reference: https://discord.com/developers/docs/interactions/receiving-and-responding
 */

export enum InteractionType {
  PING = 1,
  APPLICATION_COMMAND = 2,
  MESSAGE_COMPONENT = 3,
  APPLICATION_COMMAND_AUTOCOMPLETE = 4,
  MODAL_SUBMIT = 5,
}

export enum InteractionResponseType {
  PONG = 1,
  CHANNEL_MESSAGE_WITH_SOURCE = 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5,
  UPDATE_MESSAGE = 7,
}

export enum MessageFlags {
  /** Only the invoking user can see the response. */
  EPHEMERAL = 1 << 6,
}

export enum ComponentType {
  ACTION_ROW = 1,
  BUTTON = 2,
  STRING_SELECT = 3,
}

export enum ButtonStyle {
  PRIMARY = 1,
  SECONDARY = 2,
  SUCCESS = 3,
  DANGER = 4,
  LINK = 5,
}

export enum ApplicationCommandOptionType {
  SUB_COMMAND = 1,
  STRING = 3,
}

export interface CommandOption {
  name: string;
  type: ApplicationCommandOptionType;
  value?: string;
  options?: CommandOption[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: InteractionType;
  token: string;
  /** Present for guild interactions. */
  member?: { user?: { id: string } };
  /** Present for DM/user-install interactions. */
  user?: { id: string };
  data?: {
    name?: string;
    options?: CommandOption[];
    /** MESSAGE_COMPONENT: the component's custom_id. */
    custom_id?: string;
    /** MESSAGE_COMPONENT (string select): chosen values. */
    values?: string[];
  };
}

export interface MessageComponent {
  type: ComponentType;
  [key: string]: unknown;
}

export interface InteractionResponse {
  type: InteractionResponseType;
  data?: {
    content?: string;
    flags?: number;
    components?: MessageComponent[];
  };
}

/** The interacting user's id, whether the interaction came from a DM or a guild. */
export function interactionUserId(interaction: Interaction): string | undefined {
  return interaction.user?.id ?? interaction.member?.user?.id;
}
