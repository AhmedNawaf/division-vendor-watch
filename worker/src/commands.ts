import { ApplicationCommandOptionType } from "./discord.js";

/**
 * The bot's slash commands, as registered with Discord. Defined here so the register script and
 * (potential) tests share one source of truth.
 *
 * `integration_types: [1]` = USER_INSTALL (installed to a user, usable anywhere).
 * `contexts: [0, 1, 2]` = GUILD, BOT_DM, PRIVATE_CHANNEL.
 */
export const COMMANDS = [
  {
    name: "wishlist",
    description: "Manage the vendor items you want to be alerted about",
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: "list",
        description: "Show your current watch rules",
        type: ApplicationCommandOptionType.SUB_COMMAND,
      },
      {
        name: "add",
        description: "Add a watch rule by picking from a menu",
        type: ApplicationCommandOptionType.SUB_COMMAND,
      },
      {
        name: "remove",
        description: "Remove one of your watch rules",
        type: ApplicationCommandOptionType.SUB_COMMAND,
      },
    ],
  },
] as const;
