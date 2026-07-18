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
        name: "show",
        description: "Show your wishlist and edit it",
        type: ApplicationCommandOptionType.SUB_COMMAND,
      },
      {
        name: "gear",
        description: "Pick gear categories, gear sets and brands to watch",
        type: ApplicationCommandOptionType.SUB_COMMAND,
      },
      {
        name: "weapons",
        description: "Pick weapons to watch",
        type: ApplicationCommandOptionType.SUB_COMMAND,
      },
    ],
  },
] as const;
