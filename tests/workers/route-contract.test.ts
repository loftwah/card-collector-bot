import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { routeApi } from "../../src/server/api/router";
import { ApiError, type Ctx } from "../../src/server/context";
import { createTrade } from "../../src/server/modules/trades";
import { nowIso } from "../../src/server/db";

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost:5173${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-foilbury-csrf": "test",
      ...(body ? { "idempotency-key": `test-${Math.random().toString(36).slice(2)}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function agentFor(ctx: Ctx, scopes: string[]): Ctx {
  return {
    ...ctx,
    actor: { type: "agent", id: "grant_test", representedUserId: ctx.user!.id, label: "Test agent" },
    scopes,
  };
}

async function sendJson(ctx: Ctx, path: string, method: string, body?: unknown) {
  try {
    const response = await routeApi(request(path, method, body), ctx, path.replace(/^\/api\/v1\//, ""));
    const json = (await response.json()) as Record<string, unknown>;
    return { response, json };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        response: { status: error.status } as Response,
        json: { error: { code: error.code, message: error.message } } as Record<string, unknown>,
      };
    }
    throw error;
  }
}

describe("exact API dispatch and least-privilege player scopes", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("routes gift receipts, trade detail and peer discovery to their own handlers", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);

    // A sent gift must not be returned by the received-receipts handler.
    const campaignId = "gftc_contract";
    const now = nowIso();
    await runtime.DB.batch([
      runtime.DB
        .prepare(
          `INSERT INTO fb_gift_campaigns
            (id, tenant_id, created_by, kind, scope, recipient_rule_json, item_json, message, reason, status,
             expected_recipients, sent_count, failed_count, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'foil', 'single', '{}', '{"amount":25}', NULL, 'Contract test', 'completed', 1, 1, 0, 'contract-gift', ?, ?)`,
        )
        .bind(campaignId, owner.tenant.id, owner.user!.id, now, now),
      runtime.DB
        .prepare(
          `INSERT INTO fb_gift_awards
            (id, campaign_id, tenant_id, user_id, kind, amount, status, receipt_json, created_at, delivered_at)
           VALUES ('gfa_contract', ?, ?, ?, 'foil', 25, 'delivered', '{"amount":25,"description":"Contract gift"}', ?, ?)`,
        )
        .bind(campaignId, owner.tenant.id, player.user!.id, now, now),
    ]);

    const gifts = await sendJson(player, "/api/v1/gifts", "GET");
    const received = await sendJson(player, "/api/v1/gifts/received", "GET");
    expect(gifts.response.status).toBe(200);
    expect(received.response.status).toBe(200);
    const receivedItems = received.json.items as Array<Record<string, unknown>>;
    expect(receivedItems).toHaveLength(1);
    expect(receivedItems[0]!.receipt).toEqual({ amount: 25, description: "Contract gift" });
    expect((gifts.json.items as unknown[]).length).toBe(0);

    const ownerCard = await makeInstance(owner, owner.user!.id, fixture, "CONTRACT-TRADE-1");
    const playerCard = await makeInstance(player, player.user!.id, fixture, "CONTRACT-TRADE-2");
    const trade = await createTrade(owner, {
      recipientId: player.user!.id,
      proposerInstanceIds: [ownerCard],
      recipientInstanceIds: [playerCard],
    });
    const list = await sendJson(owner, "/api/v1/trades", "GET");
    expect(list.response.status).toBe(200);
    expect(Array.isArray((list.json.items as Array<Record<string, unknown>>)[0]?.items)).toBe(false);
    const detail = await sendJson(owner, `/api/v1/trades/${trade.id}`, "GET");
    expect(detail.response.status).toBe(200);
    expect(detail.json.id).toBe(trade.id);
    expect(Array.isArray(detail.json.items)).toBe(true);
    const unknown = await sendJson(owner, `/api/v1/trades/${trade.id}/extra`, "GET");
    expect(unknown.response.status).toBe(404);

    const directory = await sendJson(player, "/api/v1/members", "GET");
    expect(directory.response.status).toBe(200);
    const members = directory.json.items as Array<Record<string, unknown>>;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => !("email" in member))).toBe(true);
    expect(members.every((member) => !("capabilities_json" in member))).toBe(true);
  });

  it("hides suspended members from peer discovery while the privileged route keeps them", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await runtime.DB
      .prepare("UPDATE fb_memberships SET status = 'suspended' WHERE tenant_id = ? AND user_id = ?")
      .bind(owner.tenant.id, player.user!.id)
      .run();
    // The suspended user's cookie would already be invalid. Exercise the
    // directory as a remaining active member without changing their session.
    const directory = await sendJson(owner, "/api/v1/members", "GET");
    const members = directory.json.items as Array<Record<string, unknown>>;
    expect(members.some((member) => member.id === player.user!.id)).toBe(false);
    const privileged = await sendJson(owner, "/api/v1/admin/members", "GET");
    expect(privileged.response.status).toBe(200);
    const adminMembers = privileged.json.items as Array<Record<string, unknown>>;
    expect(adminMembers.some((member) => member.id === player.user!.id)).toBe(true);
    expect(adminMembers.some((member) => typeof member.email === "string")).toBe(true);
    await runtime.DB.prepare("UPDATE fb_memberships SET status = 'active' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
  });

  it("denies unrelated agent scopes and leaves protected state untouched", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(player, player.user!.id, fixture, "SCOPE-INSTANCE-1");
    const inventoryOnly = agentFor(player, ["inventory:read"]);
    const contentOnly = agentFor(player, ["content:read"]);

    const inventory = await sendJson(inventoryOnly, "/api/v1/inventory", "GET");
    expect(inventory.response.status).toBe(200);
    const unrelatedRead = await sendJson(contentOnly, "/api/v1/inventory", "GET");
    expect(unrelatedRead.response.status).toBe(403);
    expect((unrelatedRead.json.error as { code: string }).code).toBe("insufficient_scope");

    const preferencesBefore = await runtime.DB
      .prepare("SELECT sharing_enabled FROM fb_player_preferences WHERE tenant_id = ? AND user_id = ?")
      .bind(player.tenant.id, player.user!.id)
      .first<{ sharing_enabled: number }>();
    const prefDenied = await sendJson(inventoryOnly, "/api/v1/me/preferences", "PATCH", { sharingEnabled: true });
    expect(prefDenied.response.status).toBe(403);
    const preferencesAfter = await runtime.DB
      .prepare("SELECT sharing_enabled FROM fb_player_preferences WHERE tenant_id = ? AND user_id = ?")
      .bind(player.tenant.id, player.user!.id)
      .first<{ sharing_enabled: number }>();
    expect(preferencesAfter?.sharing_enabled ?? 0).toBe(preferencesBefore?.sharing_enabled ?? 0);

    const sharesBefore = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_share_links WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    const shareDenied = await sendJson(inventoryOnly, "/api/v1/shares", "POST", { kind: "cabinet", expiresInDays: 7 });
    expect(shareDenied.response.status).toBe(403);
    const sharesAfter = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_share_links WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(sharesAfter?.count ?? 0).toBe(sharesBefore?.count ?? 0);

    const favouriteDenied = await sendJson(inventoryOnly, `/api/v1/instances/${instanceId}/favourite`, "POST", { favourite: true });
    expect(favouriteDenied.response.status).toBe(403);
    const favourite = await runtime.DB.prepare("SELECT favourite FROM fb_card_instances WHERE id = ?").bind(instanceId).first<{ favourite: number }>();
    expect(favourite?.favourite).toBe(0);

    const wishDenied = await sendJson(inventoryOnly, "/api/v1/wishlist", "POST", { cardId: fixture.cardId, wanted: true });
    expect(wishDenied.response.status).toBe(403);
    const wishes = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_wishlists WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ count: number }>();
    expect(wishes?.count ?? 0).toBe(0);

    const claimDenied = await sendJson(inventoryOnly, "/api/v1/rewards/claim", "POST", {});
    expect(claimDenied.response.status).toBe(403);
    const evaluateDenied = await sendJson(inventoryOnly, "/api/v1/achievements/evaluate", "POST", {});
    expect(evaluateDenied.response.status).toBe(403);
    const joinDenied = await sendJson(inventoryOnly, "/api/v1/me/join", "POST", {});
    expect(joinDenied.response.status).toBe(403);
  });

  it("exposes the exact approved distribution and accepts that fingerprint", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(owner);
    const preview = await sendJson(player, "/api/v1/pools/test-pool", "GET");
    expect(preview.response.status).toBe(200);
    expect(typeof preview.json.distribution_fingerprint).toBe("string");
    const entries = preview.json.entries as Array<Record<string, unknown>>;
    expect(Array.isArray(entries[0]?.collections)).toBe(true);
    const draw = await sendJson(player, "/api/v1/draws", "POST", {
      pool: "test-pool",
      expectedRevision: preview.json.expected_revision,
      expectedDistribution: preview.json.distribution_fingerprint,
    });
    expect(draw.response.status).toBe(200);
    expect(draw.json.card_name).toBe("Test One");
    expect(draw.json.distribution_fingerprint).toBe(preview.json.distribution_fingerprint);
  });

  it("stores a finish/edition-specific wishlist target through the player API", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const add = await sendJson(player, "/api/v1/wishlist", "POST", { cardId: fixture.cardId, wanted: true, targetVariantId: fixture.variantId });
    expect(add.response.status).toBe(200);
    expect(add.json.target_variant_id).toBe(fixture.variantId);
    expect(add.json.target_material_key).toBe("plain");
    const list = await sendJson(player, "/api/v1/wishlist", "GET");
    expect(list.response.status).toBe(200);
    const item = (list.json.items as Array<Record<string, unknown>>)[0]!;
    expect(item.target_variant_id).toBe(fixture.variantId);
    expect(item.variant_name).toBe("Plain");
    const invalid = await sendJson(player, "/api/v1/wishlist", "POST", { cardId: fixture.cardId, wanted: true, targetVariantId: "var_does_not_exist" });
    expect(invalid.response.status).toBe(422);
    expect((invalid.json.error as { code: string }).code).toBe("wishlist_target_invalid");
    const removed = await sendJson(player, "/api/v1/wishlist", "POST", { cardId: fixture.cardId, wanted: false });
    expect(removed.response.status).toBe(200);
    const empty = await sendJson(player, "/api/v1/wishlist", "GET");
    expect((empty.json.items as unknown[]).length).toBe(0);
  });

  it("allows the minimum explicit scope for each write", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(player, player.user!.id, fixture, "SCOPE-INSTANCE-2");

    const inventoryWrite = agentFor(player, ["inventory:write"]);
    const favourite = await sendJson(inventoryWrite, `/api/v1/instances/${instanceId}/favourite`, "POST", { favourite: true });
    expect(favourite.response.status).toBe(200);
    const row = await runtime.DB.prepare("SELECT favourite FROM fb_card_instances WHERE id = ?").bind(instanceId).first<{ favourite: number }>();
    expect(row?.favourite).toBe(1);

    const profileWrite = agentFor(player, ["profile:write"]);
    const prefs = await sendJson(profileWrite, "/api/v1/me/preferences", "PATCH", { sharingEnabled: true });
    expect(prefs.response.status).toBe(200);
    const share = await sendJson(profileWrite, "/api/v1/shares", "POST", { kind: "profile", expiresInDays: 7 });
    expect(share.response.status).toBe(200);
    expect(typeof share.json.url).toBe("string");
  });
});
