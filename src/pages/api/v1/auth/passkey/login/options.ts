import type { APIRoute } from "astro";
import { z } from "zod";
import { buildContext, checkRateLimit } from "../../../../../../server/context";
import { apiErrorResponse, json, readJson } from "../../../../../../server/http";
import { authenticationOptions } from "../../../../../../server/modules/passkeys";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await readJson(request, z.object({ email: z.string().email().max(320).optional() }));
    const ctx = await buildContext(request);
    await checkRateLimit(ctx.db, `passkey-login:client:${ctx.clientKey}`, 30, 300);
    if (input.email) await checkRateLimit(ctx.db, `passkey-login:email:${input.email.toLowerCase()}`, 20, 300);
    return json(await authenticationOptions(ctx, request, input.email), 200, { "cache-control": "no-store" });
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("cf-ray") ?? crypto.randomUUID());
  }
};
