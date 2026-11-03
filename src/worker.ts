import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { handleDiscordInteraction } from "./server/discord/handler";
import type { DiscordEnv } from "./server/discord/types";
import { runScheduledNpcProgression } from "./server/modules/npcs";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

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
  scheduled: async (controller: ScheduledController, env: unknown, ctx: ExecutionContext) => {
    // Bounded synthetic progression shares the existing cron. Failures are
    // logged and never block the editorial/scheduled-publication handler.
    try {
      const bindings = env as { DB: never; MEDIA: never };
      await runScheduledNpcProgression(
        bindings.DB,
        bindings.MEDIA,
        (await import("./server/config")).readConfig(env as never),
      );
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "NPC scheduled run failed", error: String(error) }));
    }
    return emdashScheduled(controller, env as never, ctx);
  },
} satisfies ExportedHandler;
