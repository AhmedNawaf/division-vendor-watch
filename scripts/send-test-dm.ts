/**
 * Live-fire check for the DM delivery path.
 *
 * Everything about DM sending is covered by tests with an injected fake, which validates our
 * retry/backoff logic but proves nothing about the real Discord API. This script exercises the
 * actual `sendDirectMessages` against production Discord, so the two things unit tests cannot
 * answer get answered: is the request shape right, and is the bot *allowed* to DM this user.
 *
 *   npm run dm:test -- <discord-user-id> ["optional message"]
 *
 * Reads DISCORD_BOT_TOKEN from the environment (.env is loaded by the npm script and is
 * gitignored). The token is never printed.
 */
import { sendDirectMessages } from "../src/discord/send-dm.js";
import { isAppError } from "../src/errors.js";

const API = "https://discord.com/api/v10";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Discord's numeric error code, dug out of the detail we now keep on 4xx failures. */
function discordCode(err: unknown): number | undefined {
  if (!isAppError(err) || typeof err.context !== "object" || err.context === null) return undefined;
  const detail = (err.context as Record<string, unknown>).detail;
  if (typeof detail !== "string") return undefined;
  try {
    const parsed = JSON.parse(detail) as { code?: number };
    return typeof parsed.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function explain(err: unknown): string {
  switch (discordCode(err)) {
    case 50007:
      return (
        "Discord refused to open a DM (code 50007). The bot may only DM a user who has\n" +
        "  installed the app to their account, or who shares a server with the bot — and the\n" +
        "  user's privacy settings must allow DMs. This is the architectural question: if it\n" +
        "  persists after a user-install, DM-first delivery needs a mutual-server requirement."
      );
    case 10013:
      return "Unknown user (code 10013) — the user id is wrong.";
    case 50035:
      return "Malformed request (code 50035) — the user id is not a valid snowflake.";
    default:
      return "See the detail above for Discord's own explanation.";
  }
}

async function main(): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    fail(
      "DISCORD_BOT_TOKEN is not set. Add it to .env (gitignored) as DISCORD_BOT_TOKEN=... " +
        "and re-run.",
    );
  }

  const userId = process.argv[2];
  if (!userId || !/^\d{5,}$/.test(userId)) {
    fail(
      "Pass your Discord user id: npm run dm:test -- <user-id>\n" +
        "  (Discord → Settings → Advanced → Developer Mode, then right-click your name → Copy User ID)",
    );
  }

  const message =
    process.argv[3] ??
    "✅ Division Vendor Watch — DM delivery test. If you can read this, the bot can reach you.";

  // Stage 1: prove the token itself works before blaming the DM path for an auth problem.
  console.log("1. Verifying the bot token …");
  const me = await fetch(`${API}/users/@me`, { headers: { authorization: `Bot ${botToken}` } });
  if (!me.ok) {
    fail(
      `Token check failed with HTTP ${me.status}. ` +
        (me.status === 401
          ? "The token is invalid or was reset — copy a fresh one from the Bot tab."
          : (await me.text()).slice(0, 300)),
    );
  }
  const bot = (await me.json()) as { username?: string; id?: string };
  console.log(`   ✓ Authenticated as ${bot.username} (id ${bot.id})`);

  // Stage 2: the real shipping code path.
  console.log(`2. Opening a DM channel and sending to ${userId} …`);
  try {
    await sendDirectMessages(userId, [message], { botToken });
    console.log("   ✓ Sent. Check your Discord DMs.");
    console.log("\nThe DM path works end to end against production Discord.");
  } catch (err) {
    console.error("   ✗ Delivery failed.");
    if (isAppError(err)) {
      console.error(`   ${err.code}: ${err.message}`);
      if (err.context) console.error(`   context: ${JSON.stringify(err.context)}`);
    } else if (err instanceof Error) {
      console.error(`   ${err.message}`);
    }
    console.error(`\n  ${explain(err)}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
