import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { readConfig, type RawEnv, type RuntimeConfig, type Role } from "./config";

export type { Role } from "./config";
export { assertTrustedLocal } from "./config";
import { all, first, nowIso } from "./db";
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

export interface GlobalCollectionScope {
  all: boolean;
  collectionIds: string[];
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  platformAdmin: boolean;
  emailVerified?: boolean;
  capabilities?: string[];
  /** Scoped money authority. Only controls the explicitly granted `grants` capability. */
  selfGrantsEnabled?: boolean;
  grantLimit?: number;
  capabilityRevision?: number;
  /** Explicit platform-role assignments. Never inferred from Access or guild ownership. */
  platformRoles?: string[];
  /** Present only for an active global_collection_admin assignment. */
  globalCollectionScope?: GlobalCollectionScope | null;
  /** True only for an explicitly synthetic game actor. Never a login identity. */
  synthetic?: boolean;
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
  /**
   * Privacy-preserving, stable key for the trusted caller network. Derived from
   * Cloudflare's edge-set CF-Connecting-IP; never from a client-supplied
   * forwarding header. Correlation IDs stay separate in `requestId`.
   */
  clientKey: string;
  tenant: Tenant;
  user: CurrentUser | null;
  actor: Actor;
  scopes: string[] | null;
  sessionId: string | null;
  /** Exact bearer token used for this request, for live authority checks. */
  agentTokenId?: string | null;
  csrfToken: string;
  sessionAssurance: string | null;
  sessionAuthTime: string | null;
  accessIdentity: AccessIdentity | null;
  accessStatus:
    "linked" | "unlinked" | "email_mismatch" | "disabled" | "not_member" | "not_required" | null;
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
  if (!tenant)
    throw new ApiError(503, "tenant_not_configured", "This installation has no matching tenant.");
  return tenant;
}

export async function buildContext(
  request: Request,
  options?: { requireTenant?: boolean },
): Promise<Ctx> {
  const raw = runtimeEnv();
  const config = readConfig(raw);
  const db = raw.DB;
  const requestId = request.headers.get("cf-ray") ?? newId("req");
  const clientKey = await trustedClientKey(request, config);
  const cookie = parseCookies(request.headers.get("cookie"));
  const sessionToken = cookie.fb_session;
  const path = new URL(request.url).pathname;
  let tenant = await loadTenant(db, config.tenantSlug);
  let user: CurrentUser | null = null;
  let actor: Actor = {
    type: "system",
    id: "anonymous",
    representedUserId: null,
    label: "Anonymous",
  };
  let scopes: string[] | null = null;
  let sessionId: string | null = null;
  let agentTokenId: string | null = null;
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
    agentTokenId = resolved.tokenId;
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
  const agentAdminApi =
    actor.type === "agent" && (path === "/api/v1/admin" || path.startsWith("/api/v1/admin/"));
  if (isAccessProtectedPath(path) && !agentAdminApi) {
    if (config.environment === "production" && !config.access.enabled) {
      throw new ApiError(503, "access_not_configured", "Administrative access is not configured.");
    }
    if (config.access.enabled) {
      const assertion = getAccessAssertion(request);
      const audience = audienceForPath(config, path);
      if (!assertion)
        throw new ApiError(
          401,
          "access_required",
          "Sign in through Cloudflare Access to continue.",
        );
      accessIdentity = await verifyAccessToken(assertion, config, audience ?? "");
      const platformPath =
        path === "/platform-admin" ||
        path.startsWith("/platform-admin/") ||
        path === "/api/v1/platform" ||
        path.startsWith("/api/v1/platform/");
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
          const strongSessionAge = sessionAuthTime
            ? Date.now() - new Date(sessionAuthTime).getTime()
            : Infinity;
          // Gifts use the strictest local proof window (15 minutes).
          const hasRecentLocalProof =
            ["passkey", "mfa"].includes(sessionAssurance ?? "") &&
            strongSessionAge >= 0 &&
            strongSessionAge <= 15 * 60_000;
          const needsProviderProof =
            !["GET", "HEAD", "OPTIONS"].includes(request.method) && !hasRecentLocalProof;
          if (
            platformPath ||
            (needsProviderProof &&
              (await resolveAccessIdentityProvider(assertion, accessIdentity, config)) ===
                "cloudflare")
          ) {
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
      throw new ApiError(
        403,
        "access_required",
        "Administrative access requires Cloudflare Access.",
      );
    }
  }

  if (user) {
    const roles = await all<{ role: string; scopes_json: string }>(
      db,
      "SELECT role, scopes_json FROM fb_platform_role_assignments WHERE user_id = ? AND status = 'active'",
      user.id,
    ).catch(() => []);
    const platformRoles = roles.map((row) => row.role);
    let globalCollectionScope: GlobalCollectionScope | null = null;
    const globalRole = roles.find((row) => row.role === "global_collection_admin");
    if (globalRole) {
      try {
        const parsed = JSON.parse(globalRole.scopes_json) as {
          all?: unknown;
          collectionIds?: unknown;
        };
        const collectionIds = Array.isArray(parsed.collectionIds)
          ? parsed.collectionIds.filter((id): id is string => typeof id === "string")
          : [];
        globalCollectionScope = {
          all: parsed.all !== false || collectionIds.length === 0,
          collectionIds,
        };
      } catch {
        globalCollectionScope = { all: true, collectionIds: [] };
      }
    }
    user = { ...user, platformRoles, globalCollectionScope };
  }

  return {
    db,
    media: raw.MEDIA,
    config,
    requestId,
    clientKey,
    tenant,
    user,
    actor,
    scopes,
    sessionId,
    agentTokenId,
    csrfToken,
    sessionAssurance,
    sessionAuthTime,
    accessIdentity,
    accessStatus,
  };
}

/**
 * Resolve the caller network without trusting arbitrary headers.
 *
 * Cloudflare sets `CF-Connecting-IP` at its edge and strips client-supplied
 * copies. In local development there is no trustworthy edge address, so every
 * local caller shares one explicitly local bucket rather than inventing an
 * identity from `X-Forwarded-For`/`cf-ray`. The raw address is never stored:
 * only an HMAC keyed by the deployment secret is used as the limit key.
 */
export async function trustedClientKey(
  request: Request,
  config: RuntimeConfig,
): Promise<string> {
  const edgeAddress =
    config.environment === "production" || config.environment === "test"
      ? request.headers.get("cf-connecting-ip")?.trim() ?? null
      : null;
  const raw = edgeAddress || "local-caller";
  return hmacHex(config.sessionSecret || "foilbury-local-rate-limit", raw);
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
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
    role: Role;
    disabled_at: string | null;
    tenant_id: string;
    tenant_slug: string;
    tenant_name: string;
  }>(
    db,
    `SELECT s.id, s.user_id, s.csrf_token, s.expires_at, s.revoked_at, s.assurance, s.auth_time,
            u.email, u.display_name, u.platform_admin, u.email_verified_at, u.disabled_at,
            m.role, m.capabilities_json, m.self_grants_enabled, m.grant_limit, m.capability_revision,
            t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name
       FROM fb_sessions s
       JOIN fb_users u ON u.id = s.user_id
       JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = s.tenant_id AND m.status = 'active' AND m.revoked_at IS NULL
       JOIN fb_tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row || row.revoked_at || row.disabled_at || new Date(row.expires_at) <= new Date())
    return null;
  await db
    .prepare("UPDATE fb_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run()
    .catch(() => undefined);
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(parsed))
      capabilities = parsed.filter((item): item is string => typeof item === "string");
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
      selfGrantsEnabled: Boolean(row.self_grants_enabled),
      grantLimit: Number(row.grant_limit ?? 0),
      capabilityRevision: Number(row.capability_revision ?? 1),
    },
  };
}

export async function resolveAgent(
  db: D1Database,
  config: RuntimeConfig,
  token: string,
  tenantFilter?: Tenant,
): Promise<{ user: CurrentUser; actor: Actor; scopes: string[]; tenant: Tenant; tokenId: string }> {
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
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
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
            m.role, m.capabilities_json, m.self_grants_enabled, m.grant_limit, m.capability_revision,
            t2.id AS tenant_id, t2.slug AS tenant_slug, t2.name AS tenant_name
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
    if (Array.isArray(parsed))
      capabilities = parsed.filter((item): item is string => typeof item === "string");
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
    tokenId: row.id,
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
      selfGrantsEnabled: Boolean(row.self_grants_enabled),
      grantLimit: Number(row.grant_limit ?? 0),
      capabilityRevision: Number(row.capability_revision ?? 1),
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
  if (user.role === "owner" || user.platformAdmin) return true;
  if (Array.isArray(user.capabilities) && user.capabilities.includes(capability)) return true;
  // Legacy roles remain a compatibility mapping, never a wider money right.
  if (capability === "content" && (user.role === "editor" || user.role === "economy_admin")) {
    return true;
  }
  if (capability === "economy" && user.role === "economy_admin") return true;
  return false;
}

/**
 * The scoped money authority. `grants` is a Bot capability; the self/other
 * flag and ceiling are separate, revocable controls read from the live
 * membership on every request.
 */
export function canIssueScopedGrant(
  user: CurrentUser | null,
  input: { targetUserId: string; amount: number },
): { allowed: true } | { allowed: false; code: string; message: string } {
  if (!user) return { allowed: false, code: "authentication_required", message: "Sign in first." };
  if (user.role === "owner" || user.platformAdmin) return { allowed: true };
  if (!hasCapability(user, "grants")) {
    return {
      allowed: false,
      code: "grants_capability_required",
      message: "This Bot role does not include the grant capability.",
    };
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return {
      allowed: false,
      code: "amount_invalid",
      message: "A scoped grant must be a positive whole number.",
    };
  }
  const limit = Number.isInteger(user.grantLimit) ? Math.max(0, user.grantLimit!) : 0;
  if (input.amount > limit) {
    return {
      allowed: false,
      code: "grant_limit_exceeded",
      message: `This role may grant at most ${limit} Foil per operation.`,
    };
  }
  if (input.targetUserId === user.id && !user.selfGrantsEnabled) {
    return {
      allowed: false,
      code: "self_grants_disabled",
      message: "Self-grants are disabled for this role. Ask the Super Admin or Bot Owner.",
    };
  }
  return { allowed: true };
}

export function hasPlatformRole(user: CurrentUser | null, role: string): boolean {
  return Boolean(user?.platformRoles?.includes(role));
}

export function isGlobalCollectionAdmin(user: CurrentUser | null): boolean {
  return Boolean(user?.globalCollectionScope);
}

export function canReadGlobalCollections(ctx: Ctx): boolean {
  return Boolean(ctx.user && (ctx.user.platformAdmin || isGlobalCollectionAdmin(ctx.user)));
}

export function canManageGlobalCollections(ctx: Ctx): boolean {
  if (!canReadGlobalCollections(ctx)) return false;
  if (ctx.actor.type === "agent") {
    const scopes = ctx.scopes ?? [];
    return (
      scopes.includes("content:write") ||
      scopes.includes("import:write") ||
      scopes.includes("catalogue:publish")
    );
  }
  return true;
}

/** Collection-scoped authority: an all-collections grant or an explicit ID. */
export function canManageGlobalCollection(ctx: Ctx, collectionId: string): boolean {
  const user = ctx.user;
  if (!user) return false;
  if (user.platformAdmin) return canManageGlobalCollections(ctx);
  const scope = user.globalCollectionScope;
  if (!scope || !canManageGlobalCollections(ctx)) return false;
  return scope.all || scope.collectionIds.includes(collectionId);
}

export function requireGlobalCollectionManager(ctx: Ctx, collectionId?: string): CurrentUser {
  const user = requireUser(ctx);
  if (!canManageGlobalCollections(ctx)) {
    if (ctx.actor.type === "agent") {
      throw new ApiError(
        403,
        "insufficient_scope",
        "This agent grant cannot change shared collections.",
      );
    }
    throw new ApiError(
      403,
      "global_collection_admin_required",
      "Only a scoped Global Collection Admin can change shared collections.",
    );
  }
  if (collectionId && !canManageGlobalCollection(ctx, collectionId)) {
    throw new ApiError(
      403,
      "collection_not_in_scope",
      "That collection is outside your delegated collection scope.",
    );
  }
  return user;
}

export function requireSuperAdmin(ctx: Ctx): CurrentUser {
  const user = requireUser(ctx);
  if (ctx.actor.type !== "user" || !user.platformAdmin) {
    throw new ApiError(
      403,
      "super_admin_required",
      "Platform administration is restricted to the provisioned Super Admin.",
    );
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
    throw new ApiError(
      403,
      "super_admin_required",
      "Platform content is restricted to the provisioned Super Admin.",
    );
  }
  if (ctx.actor.type === "agent") {
    const scopes = ctx.scopes ?? [];
    if (
      !scopes.includes("content:write") &&
      !scopes.includes("import:write") &&
      !scopes.includes("catalogue:publish")
    ) {
      throw new ApiError(
        403,
        "insufficient_scope",
        "This agent grant cannot change platform content.",
      );
    }
  } else if (ctx.actor.type !== "user") {
    throw new ApiError(
      403,
      "super_admin_required",
      "Platform content is restricted to a signed-in Super Admin.",
    );
  }
  return user;
}

export function roleLabel(
  user:
    | (Pick<CurrentUser, "role"> & {
        platformAdmin?: boolean;
        globalCollectionScope?: GlobalCollectionScope | null;
      })
    | null,
): string {
  if (!user) return "Guest";
  if (user.platformAdmin) return "Super Admin";
  if (user.globalCollectionScope) return "Global Collection Admin";
  if (user.role === "owner") return "Bot Owner";
  if (user.role === "editor" || user.role === "economy_admin") return "Bot Admin";
  return "User";
}

export function requireRecentStrongAuth(ctx: Ctx, maxAgeMinutes = 20): void {
  if (ctx.actor.type !== "user") {
    throw new ApiError(
      403,
      "human_strong_auth_required",
      "This action requires a signed-in human with recent strong authentication.",
    );
  }
  const method = ctx.sessionAssurance ?? "";
  if (method === "access" && (!ctx.accessIdentity || ctx.accessStatus !== "linked")) {
    throw new ApiError(
      403,
      "strong_auth_required",
      "This action needs recent strong authentication. Confirm with a passkey, authenticator code or Cloudflare Access to continue.",
    );
  }
  if (!["access", "passkey", "mfa"].includes(method)) {
    throw new ApiError(
      403,
      "strong_auth_required",
      "This action needs recent strong authentication. Confirm with a passkey, authenticator code or Cloudflare Access to continue.",
    );
  }
  if (method !== "access") {
    const age = ctx.sessionAuthTime
      ? Date.now() - new Date(ctx.sessionAuthTime).getTime()
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(age) || age > maxAgeMinutes * 60_000) {
      throw new ApiError(
        403,
        "strong_auth_stale",
        "Your strong authentication is stale. Confirm again to continue.",
      );
    }
  }
}

export async function requireProtectedAccount(ctx: Ctx): Promise<CurrentUser> {
  const user = requireUser(ctx);
  const row = await first<{ passkeys: number; totp: number; access: number; discord: number }>(
    ctx.db,
    `SELECT
       (SELECT COUNT(*) FROM fb_webauthn_credentials WHERE user_id = ?) AS passkeys,
       (SELECT COUNT(*) FROM fb_totp_secrets WHERE user_id = ? AND confirmed_at IS NOT NULL) AS totp,
       (SELECT COUNT(*) FROM fb_access_identities WHERE user_id = ? AND revoked_at IS NULL) AS access,
       (SELECT COUNT(*) FROM fb_discord_identities WHERE user_id = ? AND revoked_at IS NULL) AS discord`,
    user.id,
    user.id,
    user.id,
    user.id,
  );
  // A verified Discord OAuth link is a real identity even when the account has
  // no mailbox (Discord-only players use a non-routable placeholder address).
  // This never merges accounts on an unverified email string and never replaces
  // the separate strong-auth proof required for sensitive mutations.
  const verifiedIdentity =
    Boolean(user.emailVerified) || (row?.discord ?? 0) > 0 || (row?.access ?? 0) > 0;
  if (!verifiedIdentity) {
    throw new ApiError(
      403,
      "identity_verification_required",
      "Link a verified email, Discord identity or Cloudflare Access identity before creating or administering a Bot.",
    );
  }
  if (!row || (row.passkeys === 0 && row.totp === 0 && row.access === 0)) {
    throw new ApiError(
      403,
      "protected_account_required",
      "Set up a passkey or authenticator before creating or administering a Bot.",
    );
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
