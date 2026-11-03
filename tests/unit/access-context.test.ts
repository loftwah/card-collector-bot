import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  bindings: {} as Record<string, unknown>,
  verifyAccessToken: vi.fn(),
  resolveAccessIdentity: vi.fn(),
  resolveAccessIdentityProvider: vi.fn(),
  findAccessTenantForIdentity: vi.fn(),
  assertPlatformAccessIdentity: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: state.bindings }));
vi.mock("../../src/server/access", () => ({
  ...state,
  getAccessAssertion: (request: Request) => request.headers.get("cf-access-jwt-assertion"),
  isAccessProtectedPath: (path: string) => path.startsWith("/platform-admin") || path.startsWith("/api/v1/platform/") || path.startsWith("/api/v1/admin/"),
  audienceForPath: (_config: unknown, path: string) => path.startsWith("/platform-admin") ? "platform-page" : path.startsWith("/api/v1/platform/") ? "platform-api" : "admin-api",
}));

import { buildContext, requireRecentStrongAuth, requireSuperAdmin } from "../../src/server/context";

const tenant = { id: "tenant-test", slug: "cabinet", name: "Cabinet" };
const owner = { id: "owner-test", email: "owner@example.test", displayName: "Owner", role: "owner" as const, platformAdmin: true, emailVerified: true, capabilities: [] };
const identity = { subject: "verified-subject", email: owner.email, audience: "platform-api", payload: { type: "app" } };
let session: Record<string, unknown>;
let writes: string[];

function request(path = "/api/v1/platform/bots/test/status", method = "POST", assertion = true) {
  return new Request(`https://foilbury.example.test${path}`, {
    method,
    headers: {
      cookie: "fb_session=existing-session; fb_csrf=csrf-cookie",
      ...(assertion ? { "cf-access-jwt-assertion": "verified-by-token-boundary" } : {}),
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  writes = [];
  session = {
    id: "session-test", user_id: owner.id, csrf_token: "csrf-stored",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null,
    assurance: "oauth", auth_time: new Date().toISOString(),
    email: owner.email, display_name: owner.displayName, platform_admin: 1,
    email_verified_at: new Date().toISOString(), capabilities_json: "[]", role: "owner", disabled_at: null,
    tenant_id: tenant.id, tenant_slug: tenant.slug, tenant_name: tenant.name,
  };
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () => {
          if (sql.includes("FROM fb_tenants")) return tenant;
          if (sql.includes("FROM fb_sessions s")) return session;
          throw new Error(`Unexpected fixture read: ${sql}`);
        },
        run: async () => { writes.push(sql); return { meta: { changes: 1 } }; },
      };
      return statement;
    },
  };
  Object.assign(state.bindings, {
    DB: db, MEDIA: {}, FOILBURY_ENV: "production", FOILBURY_TENANT_SLUG: "cabinet",
    FOILBURY_SESSION_SECRET: "s".repeat(32), FOILBURY_CSRF_SECRET: "c".repeat(32), FOILBURY_AGENT_TOKEN_PEPPER: "a".repeat(32),
    FOILBURY_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    FOILBURY_ACCESS_PLATFORM_AUD: "platform-page", FOILBURY_ACCESS_PLATFORM_API_AUD: "platform-api",
    FOILBURY_ACCESS_AUD: "admin-page", FOILBURY_ACCESS_API_AUD: "admin-api",
  });
  state.verifyAccessToken.mockResolvedValue(identity);
  state.resolveAccessIdentity.mockResolvedValue({ status: "linked", identity, user: owner });
  state.resolveAccessIdentityProvider.mockResolvedValue(null);
});

describe("Access assurance at the request boundary", () => {
  it("uses fresh platform Access proof with an existing OAuth session without persisting stronger assurance", async () => {
    const ctx = await buildContext(request());
    expect(ctx.user?.id).toBe(owner.id);
    expect(ctx.sessionId).toBe("session-test");
    expect(ctx.csrfToken).toBe("csrf-stored");
    expect(ctx.sessionAssurance).toBe("access");
    expect(() => requireRecentStrongAuth(ctx)).not.toThrow();
    expect(state.verifyAccessToken).toHaveBeenCalledWith("verified-by-token-boundary", expect.anything(), "platform-api");
    expect(state.assertPlatformAccessIdentity).toHaveBeenCalledWith(identity, expect.anything());
    expect(state.resolveAccessIdentityProvider).not.toHaveBeenCalled();
    expect(writes.every((sql) => sql.startsWith("UPDATE fb_sessions SET last_seen_at"))).toBe(true);
    expect(session.assurance).toBe("oauth");
  });

  it("rejects a different signed-in person without looking up provider assurance", async () => {
    session.user_id = "another-person";
    const ctx = await buildContext(request());
    expect(ctx.user).toBeNull();
    expect(ctx.sessionId).toBeNull();
    expect(ctx.sessionAssurance).toBeNull();
    expect(ctx.accessStatus).toBe("email_mismatch");
    expect(state.resolveAccessIdentityProvider).not.toHaveBeenCalled();
    expect(() => requireSuperAdmin(ctx)).toThrow();
  });

  it("does not let an old application cookie substitute for the Access assertion", async () => {
    session.assurance = "access";
    await expect(buildContext(request(undefined, "POST", false))).rejects.toMatchObject({ code: "access_required" });
    expect(state.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("does not reuse a legacy Access-assured cookie outside the verified Access request", async () => {
    session.assurance = "access";
    const ctx = await buildContext(request("/api/v1/bots", "POST", false));
    expect(ctx.accessIdentity).toBeNull();
    expect(() => requireRecentStrongAuth(ctx)).toThrow();
  });

  it("accepts a confirmed Cloudflare-account provider for a Bot admin mutation", async () => {
    state.resolveAccessIdentityProvider.mockResolvedValue("cloudflare");
    const ctx = await buildContext(request("/api/v1/admin/collections"));
    expect(state.resolveAccessIdentityProvider).toHaveBeenCalledWith("verified-by-token-boundary", identity, expect.anything());
    expect(ctx.sessionAssurance).toBe("access");
    expect(() => requireRecentStrongAuth(ctx)).not.toThrow();
  });

  it("does not promote an email PIN or unconfirmed provider to Access assurance", async () => {
    session.assurance = "access";
    const ctx = await buildContext(request("/api/v1/admin/collections"));
    expect(ctx.sessionAssurance).toBe("email");
    expect(() => requireRecentStrongAuth(ctx)).toThrow();
  });

  it("retains a recent passkey proof without an unnecessary provider lookup", async () => {
    session.assurance = "passkey";
    const ctx = await buildContext(request("/api/v1/admin/collections"));
    expect(ctx.sessionAssurance).toBe("passkey");
    expect(state.resolveAccessIdentityProvider).not.toHaveBeenCalled();
    expect(() => requireRecentStrongAuth(ctx)).not.toThrow();
  });

  it("does not perform a provider lookup for a read-only Bot admin request", async () => {
    const ctx = await buildContext(request("/api/v1/admin/status", "GET"));
    expect(ctx.user?.id).toBe(owner.id);
    expect(state.resolveAccessIdentityProvider).not.toHaveBeenCalled();
  });

  it("uses current Cloudflare proof when a local factor is too old for a gift", async () => {
    session.assurance = "mfa";
    session.auth_time = new Date(Date.now() - 16 * 60_000).toISOString();
    state.resolveAccessIdentityProvider.mockResolvedValue("cloudflare");
    const ctx = await buildContext(request("/api/v1/admin/gifts/preview"));
    expect(state.resolveAccessIdentityProvider).toHaveBeenCalled();
    expect(ctx.sessionAssurance).toBe("access");
    expect(() => requireRecentStrongAuth(ctx, 15)).not.toThrow();
  });

  it("never grants Super Admin from successful Access authentication", async () => {
    state.resolveAccessIdentity.mockResolvedValue({ status: "linked", identity, user: { ...owner, platformAdmin: false } });
    const ctx = await buildContext(request());
    expect(ctx.sessionAssurance).toBe("access");
    expect(() => requireSuperAdmin(ctx)).toThrow(/Super Admin/);
  });
});
