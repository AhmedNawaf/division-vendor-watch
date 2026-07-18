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
  /** Open a modal. Not valid in response to MODAL_SUBMIT or PING — modals cannot chain. */
  MODAL = 9,
}

export enum MessageFlags {
  /** Only the invoking user can see the response. */
  EPHEMERAL = 1 << 6,
}

export enum ComponentType {
  ACTION_ROW = 1,
  BUTTON = 2,
  STRING_SELECT = 3,
  TEXT_INPUT = 4,
  /**
   * Modal layout wrapper (added 2025-08-25), carrying a label + optional description around one
   * nested component. Selects in modals must be wrapped in a Label; Action Row is deprecated
   * there. This is what makes a multi-section form possible at all.
   */
  LABEL = 18,
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
    /** MESSAGE_COMPONENT / MODAL_SUBMIT: the component's or modal's custom_id. */
    custom_id?: string;
    /** MESSAGE_COMPONENT (string select): chosen values. */
    values?: string[];
    /** MODAL_SUBMIT: the submitted components, one entry per Label. */
    components?: ModalSubmitComponent[];
  };
}

/**
 * A submitted modal component. Discord nests the answer inside the Label that wrapped it, so a
 * submission arrives as Label → { custom_id, values } rather than as a flat map.
 */
export interface ModalSubmitComponent {
  type: ComponentType;
  custom_id?: string;
  values?: string[];
  value?: string;
  /** Label wraps exactly one component; older Action Row payloads carry several. */
  component?: ModalSubmitComponent;
  components?: ModalSubmitComponent[];
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  /** Marks the option pre-selected when the modal opens — how we pre-fill from stored rules. */
  default?: boolean;
}

export interface ModalResponse {
  type: InteractionResponseType.MODAL;
  data: {
    custom_id: string;
    /** Max 45 characters. */
    title: string;
    /** Between 1 and 5 top-level components. */
    components: MessageComponent[];
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
    custom_id?: string;
    title?: string;
  };
}

/**
 * Flatten a MODAL_SUBMIT payload into custom_id → selected values.
 *
 * Discord nests each answer inside the Label that wrapped it, and older payloads use Action Row,
 * so walk the tree rather than assuming a shape.
 */
export function collectModalValues(
  components: ModalSubmitComponent[] | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (node: ModalSubmitComponent | undefined): void => {
    if (!node) return;
    if (node.custom_id && (node.values || node.value !== undefined)) {
      out.set(node.custom_id, node.values ?? (node.value ? [node.value] : []));
    }
    visit(node.component);
    for (const child of node.components ?? []) visit(child);
  };
  for (const node of components ?? []) visit(node);
  return out;
}

/** The interacting user's id, whether the interaction came from a DM or a guild. */
export function interactionUserId(interaction: Interaction): string | undefined {
  return interaction.user?.id ?? interaction.member?.user?.id;
}
