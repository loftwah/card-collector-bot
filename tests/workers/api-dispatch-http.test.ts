import { beforeEach, describe, expect, it } from "vitest";
import type { APIContext } from "astro";
import { ALL } from "../../src/pages/api/v1/[...path]";
import { createAgentGrant, createSession } from "../../src/server/modules/identity";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { createTrade } from "../../src/server/modules/trades";
import suffixRegressions from "../fixtures/api-suffix-regressions.json";

async function client(email: string) {
  const ctx = await ctxFor("cabinet", email);
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

describe("HTTP API dispatch boundaries", () => {
  beforeEach(async () => {
    await bootstrap();
  });
  it("rejects unknown suffixes before player, admin or mutation handlers", async () => {
    const player = await client("player@foilbury.local");
    const owner = await client("owner@foilbury.local");
    const before = await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_reward_claims").first<{
      n: number;
    }>();
    const preferencesBefore = await runtime.DB.prepare(
      "SELECT sharing_enabled FROM fb_player_preferences WHERE user_id = ?",
    )
      .bind((await ctxFor("cabinet", "player@foilbury.local")).user!.id)
      .first();
    for (const [send, path, method, body] of [
      [player, "me/preferences/extra", "GET", undefined],
      [player, "me/preferences/extra", "PATCH", { sharingEnabled: true }],
      [player, "rewards/claim/extra", "POST", {}],
      [player, "draws/extra", "POST", {}],
      [player, "trades/trd_missing/accept/extra", "POST", {}],
      [owner, "admin/economy/extra", "GET", undefined],
      [owner, "admin/economy/extra", "PATCH", { dailyReward: 1 }],
      [owner, "admin/agents/missing/revoke/extra", "POST", {}],
      [owner, "admin/members/extra", "GET", undefined],
    ] as const) {
      const result = await send(path, method, body);
      expect(result.status, `${method} ${path}`).toBe(404);
      expect(result.json.error?.code, `${method} ${path}`).toBe("not_found");
    }
    const after = await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_reward_claims").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
    const preferencesAfter = await runtime.DB.prepare(
      "SELECT sharing_enabled FROM fb_player_preferences WHERE user_id = ?",
    )
      .bind((await ctxFor("cabinet", "player@foilbury.local")).user!.id)
      .first();
    expect(preferencesAfter).toEqual(preferencesBefore);
  });
  it("rejects unknown suffixes on every previously prefix-matching method branch", async () => {
    const owner = await client("owner@foilbury.local");
    for (const [method, path] of suffixRegressions) {
      const response = await owner(path!, method!, method === "GET" ? undefined : {});
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.json.error?.code, `${method} ${path}`).toBe("not_found");
    }
  });
  it("preserves a single trailing slash and rejects empty interior segments and unsupported methods", async () => {
    const player = await client("player@foilbury.local");
    expect((await player("me/preferences/")).status).toBe(200);
    for (const [path, method] of [
      ["me//preferences", "GET"],
      ["me/preferences//", "GET"],
      ["me/preferences", "DELETE"],
    ] as const) {
      const result = await player(path, method);
      expect(result.status, `${method} ${path}`).toBe(404);
      expect(result.json.error?.code).toBe("not_found");
    }
  });
  it("dispatches trade detail and gift receipts as distinct resources through HTTP", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const playerCtx = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const ownerCard = await makeInstance(owner, owner.user!.id, fixture, "HTTP-TRADE-1");
    const playerCard = await makeInstance(playerCtx, playerCtx.user!.id, fixture, "HTTP-TRADE-2");
    const trade = await createTrade(owner, {
      recipientId: playerCtx.user!.id,
      proposerInstanceIds: [ownerCard],
      recipientInstanceIds: [playerCard],
    });
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO fb_gift_campaigns (id,tenant_id,created_by,kind,scope,reason,status,idempotency_key,created_at,updated_at) VALUES ('camp_http',?,?,'foil','single','HTTP test','completed','http-gift',?,?)`,
      ).bind(owner.tenant.id, owner.user!.id, now, now),
      runtime.DB.prepare(
        `INSERT INTO fb_gift_awards (id,campaign_id,tenant_id,user_id,kind,amount,status,receipt_json,created_at,delivered_at) VALUES ('award_http','camp_http',?,?,'foil',20,'delivered','{"description":"HTTP gift"}',?,?)`,
      ).bind(owner.tenant.id, playerCtx.user!.id, now, now),
    ]);
    const ownerHttp = await client("owner@foilbury.local");
    const player = await client("player@foilbury.local");
    const list = await ownerHttp("trades");
    const detail = await ownerHttp(`trades/${trade.id}`);
    expect(list.status).toBe(200);
    expect(list.json.items.some((item: { id: string }) => item.id === trade.id)).toBe(true);
    expect(detail.status).toBe(200);
    expect(detail.json.id).toBe(trade.id);
    expect(detail.json.items.map((item: { serial: string }) => item.serial).sort()).toEqual([
      "HTTP-TRADE-1",
      "HTTP-TRADE-2",
    ]);
    const sent = await player("gifts");
    const received = await player("gifts/received");
    expect(sent.status).toBe(200);
    expect(sent.json.items).toEqual([]);
    expect(received.status).toBe(200);
    expect(received.json.items.map((item: { id: string }) => item.id)).toEqual(["award_http"]);
    expect(received.json.items[0].description).toBe("HTTP gift");
  });
  it("does not offer revoked or synthetic users as trade peers", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const request = await client("owner@foilbury.local");
    expect(
      (await request("members")).json.items.some(
        (item: { id: string }) => item.id === player.user!.id,
      ),
    ).toBe(true);
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET revoked_at = ? WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), owner.tenant.id, player.user!.id)
      .run();
    expect(
      (await request("members")).json.items.some(
        (item: { id: string }) => item.id === player.user!.id,
      ),
    ).toBe(false);
    await runtime.DB.batch([
      runtime.DB.prepare(
        "UPDATE fb_memberships SET revoked_at = NULL WHERE tenant_id = ? AND user_id = ?",
      ).bind(owner.tenant.id, player.user!.id),
      runtime.DB.prepare("UPDATE fb_users SET is_synthetic = 1 WHERE id = ?").bind(player.user!.id),
    ]);
    expect(
      (await request("members")).json.items.some(
        (item: { id: string }) => item.id === player.user!.id,
      ),
    ).toBe(false);
  });
  it("enforces the directory scope for agent HTTP requests", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    for (const [scope, expected] of [
      ["content:read", 403],
      ["inventory:read", 200],
    ] as const) {
      const grant = await createAgentGrant(owner, {
        agentName: `directory-${scope}`,
        representedUserId: player.user!.id,
        scopes: [scope],
        expiresInDays: 1,
      });
      const request = new Request("http://localhost:5173/api/v1/members", {
        headers: { authorization: `Bearer ${grant.token}` },
      });
      const response = await ALL({ request, params: { path: "members" } } as unknown as APIContext);
      expect(response.status).toBe(expected);
      if (expected === 200) {
        const json = (await response.json()) as { items: Array<Record<string, unknown>> };
        expect(
          json.items.every((item) => !("email" in item) && !("capabilities_json" in item)),
        ).toBe(true);
      }
    }
  });
  it("separates ordinary peer discovery from privileged membership administration", async () => {
    const player = await client("player@foilbury.local");
    const directory = await player("members");
    expect(directory.status).toBe(200);
    expect(Array.isArray(directory.json.items)).toBe(true);
    expect(
      directory.json.items.every(
        (item: Record<string, unknown>) => !("email" in item) && !("capabilities_json" in item),
      ),
    ).toBe(true);
    const privileged = await player("admin/members");
    expect(privileged.status).toBe(403);
    const owner = await client("owner@foilbury.local");
    const admin = await owner("admin/members");
    expect(admin.status).toBe(200);
    expect(
      admin.json.items.some((item: Record<string, unknown>) => typeof item.email === "string"),
    ).toBe(true);
  });
});
