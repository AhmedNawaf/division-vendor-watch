import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InteractionType } from "../src/discord.js";

/**
 * Local test harness for the interactions Worker. Discord signs every request with Ed25519, so
 * you cannot just curl `wrangler dev` — this script holds a keypair, signs a fabricated
 * interaction, and POSTs it the same way Discord would.
 *
 * First run generates a keypair and prints the public key to put in `worker/.dev.vars` as
 * DISCORD_PUBLIC_KEY. It also self-verifies each signature offline, so `ping` proves the crypto
 * path even with no server running.
 *
 * Usage (from worker/):
 *   npm run local -- ping                     # no DB touched — works fully offline
 *   npm run local -- add-menu   --user 123    # /wishlist add  (shows the select menu)
 *   npm run local -- add named-weapons --user 123
 *   npm run local -- list       --user 123
 *   npm run local -- remove-menu --user 123
 *   npm run local -- remove 1   --user 123
 *   npm run local -- ping --url http://localhost:8787
 */

const KEYS_PATH = fileURLToPath(new URL("../.local-keys.json", import.meta.url));

interface StoredKeys {
  privatePem: string;
  publicHex: string;
}

function loadOrCreateKeys(): { privateKey: KeyObject; publicHex: string; created: boolean } {
  if (existsSync(KEYS_PATH)) {
    const stored = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as StoredKeys;
    return {
      privateKey: createPrivateKey(stored.privatePem),
      publicHex: stored.publicHex,
      created: false,
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // Ed25519 SPKI DER is a 12-byte header + the raw 32-byte key; Discord expects the raw key.
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicHex = Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
  const stored: StoredKeys = { privatePem, publicHex };
  writeFileSync(KEYS_PATH, JSON.stringify(stored, null, 2));
  return { privateKey, publicHex, created: true };
}

function parseArgs(argv: string[]): {
  action: string;
  arg?: string;
  user: string;
  url: string;
} {
  const positionals: string[] = [];
  let user = "local-test-user";
  let url = "http://localhost:8787";
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--user") user = argv[++i] ?? user;
    else if (token === "--url") url = argv[++i] ?? url;
    else if (token) positionals.push(token);
  }
  return { action: positionals[0] ?? "ping", arg: positionals[1], user, url };
}

function buildInteraction(action: string, arg: string | undefined, user: string): unknown {
  const base = { id: "local", application_id: "local", token: "local-token" };
  switch (action) {
    case "ping":
      return { ...base, type: InteractionType.PING };
    case "list":
    case "add-menu":
    case "remove-menu": {
      const sub = action === "add-menu" ? "add" : action === "remove-menu" ? "remove" : "list";
      return {
        ...base,
        type: InteractionType.APPLICATION_COMMAND,
        user: { id: user },
        data: { name: "wishlist", options: [{ name: sub, type: 1 }] },
      };
    }
    case "add":
      return {
        ...base,
        type: InteractionType.MESSAGE_COMPONENT,
        user: { id: user },
        data: { custom_id: "wishlist:add", values: [arg ?? "named-weapons"] },
      };
    case "remove":
      return {
        ...base,
        type: InteractionType.MESSAGE_COMPONENT,
        user: { id: user },
        data: { custom_id: "wishlist:remove", values: [arg ?? "1"] },
      };
    default:
      throw new Error(`Unknown action "${action}".`);
  }
}

async function main(): Promise<void> {
  const { privateKey, publicHex, created } = loadOrCreateKeys();
  if (created) {
    console.log("Generated a local Ed25519 keypair (worker/.local-keys.json).");
  }
  console.log("Put this in worker/.dev.vars (then restart `wrangler dev`):");
  console.log(`DISCORD_PUBLIC_KEY="${publicHex}"\n`);

  const { action, arg, user, url } = parseArgs(process.argv.slice(2));
  const body = JSON.stringify(buildInteraction(action, arg, user));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = Buffer.from(timestamp + body);
  const signature = sign(null, message, privateKey).toString("hex");

  // Offline sanity check — the same math the Worker's verify.ts runs.
  const publicKey = createPublicKey(privateKey);
  const selfOk = verify(null, message, publicKey, Buffer.from(signature, "hex"));
  console.log(`signature self-check: ${selfOk ? "ok" : "FAILED"}`);
  console.log(`action: ${action}${arg ? ` ${arg}` : ""}  →  POST ${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
  } catch (err) {
    console.error(
      `\nCould not reach ${url} — is \`wrangler dev\` running?\n` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  }

  const text = await res.text();
  console.log(`\nHTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
