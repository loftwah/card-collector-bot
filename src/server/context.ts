import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { readConfig, type RawEnv, type RuntimeConfig, type Role } from "./config";

export type { Role } from "./config";
export { assertTrustedLocal } from "./config";
import { first, nowIso } from "./db";
import { hmacHex, sha256Hex } from "./ids";
import { newId } from "./ids";
import {
  audienceForPath,
  assertPlatformAccessIdentity,
  getAccessAssertion,
  isAccessProtectedPath,
  findAccessTenantForIdentity,
  resolveAccessIdentity,
  resolveAccessIdentityProvider,
  verifyAccessToken,
  type AccessIdentity,
} from "./access";

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
  emailVerified?: boolean;
  capabilities?: string[];
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
  sessionAssurance: string | null;
  sessionAuthTime: string | null;
  accessIdentity: AccessIdentity | null;
  accessStatus: "linked" | "unlinked" | "email_mismatch" | "disabled" | "not_member" | "not_required" | null;
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
  const requestId = request.headers.get("cf-ray") ?? newId("req");
  const cookie = parseCookies(request.headers.get("cookie"));
  const sessionToken = cookie.fb_session;
  const path = new URL(request.url).pathname;
  let tenant = await loadTenant(db, config.tenantSlug);
  let user: CurrentUser | null = null;
  let actor: Actor = { type: "system", id: "anonymous", representedUserId: null, label: "Anonymous" };
  let scopes: string[] | null = null;
  let sessionId: string | null = null;
  let csrfToken = cookie.fb_csrf ?? "";
  let sessionAssurance: string | null = null;
  let sessionAuthTime: string | null = null;
  let accessIdentity: AccessIdentity | null = null;
  let accessStatus: Ctx["accessStatus"] = null;

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer?.startsWith("fba_")) {
    const resolved = await resolveAgent(db, config, bearer);
    tenant = resolved.tenant;
    user = resolved.user;
    actor = resolved.actor;
    scopes = resolved.scopes;
  } else if (sessionToken) {
    const resolved = await resolveSession(db, sessionToken);
    if (resolved) {
      tenant = resolved.tenant;
      user = resolved.user;
      sessionId = resolved.sessionId;
      csrfToken = resolved.csrfToken;
      sessionAssurance = resolved.assurance;
      sessionAuthTime = resolved.authTime;
      actor = {
        type: "user",
        id: resolved.user.id,
        representedUserId: resolved.user.id,
        label: resolved.user.displayName,
      };
    }
  }

  // Administrative routes are re-verified against Cloudflare Access on every
  // request. An old application cookie alone never retains authority.
  const agentAdminApi = actor.type === "agent" && (path === "/api/v1/admin" || path.startsWith("/api/v1/admin/"));
  if (isAccessProtectedPath(path) && !agentAdminApi) {
    if (config.environment === "production" && !config.access.enabled) {
      throw new ApiError(503, "access_not_configured", "Administrative access is not configured.");
    }
    if (config.access.enabled) {
      const assertion = getAccessAssertion(request);
      const audience = audienceForPath(config, path);
      if (!assertion) throw new ApiError(401, "access_required", "Sign in through Cloudflare Access to continue.");
      accessIdentity = await verifyAccessToken(assertion, config, audience ?? "");
      const platformPath = path === "/platform-admin" || path.startsWith("/platform-admin/") ||
        path === "/api/v1/platform" || path.startsWith("/api/v1/platform/");
      if (platformPath) assertPlatformAccessIdentity(accessIdentity, config);
      let resolved = await resolveAccessIdentity(db, config, tenant, accessIdentity, requestId);
      if (resolved.status === "not_member") {
        const alternate = await findAccessTenantForIdentity(db, config, accessIdentity, tenant.id);
        if (alternate) {
          tenant = alternate;
          resolved = await resolveAccessIdentity(db, config, tenant, accessIdentity, requestId);
        }
      }
      accessStatus = resolved.status;
      if (resolved.status === "linked" && resolved.user) {
        const accessUser = resolved.user;
        if (user && user.id !== accessUser.id) {
          // A browser session for a different person must never be silently
          // attached to the verified Access identity.
          user = null;
          sessionId = null;
          sessionAssurance = null;
          sessionAuthTime = null;
          accessStatus = "email_mismatch";
        } else {
          user = accessUser;
          actor = {
            type: "user",
            id: accessUser.id,
            representedUserId: accessUser.id,
            label: accessUser.displayName,
          };
          // Reuse a matching app session only if it is still active.
          accessStatus = "linked";
          // Access assurance belongs to this verified request, not to a long-lived
          // Foilbury cookie. Dedicated platform audiences admit Cloudflare-account
          // sign-in only. The Bot admin applications also admit email PINs, so
          // their provider must be confirmed by Access's identity endpoint.
          const strongSessionAge = sessionAuthTime ? Date.now() - new Date(sessionAuthTime).getTime() : Infinity;
          // Gifts use the strictest local proof window (15 minutes).
          const hasRecentLocalProof = ["passkey", "mfa"].includes(sessionAssurance ?? "") &&
            strongSessionAge >= 0 && strongSessionAge <= 15 * 60_000;
          const needsProviderProof = !["GET", "HEAD", "OPTIONS"].includes(request.method) && !hasRecentLocalProof;
          if (platformPath || (needsProviderProof && await resolveAccessIdentityProvider(assertion, accessIdentity, config) === "cloudflare")) {
            sessionAssurance = "access";
            sessionAuthTime = nowIso();
          } else if (sessionAssurance === "access" || !sessionAssurance) {
            sessionAssurance = "email";
            sessionAuthTime = null;
          }
        }
      } else {
        user = null;
        sessionId = null;
        sessionAssurance = null;
        sessionAuthTime = null;
      }
    } else if (config.environment !== "local") {
      throw new ApiError(403, "access_required", "Administrative access requires Cloudflare Access.");
    }
  }

  return {
    db,
    media: raw.MEDIA,
    config,
    requestId,
    tenant,
    user,
    actor,
    scopes,
    sessionId,
    csrfToken,
    sessionAssurance,
    sessionAuthTime,
    accessIdentity,
    accessStatus,
  };
}

export async function resolveSession(
  db: D1Database,
  token: string,
): Promise<{
  user: CurrentUser;
  sessionId: string;
  csrfToken: string;
  assurance: string;
  authTime: string | null;
  tenant: Tenant;
} | null> {
  const tokenHash = await sha256Hex(token);
  const row = await first<{
    id: string;
    user_id: string;
    csrf_token: string;
    expires_at: string;
    revoked_at: string | null;
    assurance: string;
    auth_time: string | null;
    email: string;
    display_name: string;
    platform_admin: number;
    email_verified_at: string | null;
    capabilities_json: string;
    role: Role;
    disabled_at: string | null;
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
  }>(
    db,
    `SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.revoked_at, s.assurance, s.auth_time,
            u.email, u.display_name, u.platform_admin, u.email_verified_at, u.disabled_at,
            m.role, m.capabilities_json, t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name
       FROM fb_sessions s
       JOIN fb_users u ON u.id = s.user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = s.tenant_id AND m.status = 'active'
       JOIN fb_tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row || row.revoked_at || row.disabled_at || new Date(row.expires_at) <= new Date()) return null;
  await db
    .prepare("UPDATE fb_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run()
    .catch(() => undefined);
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    capabilities = [];
  }
  return {
    sessionId: row.id,
    csrfToken: row.csrf_token,
    assurance: row.assurance,
    authTime: row.auth_time,
    tenant: { id: row.tenant_id, slug: row.tenant_slug, name: row.tenant_name },
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      platformAdmin: Boolean(row.platform_admin),
      emailVerified: Boolean(row.email_verified_at),
      capabilities,
    },
  };
}

export async function resolveAgent(
  db: D1Database,
  config: RuntimeConfig,
  token: string,
  tenantFilter?: Tenant,
): Promise<{ user: CurrentUser; actor: Actor; scopes: string[]; tenant: Tenant }> {
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
    email_verified_at: string | null;
    capabilities_json: string;
    role: Role;
    disabled_at: string | null;
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
  }>(
    db,
    `SELECT t.id, t.grant_id, g.agent_name, g.agent_id, g.represented_user_id,
            g.scopes_json, g.status, g.expires_at, g.revoked_at,
            u.email, u.display_name, u.platform_admin, u.email_verified_at, u.disabled_at,
            m.role, m.capabilities_json, t2.id AS tenant_id, t2.slug AS tenant_slug, t2.name AS tenant_name
       FROM fb_agent_tokens t
       JOIN fb_agent_grants g ON g.id = t.grant_id
       JOIN fb_users u ON u.id = g.represented_user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = g.tenant_id AND m.status = 'active'
       JOIN fb_tenants t2 ON t2.id = g.tenant_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL
        AND (? IS NULL OR g.tenant_id = ?)`,
    tokenHash,
    tenantFilter?.id ?? null,
    tenantFilter?.id ?? null,
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
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    capabilities = [];
  }
  const scopes = JSON.parse(row.scopes_json) as string[];
  await db
    .prepare("UPDATE fb_agent_tokens SET last_used_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run()
    .catch(() => undefined);
  return {
    scopes,
    tenant: { id: row.tenant_id, slug: row.tenant_slug, name: row.tenant_name },
    user: {
      id: row.represented_user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      platformAdmin: Boolean(row.platform_admin),
      emailVerified: Boolean(row.email_verified_at),
      capabilities,
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

export function hasCapability(user: CurrentUser | null, capability: string): boolean {
  if (!user) return false;
  if (user.role === "owner") return true;
  return Array.isArray(user.capabilities) && user.capabilities.includes(capability);
}

export function requireSuperAdmin(ctx: Ctx): CurrentUser {
  const user = requireUser(ctx);
  if (ctx.actor.type !== "user" || !user.platformAdmin) {
    throw new ApiError(403, "super_admin_required", "Platform administration is restricted to the provisioned Super Admin.");
  }
  return user;
}

/**
 * Content authority for platform-global collections and achievements. A scoped
 * agent may act for the provisioned Super Admin only with an explicit content
 * or import scope; it never gains platform administration from this helper.
 */
export function requireSuperAdminContent(ctx: Ctx): CurrentUser {
  const user = requireUser(ctx);
  if (!user.platformAdmin) {
    throw new ApiError(403, "super_admin_required", "Platform content is restricted to the provisioned Super Admin.");
  }
  if (ctx.actor.type === "agent") {
    const scopes = ctx.scopes ?? [];
    if (!scopes.includes("content:write") && !scopes.includes("import:write") && !scopes.includes("catalogue:publish")) {
      throw new ApiError(403, "insufficient_scope", "This agent grant cannot change platform content.");
    }
  } else if (ctx.actor.type !== "user") {
    throw new ApiError(403, "super_admin_required", "Platform content is restricted to a signed-in Super Admin.");
  }
  return user;
}

export function roleLabel(user: (Pick<CurrentUser, "role"> & { platformAdmin?: boolean }) | null): string {
  if (!user) return "Guest";
  if (user.platformAdmin) return "Super Admin";
  if (user.role === "owner") return "Bot Owner";
  if (user.role === "editor" || user.role === "economy_admin") return "Bot Admin";
  return "User";
}

export function requireRecentStrongAuth(ctx: Ctx, maxAgeMinutes = 20): void {
  if (ctx.actor.type !== "user") {
    throw new ApiError(403, "human_strong_auth_required", "This action requires a signed-in human with recent strong authentication.");
  }
  const method = ctx.sessionAssurance ?? "";
  if (method === "access" && (!ctx.accessIdentity || ctx.accessStatus !== "linked")) {
    throw new ApiError(403, "strong_auth_required", "Confirm with a passkey, authenticator code or Cloudflare Access to continue.");
  }
  if (!["access", "passkey", "mfa"].includes(method)) {
    throw new ApiError(403, "strong_auth_required", "Confirm with a passkey, authenticator code or Cloudflare Access to continue.");
  }
  if (method !== "access") {
    const age = ctx.sessionAuthTime ? Date.now() - new Date(ctx.sessionAuthTime).getTime() : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(age) || age > maxAgeMinutes * 60_000) {
      throw new ApiError(403, "strong_auth_stale", "Your strong authentication is stale. Confirm again to continue.");
    }
  }
}

export async function requireProtectedAccount(ctx: Ctx): Promise<CurrentUser> {
  const user = requireUser(ctx);
  if (!user.emailVerified) {
    throw new ApiError(403, "email_verification_required", "Verify your email address before creating or administering a Bot.");
  }
  const row = await first<{ passkeys: number; totp: number; access: number }>(
    ctx.db,
    `SELECT
       (SELECT COUNT(*) FROM fb_webauthn_credentials WHERE user_id = ?) AS passkeys,
       (SELECT COUNT(*) FROM fb_totp_secrets WHERE user_id = ? AND confirmed_at IS NOT NULL) AS totp,
       (SELECT COUNT(*) FROM fb_access_identities WHERE user_id = ? AND revoked_at IS NULL) AS access`,
    user.id,
    user.id,
    user.id,
  );
  if (!row || (row.passkeys === 0 && row.totp === 0 && row.access === 0)) {
    throw new ApiError(403, "protected_account_required", "Set up a passkey or authenticator before creating or administering a Bot.");
  }
  return user;
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

