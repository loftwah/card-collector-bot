import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { handleDiscordInteraction } from "../../../server/discord/handler";
import type { DiscordEnv } from "../../../server/discord/types";

export const prerender = false;

/**
 * Local/preview adapter. The production Worker intercepts this path before
 * Astro so Discord never pays for the full site middleware.
 */
export const POST: APIRoute = async ({ request }) => {
  return handleDiscordInteraction(request, env as unknown as DiscordEnv);
};

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ error: "Use POST for Discord interactions." }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
  });
};
