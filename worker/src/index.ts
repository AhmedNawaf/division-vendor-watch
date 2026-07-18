import type { Env } from "./env.js";
import type { Interaction } from "./discord.js";
import { handleInteraction } from "./interactions.js";
import { verifyInteractionSignature } from "./verify.js";
import { createWebClient } from "./web-client.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const signature = request.headers.get("X-Signature-Ed25519") ?? "";
    const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
    const body = await request.text();

    const valid = await verifyInteractionSignature(
      env.DISCORD_PUBLIC_KEY,
      signature,
      timestamp,
      body,
    );
    if (!valid) {
      return new Response("invalid request signature", { status: 401 });
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const response = await handleInteraction(interaction, () =>
      createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN),
    );
    return Response.json(response);
  },
};
