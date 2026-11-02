import type { APIRoute } from "astro";
import { z } from "zod";
import { ApiError, buildContext, checkRateLimit, loadTenant } from "../../../../server/context";
import { apiErrorResponse, readJson, json } from "../../../../server/http";
import { devLogin } from "../../../../server/modules/identity";
import { cookieHeaders, sessionCookies } from "../../../../server/api/helpers";
import { isTrustedLocalRequest } from "../../../../server/config";
import { newId } from "../../../../server/ids";

export const prerender = false;

const schema = z.object({ email: z.string().email().max(320), tenant: z.string().min(2).max(60).optional() });

export const POST: APIRoute = async ({ request }) => {
  const requestId = newId("req");
  try {
    const ctx = await buildContext(request);
    if (!ctx.config.devLogin || !isTrustedLocalRequest(request, ctx.config)) {
      throw new ApiError(404, "not_found", "Not found.");
    }
    const body = await readJson(request, schema);
    await checkRateLimit(ctx.db, `dev-login:${body.email.toLowerCase()}`, 20, 300);
    const loginTenant = body.tenant ? await loadTenant(ctx.db, body.tenant) : ctx.tenant;
    const result = await devLogin(ctx.db, loginTenant, body.email);
    return json(
      { user: result.user, tenant: loginTenant, csrf_token: result.csrf, expires_at: result.expiresAt, development_bypass: true },
      200,
      cookieHeaders(sessionCookies(result.token, result.csrf, result.expiresAt, false)),
    );
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
};
