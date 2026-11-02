import type { APIRoute } from "astro";
import { z } from "zod";
import { ApiError, buildContext, checkRateLimit } from "../../../../server/context";
import { apiErrorResponse, readJson, json } from "../../../../server/http";
import { devLogin } from "../../../../server/modules/identity";
import { cookieHeaders, sessionCookies } from "../../../../server/api/helpers";
import { isTrustedLocalRequest } from "../../../../server/config";
import { newId } from "../../../../server/ids";

export const prerender = false;

const schema = z.object({ email: z.string().email().max(320) });

export const POST: APIRoute = async ({ request }) => {
  const requestId = newId("req");
  try {
    const ctx = await buildContext(request);
    if (!ctx.config.devLogin || !isTrustedLocalRequest(request, ctx.config)) {
      throw new ApiError(404, "not_found", "Not found.");
    }
    const body = await readJson(request, schema);
    await checkRateLimit(ctx.db, `dev-login:${body.email.toLowerCase()}`, 20, 300);
    const result = await devLogin(ctx.db, ctx.tenant, body.email);
    return json(
      { user: result.user, tenant: ctx.tenant, csrf_token: result.csrf, expires_at: result.expiresAt, development_bypass: true },
      200,
      cookieHeaders(sessionCookies(result.token, result.csrf, result.expiresAt, false)),
    );
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
};
