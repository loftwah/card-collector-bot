import type { D1Database } from "@cloudflare/workers-types";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ApiError, type CurrentUser, type Role, type Tenant } from "./context";
import { first, nowIso } from "./db";
import { newId } from "./ids";
import type { RuntimeConfig } from "./config";

export interface AccessIdentity {
  subject: string;
  email: string;
  audience: string;
  payload: JWTPayload;
}

export interface AccessResolution {
  identity: AccessIdentity;
  user: CurrentUser | null;
  status: "linked" | "unlinked" | "email_mismatch" | "disabled" | "not_member";
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export function clearAccessJwksCache(): void {
  jwksCache.clear();
}

export function isAccessProtectedPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/v1/admin" ||
    pathname.startsWith("/api/v1/admin/") ||
    pathname === "/platform-admin" ||
    pathname.startsWith("/platform-admin/") ||
    pathname === "/api/v1/platform" ||
    pathname.startsWith("/api/v1/platform/") ||
    pathname === "/_emdash" ||
    pathname.startsWith("/_emdash/")
  );
}

export function audienceForPath(config: RuntimeConfig, pathname: string): string | null {
  if (pathname.startsWith("/platform-admin") || pathname.startsWith("/api/v1/platform")) {
    return pathname.startsWith("/api/") ? config.access.platformApiAudience : config.access.platformAudience;
  }
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/v1/admin")) {
    return pathname.startsWith("/api/") ? config.access.apiAudience : config.access.adminAudience;
  }
  if (pathname.startsWith("/_emdash")) return config.access.editorialAudience;
  return null;
}

export function getAccessAssertion(request: Request): string | null {
  return (
    request.headers.get("cf-access-jwt-assertion") ??
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    null
  );
}

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  const existing = jwksCache.get(teamDomain);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, jwks);
  return jwks;
}

/**
 * Validate a Cloudflare Access application token. This is deliberately strict:
 * signature, issuer, audience and expiry are all checked. A header is never
 * accepted as identity on its own.
 */
export async function verifyAccessToken(
  token: string,
  config: RuntimeConfig,
  audience: string,
  options?: { jwks?: JWTVerifyGetKey; now?: number },
): Promise<AccessIdentity> {
  if (!config.access.enabled || !config.access.teamDomain) {
    throw new ApiError(503, "access_not_configured", "Cloudflare Access is not configured for this environment.");
  }
  if (!audience) throw new ApiError(503, "access_audience_missing", "Cloudflare Access audience is not configured.");

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, options?.jwks ?? jwksFor(config.access.teamDomain), {
      issuer: `https://${config.access.teamDomain}`,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
      clockTolerance: 5,
      currentDate: options?.now !== undefined ? new Date(options.now) : undefined,
    });
    payload = verified.payload;
  } catch {
    throw new ApiError(401, "access_token_invalid", "Your Cloudflare Access session is expired or invalid. Sign in again.");
  }

  if (payload.type !== "app") {
    throw new ApiError(401, "access_token_invalid", "Cloudflare Access did not provide an application token.");
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (!email || !email.includes("@") || !subject.trim()) {
    throw new ApiError(401, "access_identity_missing", "Cloudflare Access did not provide a verifiable email identity.");
  }
  // The standard Access application JWT does not include the IdP type or
  // establish that MFA occurred. Keep verified identity separate from the
  // application's authentication policy and Foilbury role checks.
  return {
    subject,
    email,
    audience,
    payload,
  };
}

/**
 * Read the IdP from Access's supported identity endpoint, after verifying the
 * assertion with verifyAccessToken. Mixed Cloudflare/OTP applications cannot
 * infer this from their audience or from an undocumented JWT claim.
 *
 * This proves the provider for this assertion, not that MFA occurred. Any
 * unavailable, mismatched or unrecognised response grants no extra assurance.
 */
export async function resolveAccessIdentityProvider(
  token: string,
  identity: AccessIdentity,
  config: RuntimeConfig,
  options?: { fetcher?: typeof fetch },
): Promise<"cloudflare" | null> {
  if (!config.access.enabled || !config.access.teamDomain) return null;
  try {
    const response = await (options?.fetcher ?? fetch)(
      `https://${config.access.teamDomain}/cdn-cgi/access/get-identity`,
      {
        headers: { cookie: `CF_Authorization=${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok || !response.body) return null;

    // Identity data can include groups. Bound the response before parsing and
    // keep the assertion, response and provider proof scoped to this request.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          return null;
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const profile: unknown = JSON.parse(body);
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    const data = profile as Record<string, unknown>;
    if (
      data.user_uuid !== identity.subject ||
      typeof data.email !== "string" ||
      data.email.trim().toLowerCase() !== identity.email
    ) return null;

    const idp = data.idp;
    return idp && typeof idp === "object" && "type" in idp && idp.type === "cloudflare"
      ? "cloudflare"
      : null;
  } catch {
    return null;
  }
}

async function loadMember(db: D1Database, tenantId: string, userId: string): Promise<CurrentUser | null> {
  const row = await first<{
    id: string;
    email: string;
    display_name: string;
    platform_admin: number;
    email_verified_at: string | null;
    disabled_at: string | null;
    role: Role;
    capabilities_json: string;
    avatar_kind: string | null;
    avatar_default_key: string | null;
    avatar_asset_id: string | null;
    avatar_updated_at: string | null;
  }>(
    db,
    `SELECT u.id, u.email, u.display_name, u.platform_admin, u.email_verified_at, u.disabled_at,
            u.avatar_kind, u.avatar_default_key, u.avatar_asset_id, u.avatar_updated_at,
            m.role, m.capabilities_json
       FROM fb_users u
       LEFT JOIN fb_memberships m ON m.user_id = u.id AND m.tenant_id = ? AND m.status = 'active'
      WHERE u.id = ?`,
    tenantId,
    userId,
  );
  if (!row || row.disabled_at) return null;
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    capabilities = [];
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role ?? "player",
    platformAdmin: Boolean(row.platform_admin),
    emailVerified: Boolean(row.email_verified_at),
    avatarKind: row.avatar_kind ?? "default",
    avatarDefaultKey: row.avatar_default_key ?? "keeper",
    avatarAssetId: row.avatar_asset_id,
    avatarUpdatedAt: row.avatar_updated_at,
    capabilities,
  };
}

export async function resolveAccessIdentity(
  db: D1Database,
  config: RuntimeConfig,
  tenant: Tenant,
  identity: AccessIdentity,
  requestId?: string,
): Promise<AccessResolution> {
  const linked = await first<{ id: string; user_id: string; email: string }>(
    db,
    `SELECT id, user_id, email FROM fb_access_identities
      WHERE team_domain = ? AND subject = ? AND revoked_at IS NULL`,
    config.access.teamDomain,
    identity.subject,
  );
  if (linked) {
    const user = await loadMember(db, tenant.id, linked.user_id);
    if (!user) return { identity, user: null, status: "disabled" };
    if (user.email.trim().toLowerCase() !== identity.email) {
      return { identity, user: null, status: "email_mismatch" };
    }
    await db
      .prepare("UPDATE fb_access_identities SET last_seen_at = ?, email = ? WHERE id = ?")
      .bind(nowIso(), identity.email, linked.id)
      .run()
      .catch(() => undefined);
    return { identity, user, status: "linked" };
  }

  // Only an explicitly allowlisted email can establish a new subject link.
  // An Access identity never becomes a Foilbury account by matching a display
  // name, guild role or unverified email string.
  const allow = await first<{ user_id: string }>(
    db,
    "SELECT user_id FROM fb_access_emails WHERE email = ? AND revoked_at IS NULL",
    identity.email,
  );
  if (!allow) return { identity, user: null, status: "unlinked" };

  const account = await first<{ id: string; email: string; email_verified_at: string | null; disabled_at: string | null }>(
    db,
    "SELECT id, email, email_verified_at, disabled_at FROM fb_users WHERE id = ?",
    allow.user_id,
  );
  if (!account) return { identity, user: null, status: "unlinked" };
  if (account.email.trim().toLowerCase() !== identity.email) {
    return { identity, user: null, status: "email_mismatch" };
  }
  if (account.disabled_at) return { identity, user: null, status: "disabled" };
  if (!account.email_verified_at) return { identity, user: null, status: "email_mismatch" };

  const user = await loadMember(db, tenant.id, account.id);
  if (!user) return { identity, user: null, status: "not_member" };

  const existingSubject = await first<{ id: string; user_id: string }>(
    db,
    "SELECT id, user_id FROM fb_access_identities WHERE team_domain = ? AND subject = ?",
    config.access.teamDomain,
    identity.subject,
  );
  if (existingSubject && existingSubject.user_id !== account.id) {
    return { identity, user: null, status: "email_mismatch" };
  }

  const now = nowIso();
  if (existingSubject) {
    await db
      .prepare("UPDATE fb_access_identities SET revoked_at = NULL, linked_at = ?, last_seen_at = ?, email = ? WHERE id = ?")
      .bind(now, now, identity.email, existingSubject.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO fb_access_identities
          (id, user_id, team_domain, subject, email, audience, linked_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId("aid"), account.id, config.access.teamDomain, identity.subject, identity.email, identity.audience, now, now)
      .run();
  }
  await db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'system', 'cloudflare-access', ?, 'access.identity.linked', 'user', ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      tenant.id,
      account.id,
      account.id,
      JSON.stringify({ email: identity.email, audience: identity.audience, authentication: "cloudflare_access" }),
      requestId ?? null,
      now,
    )
    .run()
    .catch(() => undefined);
  return { identity, user, status: "linked" };
}

export function assertPlatformAccessIdentity(identity: AccessIdentity, config: RuntimeConfig): void {
  // These dedicated Access applications enforce the platform identity policy
  // at the edge. Their verified audience is the contract; a fabricated JWT
  // IdP claim is not. Foilbury still requires its explicit Super Admin role.
  const platformAudiences = [config.access.platformAudience, config.access.platformApiAudience];
  if (!config.access.enabled || !platformAudiences.some((audience) => Boolean(audience) && audience === identity.audience)) {
    throw new ApiError(403, "access_platform_required", "Sign in through the Cloudflare Access application for platform administration.");
  }
}

/**
 * Resolve the tenant a verified Access identity should administer when the
 * default site tenant is not one of their memberships. This is the first-entry
 * path for an independent creator: Access authenticates, Foilbury memberships
 * decide which Bot they may administer.
 */
export async function findAccessTenantForIdentity(
  db: D1Database,
  config: RuntimeConfig,
  identity: AccessIdentity,
  excludeTenantId?: string,
): Promise<Tenant | null> {
  const linked = await first<{ user_id: string }>(
    db,
    "SELECT user_id FROM fb_access_identities WHERE team_domain = ? AND subject = ? AND revoked_at IS NULL",
    config.access.teamDomain,
    identity.subject,
  );
  const allow = linked
    ? linked
    : await first<{ user_id: string }>(
        db,
        "SELECT user_id FROM fb_access_emails WHERE email = ? AND revoked_at IS NULL",
        identity.email,
      );
  if (!allow) return null;
  const row = await first<{ id: string; slug: string; name: string }>(
    db,
    `SELECT t.id, t.slug, t.name
       FROM fb_memberships m
       JOIN fb_tenants t ON t.id = m.tenant_id
       LEFT JOIN fb_bots b ON b.tenant_id = t.id
      WHERE m.user_id = ? AND m.status = 'active' AND t.id <> ?
      ORDER BY CASE WHEN b.owner_user_id = ? THEN 0 ELSE 1 END, m.created_at
      LIMIT 1`,
    allow.user_id,
    excludeTenantId ?? "",
    allow.user_id,
  );
  return row ?? null;
}

