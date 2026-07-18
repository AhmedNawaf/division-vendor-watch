import type { Env } from "./env.js";
import type { Interaction } from "./discord.js";
import { handleInteraction } from "./interactions.js";
import { verifyInteractionSignature } from "./verify.js";
import { createWebClient } from "./web-client.js";
import { writeDebug } from "../../src/db/store.js";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Replace the placeholder shown by a deferred response with the real result.
 *
 * The interaction token authenticates this, so no bot token is involved. It is valid for 15
 * minutes, which is ample: the work it is waiting on takes seconds.
 */
async function editDeferredReply(
  applicationId: string,
  token: string,
  content: string,
): Promise<string> {
  const res = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (res.ok) return "ok";
  const detail = `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`;
  console.error(`follow-up edit failed: ${detail}`);
  return detail;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const signature = request.headers.get("X-Signature-Ed25519") ?? "";
    const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
    const body = await request.text();

    // Peek at the type before verifying, for diagnostics only — nothing here is trusted, and a
    // failed signature still rejects below. Without this, a rejected request left no trace at
    // all, making "Discord never sent it" indistinguishable from "we refused it".
    let peekType = "?";
    let peekId = "-";
    try {
      const peek = JSON.parse(body) as Interaction;
      peekType = String(peek.type);
      peekId = peek.data?.custom_id ?? peek.data?.name ?? "-";
    } catch {
      peekType = "unparseable";
    }

    const valid = await verifyInteractionSignature(
      env.DISCORD_PUBLIC_KEY,
      signature,
      timestamp,
      body,
    );
    if (!valid) {
      console.error(`REJECTED unverified type=${peekType} id=${peekId} bodyBytes=${body.length}`);
      ctx.waitUntil(
        writeDebug(
          createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN),
          "signature-rejected",
          `type=${peekType} id=${peekId} bodyBytes=${body.length} sigLen=${signature.length} tsLen=${timestamp.length}`,
        ),
      );
      return new Response("invalid request signature", { status: 401 });
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      ctx.waitUntil(
        writeDebug(
          createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN),
          "bad-json",
          `bodyBytes=${body.length}`,
        ),
      );
      return new Response("bad request", { status: 400 });
    }

    // Discord abandons an interaction after 3 seconds and shows the user a failure, while the
    // Worker carries on and still logs a healthy 200 — so a slow response is indistinguishable
    // from a good one without timing. Log it, and flag anything close to the limit.
    const started = Date.now();
    const label = `type=${interaction.type} id=${interaction.data?.custom_id ?? interaction.data?.name ?? "-"}`;

    try {
      let followUp: (() => Promise<string>) | undefined;
      const response = await handleInteraction(
        interaction,
        () => createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN),
        (work) => {
          followUp = work;
        },
      );

      if (followUp) {
        const work = followUp;
        // Runs after the response is sent; the request is not held open for it.
        ctx.waitUntil(
          (async () => {
            const deferStarted = Date.now();
            const debugClient = createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
            try {
              const content = await work();
              const workMs = Date.now() - deferStarted;
              const edit = await editDeferredReply(
                interaction.application_id,
                interaction.token,
                content,
              );
              console.log(`${label} follow-up done in ${workMs}ms, edit=${edit}`);
              await writeDebug(
                debugClient,
                "follow-up",
                `${label} work=${workMs}ms edit=${edit} content=${content.length}b`,
              );
            } catch (err) {
              const detail =
                err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
              console.error(`${label} follow-up FAILED after ${Date.now() - deferStarted}ms: ${detail}`);
              await writeDebug(debugClient, "follow-up-error", `${label} ${detail}`);
              await editDeferredReply(
                interaction.application_id,
                interaction.token,
                "Something went wrong saving that. Please try again.",
              );
            }
          })(),
        );
      }

      const json = JSON.stringify(response);
      const elapsed = Date.now() - started;
      console.log(
        `${label} -> ${response.type} in ${elapsed}ms, ${json.length}b` +
          (elapsed > 2500 ? "  ⚠ OVER DISCORD'S 3s BUDGET" : ""),
      );
      // Persist the same line: waitUntil runs after the response, so this costs no latency, and
      // unlike `wrangler tail` it is still there to read afterwards.
      ctx.waitUntil(
        writeDebug(
          createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN),
          "interaction",
          `${label} -> ${response.type} in ${elapsed}ms, ${json.length}b deferred=${Boolean(followUp)}`,
        ),
      );
      return new Response(json, { headers: { "content-type": "application/json" } });
    } catch (err) {
      const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      console.error(`${label} FAILED after ${Date.now() - started}ms: ${detail}`);
      // Persist it too — an exception here previously left no trace at all, which made it
      // impossible to tell "the interaction never arrived" from "it arrived and threw".
      ctx.waitUntil(
        writeDebug(
          createWebClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN),
          "error",
          `${label} after ${Date.now() - started}ms: ${detail}`,
        ),
      );
      return Response.json({
        type: 4,
        data: { flags: 64, content: "Something went wrong handling that. Please try again." },
      });
    }
  },
};
