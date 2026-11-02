import type { APIRoute } from "astro";
import { z } from "zod";
import { buildContext } from "../../../../server/context";
import { apiErrorResponse, json, readJson } from "../../../../server/http";
import { requestMagicLink } from "../../../../server/modules/magic-links";

export const prerender = false;

const schema = z.object({
  email: z.string().email().max(320),
  redirectPath: z.string().max(500).optional(),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await readJson(request, schema);
    const ctx = await buildContext(request);
    const result = await requestMagicLink(ctx, {
      email: input.email,
      purpose: "signin",
      redirectPath: input.redirectPath,
    });
    return json({ ok: true, ...(result.devToken ? { dev_token: result.devToken } : {}) }, 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("cf-ray") ?? crypto.randomUUID());
  }
};
