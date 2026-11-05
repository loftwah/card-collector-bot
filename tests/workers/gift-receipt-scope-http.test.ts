import { beforeEach, describe, expect, it } from "vitest";
import type { APIContext } from "astro";
import { ALL } from "../../src/pages/api/v1/[...path]";
import { createSession } from "../../src/server/modules/identity";
import { bootstrap, ctxFor, runtime } from "./helpers";

async function client(email: string, tenant = "cabinet") {
  const ctx = await ctxFor(tenant, email);
  const session = await createSession(runtime.DB, ctx.tenant, ctx.user!, {
    authMethod: "mfa",
    assurance: "mfa",
  });
  return async (path: string, method = "GET", body?: unknown) => {
    const request = new Request(`http://localhost:5173/api/v1/${path}`, {
      method,
      headers: {
        cookie: `fb_session=${session.token}; fb_csrf=${session.csrf}`,
        "x-foilbury-csrf": session.csrf,
        "content-type": "application/json",
        "idempotency-key": "route-contract-test-key",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await ALL({ request, params: { path } } as unknown as APIContext);
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };
}

describe("HTTP gift receipt Bot scope", () => {
  beforeEach(async () => {
    await bootstrap();
  });
  it("returns only this Bot's gift awards, including platform campaigns targeting this Bot", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const playerCtx = await ctxFor("cabinet", "player@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_tenants (id,slug,name,created_at) VALUES ('ten_other','other','Other Bot',?)",
      ).bind(now),
      runtime.DB.prepare(
        "INSERT INTO fb_memberships (tenant_id,user_id,role,created_at,status) VALUES ('ten_other',?,'player',?,'active')",
      ).bind(playerCtx.user!.id, now),
      runtime.DB.prepare(
        `INSERT INTO fb_gift_campaigns (id,tenant_id,created_by,kind,scope,reason,status,idempotency_key,created_at,updated_at) VALUES ('camp_other','ten_other',?,'foil','platform_members','Private other-Bot reason','completed','other-gift',?,?)`,
      ).bind(owner.user!.id, now, now),
      runtime.DB.prepare(
        `INSERT INTO fb_gift_awards (id,campaign_id,tenant_id,user_id,kind,amount,status,receipt_json,created_at,delivered_at) VALUES ('award_other','camp_other','ten_other',?,'foil',10,'delivered','{"description":"Other Bot private"}',?,?)`,
      ).bind(playerCtx.user!.id, now, now),
      runtime.DB.prepare(
        `INSERT INTO fb_gift_campaigns (id,tenant_id,created_by,kind,scope,reason,status,idempotency_key,created_at,updated_at) VALUES ('camp_platform','ten_other',?,'foil','platform_members','Platform gift','completed','platform-gift',?,?)`,
      ).bind(owner.user!.id, now, now),
      runtime.DB.prepare(
        `INSERT INTO fb_gift_awards (id,campaign_id,tenant_id,user_id,kind,amount,status,receipt_json,created_at,delivered_at) VALUES ('award_here','camp_platform',?,?,'foil',20,'delivered','{"description":"Here"}',?,?)`,
      ).bind(owner.tenant.id, playerCtx.user!.id, now, now),
    ]);
    const player = await client("player@foilbury.local");
    const result = await player("gifts/received");
    expect(result.status).toBe(200);
    expect(result.json.items.map((item: { id: string }) => item.id)).toEqual(["award_here"]);
    expect(JSON.stringify(result.json)).not.toContain("Private other-Bot reason");
    const other = await client("player@foilbury.local", "other");
    const otherResult = await other("gifts/received");
    expect(otherResult.status).toBe(200);
    expect(otherResult.json.items.map((item: { id: string }) => item.id)).toEqual(["award_other"]);
    expect(JSON.stringify(otherResult.json)).not.toContain('"description":"Here"');
  });
});
