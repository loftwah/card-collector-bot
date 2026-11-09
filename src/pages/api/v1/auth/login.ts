import type { APIRoute } from "astro";
import { z } from "zod";
import { ApiError, buildContext, checkRateLimit, rateLimitEmailKey } from "../../../../server/context";
import { json, readJson, apiErrorResponse } from "../../../../server/http";
import { login } from "../../../../server/modules/identity";
import { cookieHeaders, sessionCookies } from "../../../../server/api/helpers";
import { requestReference } from "../../../../server/ids";

export const prerender = false;

const schema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const POST: APIRoute = async ({ request }) => {
  const requestId = requestReference(request);
  try {
    const input = await readJson(request, schema);
    const ctx = await buildContext(request);
    await checkRateLimit(ctx.db, await rateLimitEmailKey(ctx.config, "login:email", input.email), 8, 300, `login:${input.email.toLowerCase()}`);
    const result = await login(ctx.db, ctx.tenant, input.email, input.password);
    return json(
      { user: result.user, tenant: ctx.tenant, csrf_token: result.csrf, expires_at: result.expiresAt },
      200,
      cookieHeaders(sessionCookies(result.token, result.csrf, result.expiresAt, ctx.config.environment === "production")),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return json(
        { error: { code: error.code, message: error.message }, request_id: requestId },
        401,
      );
    }
    return apiErrorResponse(error, requestId);
  }
};
