import type { APIRoute } from "astro";
import { z } from "zod";
import { buildContext } from "../../../../../../server/context";
import { apiErrorResponse, json, readJson } from "../../../../../../server/http";
import { registerPasskey } from "../../../../../../server/modules/passkeys";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await readJson(request, z.object({ response: z.record(z.string(), z.unknown()), name: z.string().max(80).optional() }));
    const ctx = await buildContext(request);
    return json(
      await registerPasskey(ctx, request, { response: input.response as never, name: input.name }),
      200,
      { "cache-control": "no-store" },
    );
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("cf-ray") ?? crypto.randomUUID());
  }
};
