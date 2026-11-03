import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import {
  expireStaleDiscordInteractions,
  handleDiscordInteraction,
} from "./server/discord/handler";
import type { DiscordEnv } from "./server/discord/types";
import { runScheduledNpcProgression } from "./server/modules/npcs";
import { pruneMagicLinks, pruneRateLimits } from "./server/modules/magic-links";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

/**
 * A safe, public build identity for deployed read-back. It is the source SHA,
 * never a secret, and lets release evidence prove which build answered the
 * smoke request rather than inferring it from deployment metadata alone.
 */
function withBuildIdentity(response: Response, env: unknown): Response {
  const sha = (env as { FOILBURY_BUILD_SHA?: string }).FOILBURY_BUILD_SHA?.trim();
  if (!sha) return response;
  const headers = new Headers(response.headers);
  headers.set("x-foilbury-build", sha);
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/discord/interactions") {
      return withBuildIdentity(
        await handleDiscordInteraction(request, env as DiscordEnv, {
          waitUntil: (promise) => ctx.waitUntil(promise),
        }),
        env,
      );
    }
    return withBuildIdentity(await handler.fetch!(request as never, env as never, ctx), env);
  },
  scheduled: async (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => {
    // Bounded synthetic progression shares the existing cron. Failures are
    // logged and never block the editorial/scheduled-publication handler.
    try {
      const bindings = env as { DB: never; MEDIA: never };
      await pruneRateLimits(bindings.DB);
      await pruneMagicLinks(bindings.DB);
      await expireStaleDiscordInteractions(bindings.DB as unknown as DiscordEnv["DB"]);
      await runScheduledNpcProgression(
        bindings.DB,
        bindings.MEDIA,
        (await import("./server/config")).readConfig(env as never),
      );
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "Scheduled maintenance failed", error: String(error) }));
    }
    return emdashScheduled(controller, env as never, ctx);
  },
} satisfies ExportedHandler;
