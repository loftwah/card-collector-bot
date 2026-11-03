import { describe, expect, it } from "vitest";
import { ACCESS_HANDOFF_QUERY, ACCESS_SESSION_HEADER, safeAccessReturnTo, type AccessArea } from "../../src/lib/access-session";
import { accessSessionResponse } from "../../src/server/access-session";
import type { Ctx } from "../../src/server/context";

function context(area: AccessArea = "admin"): Ctx {
  return {
    actor: { type: "user", id: "owner-test", representedUserId: "owner-test", label: "Owner" },
    user: { id: "owner-test", email: "owner@example.test", displayName: "Owner", role: "owner", platformAdmin: true },
    config: {
      environment: "production",
      access: { enabled: true, apiAudience: "admin-api", platformApiAudience: "platform-api" },
    },
    accessStatus: "linked",
    accessIdentity: { subject: "verified-subject", email: "owner@example.test", audience: `${area}-api`, payload: { type: "app" } },
  } as Ctx;
}

describe("administration API session handoff", () => {
  it.each(["admin", "platform"] as const)("confirms %s admission without returning credentials", (area) => {
    const response = accessSessionResponse(new Request(`https://foilbury.example.test/api/v1/${area}/access-session?check=1`), context(area), area);
    expect(response.status).toBe(204);
    expect(response.headers.get(ACCESS_SESSION_HEADER)).toBe(area);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns only to the same admin area and marks the completed handoff", () => {
    const returnTo = "/admin/catalogue?status=draft#edition";
    const response = accessSessionResponse(new Request(`https://foilbury.example.test/api/v1/admin/access-session?returnTo=${encodeURIComponent(returnTo)}`), context(), "admin");
    expect(response.status).toBe(303);
    const destination = new URL(response.headers.get("location")!, "https://foilbury.example.test");
    expect(destination.pathname).toBe("/admin/catalogue");
    expect(destination.searchParams.get("status")).toBe("draft");
    expect(destination.searchParams.get(ACCESS_HANDOFF_QUERY)).toBe("admin");
    expect(destination.hash).toBe("#edition");
  });

  it("rejects external, normalised traversal, lookalike and cross-area return paths", () => {
    for (const value of [
      "https://attacker.example/admin", "//attacker.example/admin", "/\\attacker.example/admin",
      "/admin/../../platform-admin", "/admin/%2e%2e//attacker.example", "/administrator",
      "/platform-admin", "/admin\n/anything", "javascript:alert(1)",
    ]) expect(safeAccessReturnTo(value, "admin"), value).toBe("/admin");
    expect(safeAccessReturnTo("/admin", "platform")).toBe("/platform-admin");
    expect(safeAccessReturnTo("/platform-admin/accounts?filter=active", "platform")).toBe("/platform-admin/accounts?filter=active");
  });

  it("does not treat the return marker as API authentication", () => {
    const ctx = context();
    ctx.accessIdentity = null;
    const request = new Request(`https://foilbury.example.test/api/v1/admin/access-session?check=1&${ACCESS_HANDOFF_QUERY}=admin`);
    expect(() => accessSessionResponse(request, ctx, "admin")).toThrow(/Cloudflare Access/);
  });

  it("requires the API audience, linked user, and role even after page admission", () => {
    const request = new Request("https://foilbury.example.test/api/v1/admin/access-session?check=1");
    const wrongAudience = context();
    wrongAudience.accessIdentity!.audience = "admin-page";
    expect(() => accessSessionResponse(request, wrongAudience, "admin")).toThrow(/Cloudflare Access/);
    const unlinked = context();
    unlinked.accessStatus = "unlinked";
    expect(() => accessSessionResponse(request, unlinked, "admin")).toThrow(/Cloudflare Access/);
    const player = context();
    player.user!.role = "player";
    expect(() => accessSessionResponse(request, player, "admin")).toThrow(/role/);
    const ordinaryAdmin = context("platform");
    ordinaryAdmin.user!.platformAdmin = false;
    expect(() => accessSessionResponse(request, ordinaryAdmin, "platform")).toThrow(/Super Admin/);
  });

  it("does not turn an agent token or mutation into a browser sign-in", () => {
    const agent = context();
    agent.actor.type = "agent";
    expect(() => accessSessionResponse(new Request("https://foilbury.example.test/api/v1/admin/access-session"), agent, "admin")).toThrow(/Sign in/);
    expect(() => accessSessionResponse(new Request("https://foilbury.example.test/api/v1/admin/access-session", { method: "POST" }), context(), "admin")).toThrow(/GET/);
  });

  it("retains trusted local administration without allowing a missing production Access configuration", () => {
    const ctx = context();
    ctx.config.access.enabled = false;
    const request = new Request("http://localhost:5173/api/v1/admin/access-session?check=1");
    expect(() => accessSessionResponse(request, ctx, "admin")).toThrow(/Cloudflare Access/);
    ctx.config.environment = "local";
    expect(accessSessionResponse(request, ctx, "admin").status).toBe(204);
  });
});
