import { COMMANDS } from "../src/commands.js";

/**
 * Register (overwrite) the bot's global slash commands with Discord.
 * Run with: `DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… npm run register`
 *
 * A bulk PUT replaces the full global command set, so this is idempotent. Global commands can
 * take a few minutes to propagate.
 */
async function main(): Promise<void> {
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !token) {
    throw new Error("Set DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment.");
  }

  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Registration failed (${res.status}): ${detail}`);
  }

  const registered = (await res.json()) as Array<{ name: string }>;
  console.log(`Registered ${registered.length} command(s): ${registered.map((c) => c.name).join(", ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
