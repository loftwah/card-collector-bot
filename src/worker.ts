import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { handleDiscordInteraction } from "./server/discord/handler";
import type { DiscordEnv } from "./server/discord/types";

export { PluginBridge };

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/discord/interactions") {
      return handleDiscordInteraction(request, env as DiscordEnv, {
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
    }
    return handler.fetch!(request as never, env as never, ctx);
  },
  scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
