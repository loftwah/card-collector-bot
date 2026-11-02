import { defineMiddleware } from "astro:middleware";
import { buildContext, runtimeEnv, ApiError } from "./server/context";
import { readConfig } from "./server/config";

const LOCAL_ONLY = new Set(["/api/v1/bootstrap", "/api/v1/status"]);

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.url.pathname.startsWith("/_emdash")) return next();
  context.locals.requestId = context.request.headers.get("cf-ray") ?? crypto.randomUUID();
  const theme = context.cookies.get("fb_theme")?.value;
  context.locals.theme = theme === "light" || theme === "dark" ? theme : "system";

  if (LOCAL_ONLY.has(context.url.pathname)) return next();

  try {
    const ctx = await buildContext(context.request);
    context.locals.foilbury = {
      tenantId: ctx.tenant.id,
      tenantSlug: ctx.tenant.slug,
      user: ctx.user,
      sessionId: ctx.sessionId,
      csrfToken: ctx.csrfToken,
      actor: ctx.actor,
      wallet: ctx.user
        ? await ctx.db
            .prepare("SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?")
            .bind(ctx.tenant.id, ctx.user.id)
            .first<{ balance: number }>()
            .then((row) => row?.balance ?? 0)
        : null,
    };
  } catch (error) {
    if (context.url.pathname.startsWith("/api/")) {
      if (error instanceof ApiError) {
        return new Response(
          JSON.stringify({ error: { code: error.code, message: error.message }, request_id: context.locals.requestId }),
          { status: error.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
        );
      }
      throw error;
    }
    return new Response(setupHtml(), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const path = context.url.pathname;
  const needsPlayer = path === "/play" || path.startsWith("/play/") || path === "/admin" || path.startsWith("/admin/");
  if (needsPlayer && !context.locals.foilbury?.user) {
    const next = encodeURIComponent(path + context.url.search);
    return context.redirect(`/login?next=${next}`);
  }
  if ((path === "/admin" || path.startsWith("/admin/")) && !["owner", "editor", "economy_admin"].includes(context.locals.foilbury?.user?.role ?? "")) {
    return context.redirect("/play");
  }

  const response = await next();
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (needsPlayer) response.headers.set("cache-control", "no-store");
  return response;
});

function setupHtml(): string {
  const config = readConfig(runtimeEnv());
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foilbury setup</title><style>body{font-family:ui-sans-serif,system-ui;background:#f4f0e6;color:#141512;margin:0;display:grid;place-items:center;min-height:100vh}.card{max-width:34rem;padding:3rem;border:1px solid #d6cdbc;background:#fffdf8}h1{font-family:Georgia,serif;font-size:2.5rem;margin:0 0 1rem}p{line-height:1.6}code{background:#eae3d5;padding:.15rem .35rem}</style></head><body><main class="card"><h1>Foilbury needs its local setup.</h1><p>This installation has no tenant yet. Run <code>pnpm setup:local</code> in the repository, then reload this page.</p><p>Environment: ${config.environment}. Local URL: <code>${config.publicOrigin}</code>.</p></main></body></html>`;
}
