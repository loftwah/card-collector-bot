import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ buildContext: vi.fn(), createSession: vi.fn(), sessionCookies: vi.fn() }));
vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock("../../src/server/context", () => ({
  buildContext: mocks.buildContext,
  runtimeEnv: () => ({}),
  ApiError: class extends Error {},
}));
vi.mock("../../src/server/modules/identity", () => ({ createSession: mocks.createSession }));
vi.mock("../../src/server/api/helpers", () => ({ sessionCookies: mocks.sessionCookies }));

import { onRequest } from "../../src/middleware";
import { requestReference } from "../../src/server/ids";

function fixture(sessionId: string | null = null) {
  const request = new Request("https://foilbury.example.test/platform-admin");
  const locals: App.Locals = { requestId: "test-request", theme: "system" };
  const context = {
    request, url: new URL(request.url), locals, cookies: { get: () => undefined },
    redirect: (location: string) => new Response(null, { status: 302, headers: { location } }),
  };
  const ctx = {
    tenant: { id: "tenant-test", slug: "cabinet" },
    user: { id: "owner-test", email: "owner@example.test", displayName: "Owner", role: "owner", platformAdmin: true },
    sessionId, csrfToken: sessionId ? "existing-csrf" : "", actor: { type: "user" },
    accessIdentity: { subject: "verified-subject", email: "owner@example.test", audience: "platform-page", payload: { type: "app" } },
    accessStatus: "linked", config: { access: { enabled: true } },
    db: { prepare: () => ({ bind: () => ({ first: async () => ({ balance: 0 }) }) }) },
  };
  mocks.buildContext.mockResolvedValue(ctx);
  return { context, ctx, locals };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createSession.mockResolvedValue({ token: "fixture-session", csrf: "fresh-csrf", expiresAt: "2030-01-01T00:00:00Z" });
  mocks.sessionCookies.mockReturnValue(["fb_session=fixture-session; HttpOnly; Secure", "fb_csrf=fresh-csrf; Secure"]);
});

describe("first Access page response", () => {
  it("keeps one bounded reference across middleware and downstream work", async () => {
    const { context, locals } = fixture("existing-session");
    context.request = new Request("https://foilbury.example.test/platform-admin", { headers: { "cf-ray": "cookie=fixture-secret" } });
    context.url = new URL(context.request.url);
    await onRequest(context as never, async () => {
      expect(locals.requestId).toBe(requestReference(context.request));
      expect(locals.requestId).toMatch(/^req_[0-9a-z]{24}$/);
      expect(locals.requestId).not.toContain("fixture-secret");
      return new Response("ok");
    });
  });
  it("renders the fresh CSRF value before the page and its session cookies are returned", async () => {
    const { context, locals } = fixture();
    const response = await onRequest(context as never, async () => {
      expect(locals.foilbury?.csrfToken).toBe("fresh-csrf");
      expect(mocks.createSession).toHaveBeenCalledTimes(1);
      return new Response("admin page");
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("fb_csrf=fresh-csrf");
    expect(mocks.createSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.objectContaining({ assurance: "email", authMethod: "cloudflare_access" }));
    expect(mocks.sessionCookies).toHaveBeenCalledWith("fixture-session", "fresh-csrf", "2030-01-01T00:00:00Z", true);
  });

  it("reuses a matching existing session and CSRF value", async () => {
    const { context, locals } = fixture("existing-session");
    const response = await onRequest(context as never, async () => {
      expect(locals.foilbury?.csrfToken).toBe("existing-csrf");
      return new Response("admin page");
    });
    expect(response.status).toBe(200);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not create an app session for an Access user without Super Admin authority", async () => {
    const { context, ctx } = fixture();
    ctx.user.platformAdmin = false;
    const next = vi.fn();
    const response = await onRequest(context as never, next);
    expect(response.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
