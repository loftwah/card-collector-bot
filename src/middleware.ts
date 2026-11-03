import { defineMiddleware } from "astro:middleware";
import { buildContext, runtimeEnv, ApiError } from "./server/context";
import { readConfig } from "./server/config";
import { createSession } from "./server/modules/identity";
import { sessionCookies } from "./server/api/helpers";

const LOCAL_ONLY = new Set(["/api/v1/bootstrap", "/api/v1/status"]);

export const onRequest = defineMiddleware(async (context, next) => {
  if (context.url.pathname.startsWith("/_emdash")) return next();
  context.locals.requestId = context.request.headers.get("cf-ray") ?? crypto.randomUUID();
  const theme = context.cookies.get("fb_theme")?.value;
  context.locals.theme = theme === "light" || theme === "dark" ? theme : "system";

  if (LOCAL_ONLY.has(context.url.pathname)) return next();

  const path = context.url.pathname;
  const isAdminPage = path === "/admin" || path.startsWith("/admin/");
  const isPlatformPage = path === "/platform-admin" || path.startsWith("/platform-admin/");
  const isAdminApi = path === "/api/v1/admin" || path.startsWith("/api/v1/admin/");
  const isPlatformApi = path === "/api/v1/platform" || path.startsWith("/api/v1/platform/");
  const isProtectedPage = isAdminPage || isPlatformPage;

  let ctx;
  try {
    ctx = await buildContext(context.request);
    context.locals.foilbury = {
      tenantId: ctx.tenant.id,
      tenantSlug: ctx.tenant.slug,
      user: ctx.user,
      sessionId: ctx.sessionId,
      csrfToken: ctx.csrfToken,
      actor: ctx.actor,
      accessStatus: ctx.accessStatus,
      accessIdentity: ctx.accessIdentity,
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

  if (isProtectedPage) {
    const access = ctx.accessIdentity;
    const status = ctx.accessStatus;
    if (ctx.config.access.enabled && (!access || status !== "linked" || !ctx.user)) {
      return new Response(accessGateHtml({ status: status ?? "unlinked", email: access?.email, path }), {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (isPlatformPage) {
      if (!ctx.user?.platformAdmin) {
        return new Response(accessGateHtml({ status: "not_super_admin", email: access?.email, path }), {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }
    if (!ctx.user) {
      const next = encodeURIComponent(path + context.url.search);
      return context.redirect(`/login?next=${next}`);
    }
    if (isAdminPage && !["owner", "editor", "economy_admin"].includes(ctx.user.role)) {
      return new Response(accessGateHtml({ status: "not_admin", email: access?.email, path }), {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }

  if (path === "/play" || path.startsWith("/play/")) {
    if (!ctx.user) {
      const next = encodeURIComponent(path + context.url.search);
      return context.redirect(`/login?next=${next}`);
    }
  }

  if ((isAdminApi || isPlatformApi) && ctx.actor.type !== "agent" && ctx.config.access.enabled && (!ctx.accessIdentity || ctx.accessStatus !== "linked" || !ctx.user)) {
    return new Response(
      JSON.stringify({
        error: { code: "access_identity_required", message: "Cloudflare Access identity is not linked to this Foilbury account." },
        request_id: context.locals.requestId,
      }),
      { status: 403, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
    );
  }

  // A verified Access identity can establish the application session. The
  // session is a CSRF/UI convenience only; Access is re-verified every request.
  // Create it before rendering so the CSRF meta tag matches the new cookie on
  // the very first page load, not only after a reload.
  let accessCookies: string[] = [];
  if (isProtectedPage && ctx.config.access.enabled && ctx.accessIdentity && ctx.accessStatus === "linked" && ctx.user && !ctx.sessionId) {
    const session = await createSession(ctx.db, ctx.tenant, ctx.user, {
      authMethod: "cloudflare_access",
      // The cookie carries the linked account and CSRF state. Strong Access
      // assurance is re-established from the verified assertion on each request.
      assurance: "email",
      accessSubject: ctx.accessIdentity.subject,
      userAgent: context.request.headers.get("user-agent"),
    });
    ctx.csrfToken = session.csrf;
    if (context.locals.foilbury) context.locals.foilbury.csrfToken = session.csrf;
    accessCookies = sessionCookies(session.token, session.csrf, session.expiresAt, true);
  }

  const response = await next();
  for (const cookie of accessCookies) response.headers.append("set-cookie", cookie);

  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (isProtectedPage || path === "/play" || path.startsWith("/play/")) response.headers.set("cache-control", "no-store");
  return response;
});

function accessGateHtml(input: { status: string; email?: string; path: string }): string {
  const copy: Record<string, { title: string; body: string }> = {
    unlinked: {
      title: "This Cloudflare identity is not linked yet.",
      body: "Cloudflare verified the address, but it is not explicitly linked to a Foilbury account. Sign in with Discord or a magic link first, link this address from Account security, then return here.",
    },
    email_mismatch: {
      title: "This browser is signed in as someone else.",
      body: "A Foilbury session for a different person is active in this browser. Sign out of Foilbury, then continue with the verified Cloudflare identity. Nothing was attached to the other account.",
    },
    disabled: {
      title: "This account is disabled.",
      body: "The linked Foilbury account is disabled. Contact the Super Admin if you believe this is a mistake.",
    },
    not_member: {
      title: "This account is not a member of the Bot.",
      body: "The verified Cloudflare identity is linked to a Foilbury account, but that account has no active membership for this administration area.",
    },
    strong_required: {
      title: "Use your Cloudflare account for platform administration.",
      body: "Platform administration requires the Cloudflare account identity provider, not a one-time email code. Sign in through Cloudflare Access with your Cloudflare account.",
    },
    not_super_admin: {
      title: "Super Admin authority is not provisioned for this account.",
      body: "Cloudflare Access admission is not a Foilbury role. Only the explicitly provisioned Dean account can enter Platform Administration.",
    },
    not_admin: {
      title: "This Bot does not grant administrative capability.",
      body: "Your Foilbury account is signed in, but it is not a Bot Owner or Bot Admin for this Bot. Ask the Bot Owner for an expiring invitation.",
    },
  };
  const entry = copy[input.status] ?? copy.unlinked!;
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Administration access · Foilbury</title><style>
  body{margin:0;background:#f4f0e6;color:#141512;font-family:ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
  main{max-width:620px;border:1px solid #d6cdbc;background:#fffdf8;padding:40px;box-shadow:0 20px 50px -30px rgba(20,21,18,.4)}
  p.eyebrow{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6e6657;margin:0 0 12px}
  h1{font-family:Georgia,serif;font-size:40px;line-height:1.05;margin:0 0 16px;font-weight:500}
  p{line-height:1.65;color:#3d3b34}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
  a{display:inline-block;padding:12px 18px;text-decoration:none;font-weight:650;border:1px solid #141512;background:#141512;color:#fffdf8}
  a.secondary{background:transparent;color:#141512}small{display:block;margin-top:20px;color:#6e6657}
  </style></head><body><main><p class="eyebrow">Administration · access check</p><h1>${escapeHtml(entry.title)}</h1><p>${escapeHtml(entry.body)}</p>${input.email ? `<p><strong>Verified Cloudflare identity:</strong> ${escapeHtml(input.email)}</p>` : ""}<div class="actions"><a href="/logout?next=${encodeURIComponent(input.path)}">Sign out of Foilbury</a><a class="secondary" href="/account/security">Account security</a><a class="secondary" href="/login">Sign in</a></div><small>This decision is re-checked on every request. Access admission never creates a Foilbury role.</small></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function setupHtml(): string {
  const config = readConfig(runtimeEnv());
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Foilbury setup</title><style>body{font-family:ui-sans-serif,system-ui;background:#f4f0e6;color:#141512;margin:0;display:grid;place-items:center;min-height:100vh}.card{max-width:34rem;padding:3rem;border:1px solid #d6cdbc;background:#fffdf8}h1{font-family:Georgia,serif;font-size:2.5rem;margin:0 0 1rem}p{line-height:1.6}code{background:#eae3d5;padding:.15rem .35rem}</style></head><body><main class="card"><h1>Foilbury needs its local setup.</h1><p>This installation has no tenant yet. Run <code>pnpm setup:local</code> in the repository, then reload this page.</p><p>Environment: ${config.environment}. Local URL: <code>${config.publicOrigin}</code>.</p></main></body></html>`;
}

