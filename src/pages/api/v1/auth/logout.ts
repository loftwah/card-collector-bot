import type { APIRoute } from "astro";
import { buildContext } from "../../../../server/context";
import { json } from "../../../../server/http";
import { revokeSession } from "../../../../server/modules/identity";
import { clearSessionCookies, cookieHeaders } from "../../../../server/api/helpers";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const ctx = await buildContext(request);
  if (ctx.sessionId) await revokeSession(ctx.db, ctx.sessionId);
  return json(
    { ok: true },
    200,
    cookieHeaders(clearSessionCookies(ctx.config.environment === "production")),
  );
};
