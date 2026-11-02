import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { readConfig, type RawEnv, type RuntimeConfig, type Role } from "./config";

export type { Role } from "./config";
export { assertTrustedLocal } from "./config";
import { first, nowIso } from "./db";
import { hmacHex, sha256Hex } from "./ids";
import { newId } from "./ids";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  platformAdmin: boolean;
}

export interface Actor {
  type: "user" | "agent" | "system";
  id: string;
  representedUserId: string | null;
  label: string;
}

export interface Ctx {
  db: D1Database;
  media: R2Bucket;
  config: RuntimeConfig;
  requestId: string;
  tenant: Tenant;
  user: CurrentUser | null;
  actor: Actor;
  scopes: string[] | null;
  sessionId: string | null;
  csrfToken: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function runtimeEnv(): RawEnv & { DB: D1Database; MEDIA: R2Bucket } {
  return env as unknown as RawEnv & { DB: D1Database; MEDIA: R2Bucket };
}

export async function loadTenant(db: D1Database, slug: string): Promise<Tenant> {
  const tenant = await first<Tenant>(
    db,
    "SELECT id, slug, name FROM fb_tenants WHERE slug = ?",
    slug,
  );
  if (!tenant) throw new ApiError(503, "tenant_not_configured", "This installation has no matching tenant.");
  return tenant;
}

export async function buildContext(request: Request, options?: { requireTenant?: boolean }): Promise<Ctx> {
  const raw = runtimeEnv();
  const config = readConfig(raw);
  const db = raw.DB;
  const tenant = await loadTenant(db, config.tenantSlug);
  const requestId = request.headers.get("cf-ray") ?? newId("req");
  const cookie = parseCookies(request.headers.get("cookie"));
  const sessionToken = cookie.fb_session;
  let user: CurrentUser | null = null;
  let actor: Actor = { type: "system", id: "anonymous", representedUserId: null, label: "Anonymous" };
  let scopes: string[] | null = null;
  let sessionId: string | null = null;
  let csrfToken = cookie.fb_csrf ?? "";

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer?.startsWith("fba_")) {
    const resolved = await resolveAgent(db, config, bearer, tenant);
    user = resolved.user;
    actor = resolved.actor;
    scopes = resolved.scopes;
  } else if (sessionToken) {
    const resolved = await resolveSession(db, sessionToken, tenant);
    if (resolved) {
      user = resolved.user;
      sessionId = resolved.sessionId;
      csrfToken = resolved.csrfToken;
      actor = {
        type: "user",
        id: resolved.user.id,
        representedUserId: resolved.user.id,
        label: resolved.user.displayName,
      };
    }
  }

  if (!user && options?.requireTenant !== false) {
    // Anonymous context is valid for the public site and login handshake.
  }

  return { db, media: raw.MEDIA, config, requestId, tenant, user, actor, scopes, sessionId, csrfToken };
}

export async function resolveSession(
  db: D1Database,
  token: string,
  tenant: Tenant,
): Promise<{ user: CurrentUser; sessionId: string; csrfToken: string } | null> {
  const tokenHash = await sha256Hex(token);
  const row = await first<{
    id: string;
    user_id: string;
    csrf_token: string;
    expires_at: string;
    revoked_at: string | null;
    email: string;
    display_name: string;
    platform_admin: number;
    role: Role;
    disabled_at: string | null;
  }>(
    db,
    `SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.revoked_at,
            u.email, u.display_name, u.platform_admin, u.disabled_at, m.role
       FROM fb_sessions s
       JOIN fb_users u ON u.id = s.user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = s.tenant_id
      WHERE s.token_hash = ? AND s.tenant_id = ?`,
    tokenHash,
    tenant.id,
  );
  if (!row || row.revoked_at || row.disabled_at || new Date(row.expires_at) <= new Date()) return null;
  await db
    .prepare("UPDATE fb_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run()
    .catch(() => undefined);
  return {
    sessionId: row.id,
    csrfToken: row.csrf_token,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      platformAdmin: Boolean(row.platform_admin),
    },
  };
}

export async function resolveAgent(
  db: D1Database,
  config: RuntimeConfig,
  token: string,
  tenant: Tenant,
): Promise<{ user: CurrentUser; actor: Actor; scopes: string[] }> {
  const tokenHash = await hmacHex(config.agentPepper || config.sessionSecret || "local", token);
  const row = await first<{
    id: string;
    grant_id: string;
    agent_name: string;
    agent_id: string;
    represented_user_id: string;
    scopes_json: string;
    status: string;
    expires_at: string;
    revoked_at: string | null;
    email: string;
    display_name: string;
    platform_admin: number;
    role: Role;
    disabled_at: string | null;
  }>(
    db,
    `SELECT t.id, t.grant_id, g.agent_name, g.agent_id, g.represented_user_id,
            g.scopes_json, g.status, g.expires_at, g.revoked_at,
            u.email, u.display_name, u.platform_admin, u.disabled_at, m.role
       FROM fb_agent_tokens t
       JOIN fb_agent_grants g ON g.id = t.grant_id
       JOIN fb_users u ON u.id = g.represented_user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = g.tenant_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND g.tenant_id = ?`,
    tokenHash,
    tenant.id,
  );
  if (
    !row ||
    row.status !== "active" ||
    row.revoked_at ||
    row.disabled_at ||
    new Date(row.expires_at) <= new Date()
  ) {
    throw new ApiError(401, "agent_unauthorised", "This agent credential is expired or revoked.");
  }
  const scopes = JSON.parse(row.scopes_json) as string[];
  await db
    .prepare("UPDATE fb_agent_tokens SET last_used_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run()
    .catch(() => undefined);
  return {
    scopes,
    user: {
      id: row.represented_user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      platformAdmin: Boolean(row.platform_admin),
    },
    actor: {
      type: "agent",
      id: row.agent_id,
      representedUserId: row.represented_user_id,
      label: row.agent_name,
    },
  };
}

export function requireUser(ctx: Ctx): CurrentUser {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  return ctx.user;
}

export function requireRole(ctx: Ctx, roles: Role[]): CurrentUser {
  const user = requireUser(ctx);
  if (!roles.includes(user.role)) {
    throw new ApiError(403, "insufficient_role", "This action is not available to your role.");
  }
  return user;
}

export function requireScope(ctx: Ctx, scope: string): void {
  if (!ctx.user) throw new ApiError(401, "authentication_required", "Sign in to continue.");
  if (ctx.actor.type === "agent") {
    if (!ctx.scopes?.includes(scope)) {
      throw new ApiError(403, "insufficient_scope", `The agent grant does not include ${scope}.`);
    }
  }
}

export function canManageContent(ctx: Ctx): boolean {
  if (ctx.actor.type === "agent") {
    if (ctx.scopes?.includes("content:write")) return true;
    return false;
  }
  return ctx.user?.role === "owner" || ctx.user?.role === "editor";
}

export function canManageEconomy(ctx: Ctx): boolean {
  if (ctx.actor.type === "agent") {
    if (ctx.scopes?.includes("economy:write") || ctx.scopes?.includes("economy:grant")) return true;
    return false;
  }
  return ctx.user?.role === "owner" || ctx.user?.role === "economy_admin";
}

export function canAdminister(ctx: Ctx): boolean {
  if (ctx.actor.type === "agent") return false;
  return ctx.user?.role === "owner";
}

export function assertCsrf(ctx: Ctx, request: Request): void {
  if (ctx.actor.type === "agent") return;
  if (!ctx.user) return;
  if (request.method === "GET" || request.method === "HEAD") return;
  const header = request.headers.get("x-foilbury-csrf");
  if (!header || !ctx.csrfToken || header !== ctx.csrfToken) {
    throw new ApiError(403, "csrf_failed", "Refresh the page and try again.");
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export async function checkRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const row = await first<{ count: number; window_start: number }>(
    db,
    `INSERT INTO fb_rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
     RETURNING count, window_start`,
    key,
    windowStart,
    windowStart,
    windowStart,
    windowStart,
  );
  if ((row?.count ?? 0) > limit) {
    throw new ApiError(429, "rate_limited", "Too many attempts. Try again shortly.");
  }
}
