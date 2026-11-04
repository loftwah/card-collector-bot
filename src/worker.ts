import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { handleDiscordInteraction } from "./server/discord/handler";
import type { DiscordEnv } from "./server/discord/types";
import { createScheduledRunner } from "./server/scheduled";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();
const scheduled = createScheduledRunner({ editorial: emdashScheduled });

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
    // Every maintenance step is isolated; the editorial handler still runs if
    // one maintenance task fails. See src/server/scheduled.ts.
    await scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler;
