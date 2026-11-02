import type { APIRoute } from "astro";
import { buildContext } from "../../../../../server/context";
import { apiErrorResponse, json } from "../../../../../server/http";
import { cookieHeaders, sessionCookies } from "../../../../../server/api/helpers";
import { switchBot } from "../../../../../server/modules/bots";
import { createSession } from "../../../../../server/modules/identity";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const ctx = await buildContext(request);
    const result = await switchBot(ctx, params.id ?? "");
    const session = await createSession(ctx.db, result.tenant, ctx.user!, {
      authMethod: "session_switch",
      assurance: (ctx.sessionAssurance as "password" | "email" | "discord" | "access" | "passkey" | "mfa" | null) ?? "password",
      userAgent: request.headers.get("user-agent"),
    });
    return json(
      { ok: true, tenant: result.tenant, redirect: "/admin" },
      200,
      cookieHeaders(sessionCookies(session.token, session.csrf, session.expiresAt, ctx.config.environment === "production")),
    );
  } catch (error) {
    return apiErrorResponse(error, request.headers.get("cf-ray") ?? crypto.randomUUID());
  }
};
