import type { APIRoute } from "astro";
import { z } from "zod";
import { buildContext } from "../../../../../../server/context";
import { apiErrorResponse, json, readJson } from "../../../../../../server/http";
import { requestReference } from "../../../../../../server/ids";
import { cookieHeaders, sessionCookies } from "../../../../../../server/api/helpers";
import { loginWithPasskey } from "../../../../../../server/modules/passkeys";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const input = await readJson(request, z.object({ response: z.record(z.string(), z.unknown()) }));
    const ctx = await buildContext(request);
    const result = await loginWithPasskey(ctx, request, { response: input.response as never });
    return json(
      { user: result.user, tenant: result.tenant, csrf_token: result.csrf, expires_at: result.expiresAt },
      200,
      cookieHeaders(sessionCookies(result.token, result.csrf, result.expiresAt, ctx.config.environment === "production")),
    );
  } catch (error) {
    return apiErrorResponse(error, requestReference(request));
  }
};
