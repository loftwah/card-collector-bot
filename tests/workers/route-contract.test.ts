import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { routeApi } from "../../src/server/api/router";
import { ApiError, buildContext, resolveAgent, type Ctx } from "../../src/server/context";
import { createAgentGrant } from "../../src/server/modules/identity";
import { createTrade } from "../../src/server/modules/trades";
import { nowIso } from "../../src/server/db";
import { addCollectionCards, collectionBinder, createCollection } from "../../src/server/modules/collections";
import { getCard } from "../../src/server/modules/catalogue";

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

async function issuedAgent(owner: Ctx, player: Ctx, scope: string): Promise<Ctx> {
  const grant=await createAgentGrant(owner,{agentName:`route-${scope}`,representedUserId:player.user!.id,scopes:[scope],expiresInDays:1});
  return buildContext(new Request('https://foilbury.test/api/v1/inventory',{headers:{authorization:`Bearer ${grant.token}`}}));
}

async function withSession(ctx: Ctx): Promise<Ctx> {
  const id=`route-session-${crypto.randomUUID()}`,now=nowIso();
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?, 'test',?,?,?,'passkey',?)")
    .bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
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

  it('does not dispatch a mutation through an empty interior path segment', async () => {
    const owner = await withSession(await ctxFor('cabinet', 'owner@foilbury.local'));
    const fixture = await fixturePool(owner);
    const payload = { ids: [fixture.cardId], status: 'draft' };
    expect((await sendJson(owner, '/api/v1/admin//cards/bulk', 'POST', payload)).response.status).toBe(404);
    expect((await sendJson(owner, '/api/v1/studio/cards//bulk', 'POST', payload)).response.status).toBe(404);
    expect((await runtime.DB.prepare('SELECT status FROM fb_card_definitions WHERE id = ?').bind(fixture.cardId).first<{status: string}>())?.status).toBe('published');
    expect((await sendJson(owner, '/api/v1/wallet//', 'GET')).response.status).toBe(404);
    expect((await sendJson(owner, '/api/v1//wallet', 'GET')).response.status).toBe(404);
    expect((await sendJson(owner, '/api/v1//admin/cards/bulk', 'POST', payload)).response.status).toBe(404);
    expect((await sendJson(owner, '/api/v1/admin//cards', 'GET')).response.status).toBe(404);
    expect((await sendJson(owner, '/api/v1/wallet/', 'GET')).response.status).toBe(200);
    expect((await sendJson(owner, '/api/v1/admin/cards/bulk/', 'POST', {ids: [], status: 'draft'})).response.status).toBe(200);
    expect((await sendJson(owner, '/api/v1/admin/cards/bulk', 'POST', payload)).response.status).toBe(200);
    expect((await runtime.DB.prepare('SELECT status FROM fb_card_definitions WHERE id = ?').bind(fixture.cardId).first<{status: string}>())?.status).toBe('draft');
  });

  it('rejects suffixes on remaining administrative mutations while preserving exact bulk dispatch', async () => {
    const owner=await withSession(await ctxFor('cabinet','owner@foilbury.local'));
    const cases: Array<[string,string]> = [
      ['cards/bulk','POST'],['cards/card/editions','POST'],['sets/set/members','PUT'],['sets/set/publish','POST'],
      ['catalogue/publish','POST'],['pools/pool/publish','POST'],['pools/pool/retire','POST'],['variants/variant/back','POST'],
      ['generation/plan','POST'],['generation/jobs/job/submit','POST'],['generation/jobs/job/review','POST'],['generation/jobs/job/adopt','POST'],
      ['outbox/process','POST'],['bot/admins/user/revoke','POST'],['achievements/backfill','POST'],['gifts/preview','POST'],['gifts/campaign/retry','POST'],
      ['assets/asset/derivatives','POST'],['bot/invitations','POST'],
    ];
    for (const [route,method] of cases) {
      expect((await sendJson(owner,`/api/v1/admin/${route}/unexpected`,method,{})).response.status,route).toBe(404);
      expect((await sendJson(owner,`/api/v1/studio/${route}/unexpected`,method,{})).response.status,`studio/${route}`).toBe(404);
    }
    for (const route of ['catalogue/status','assets/asset/bytes','backup/manifest','status']) {
      expect((await sendJson(owner,`/api/v1/admin/${route}/unexpected`,'GET')).response.status,route).toBe(404);
    }
    expect((await sendJson(owner,'/api/v1/ops/status/unexpected','GET')).response.status).toBe(404);
    const exact=await sendJson(owner,'/api/v1/admin/cards/bulk','POST',{ids:[],status:'draft'});
    expect(exact.response.status).toBe(200);
    expect(exact.json).toMatchObject({updated:0});
  });

  it("limits collection progress and membership lists to the agent's granted reads and Bot", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const foreign = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const fixture = await fixturePool(owner);
    await makeInstance(owner, owner.user!.id, fixture);
    await runtime.DB.prepare("INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES ('agent_set',?,'agent-set','Agent set','fixture','published',1,?)").bind(owner.tenant.id, nowIso()).run();
    await runtime.DB.prepare("INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES ('agent_set_card',?,'agent_set',1,?,?)").bind(owner.tenant.id, fixture.cardId, nowIso()).run();
    await runtime.DB.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,status,created_at) VALUES (?,?,'player','active',?)").bind(foreign.tenant.id, owner.user!.id, nowIso()).run();
    const grant = await createAgentGrant(owner, { agentName: "profile only", representedUserId: owner.user!.id, scopes: ["profile:read"], expiresInDays: 1 });
    const ctx = { ...owner, ...(await resolveAgent(owner.db, owner.config, grant.token, owner.tenant)) };
    const collection = await sendJson(ctx, "/api/v1/collections/col_test_public", "GET");
    expect(collection.response.status).toBe(200);
    expect(collection.json.progress).toBeNull();
    const publicSets = await sendJson(ctx, "/api/v1/sets", "GET");
    const hiddenSet = (publicSets.json.items as Array<{slug: string; progress?: unknown}>).find((set) => set.slug === "agent-set");
    expect(hiddenSet).toBeUndefined(); // no explicit public-safe set review
    const memberships = await sendJson(ctx, "/api/v1/me/memberships", "GET");
    expect((memberships.json.items as Array<{tenant_id: string}>).map((item) => item.tenant_id)).toEqual([owner.tenant.id]);
    const inventoryGrant = await createAgentGrant(owner, { agentName: "inventory reader", representedUserId: owner.user!.id, scopes: ["inventory:read"], expiresInDays: 1 });
    const withInventory = { ...owner, ...(await resolveAgent(owner.db, owner.config, inventoryGrant.token, owner.tenant)) };
    const permitted = await sendJson(withInventory, "/api/v1/collections/col_test_public", "GET");
    expect((permitted.json.progress as { owned_copies: number }).owned_copies).toBe(1);
    const inventorySets = await sendJson(withInventory, "/api/v1/sets", "GET");
    expect((inventorySets.json.items as Array<{slug: string}>).find((set) => set.slug === "agent-set")).toBeUndefined();
  });

  it("does not reveal mixed-audience cards through a public collection or its progress", async () => {
    const owner = await withSession(await ctxFor("cabinet", "owner@foilbury.local"));
    let player = await ctxFor("cabinet", "player@foilbury.local");
    const sessionNow = nowIso(), sessionExpiry = new Date(Date.now()+3600000).toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('mixed_session','mixed_token',?,?,'test',?,?,?,'password',?)").bind(player.user!.id,player.tenant.id,sessionNow,sessionExpiry,sessionNow,sessionNow).run();
    player = { ...player, sessionId: 'mixed_session', sessionAssurance: 'password', sessionAuthTime: sessionNow };
    const fixture = await fixturePool(owner);
    await makeInstance(player, player.user!.id, fixture);
    const restricted = await createCollection(owner, { name: "Restricted mixed fixture", scope: "bot", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, restricted.id, [fixture.cardId]);
    const now = nowIso();
    await runtime.DB.prepare("INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at) VALUES ('visible_set_card',?,'visible-set-card','visible-set-card','Visible set card','','published',?,?)").bind(owner.tenant.id, now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,added_by,added_at) VALUES ('col_test_public','visible_set_card',?,?,?)").bind(owner.tenant.id, owner.user!.id, now).run();
    await runtime.DB.prepare("INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES ('mixed_set',?,'mixed-set','Mixed set','fixture','published',1,?)").bind(owner.tenant.id, now).run();
    await runtime.DB.prepare("INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES ('mixed_a',?,'mixed_set',1,?,?),('mixed_b',?,'mixed_set',1,'visible_set_card',?)").bind(owner.tenant.id, fixture.cardId, now, owner.tenant.id, now).run();
    // Simulate a historical claim predating the 0031 insert invariant.
    await runtime.DB.exec("DROP TRIGGER public_set_claim_guard");
    await runtime.DB.prepare("INSERT INTO fb_set_completion_claims (id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key) VALUES ('mixed_claim',?,?,'mixed_set',1,10,?,'mixed_claim_key')").bind(owner.tenant.id, player.user!.id, now).run();
    const detail = await sendJson(player, "/api/v1/collections/col_test_public", "GET");
    expect(detail.response.status).toBe(200);
    expect((detail.json.collection as {card_count: number; cover_url: string | null}).card_count).toBe(1);
    expect((detail.json.collection as {card_count: number; cover_url: string | null}).cover_url).toBeNull();
    expect(JSON.stringify(detail.json.cards)).not.toContain("Test One");
    expect((detail.json.progress as {total_cards: number; owned_copies: number}).total_cards).toBe(1);
    expect((detail.json.progress as {total_cards: number; owned_copies: number}).owned_copies).toBe(0);
    expect((await collectionBinder(player, "col_test_public")).cards.map((card) => card.id)).not.toContain(fixture.cardId);
    expect((await collectionBinder(owner, "col_test_public")).cards.map((card) => card.id)).toContain(fixture.cardId);
    const sets = await sendJson(player, "/api/v1/sets", "GET");
    const mixed = (sets.json.items as Array<{slug: string; progress?: unknown}>).find((set) => set.slug === "mixed-set");
    expect(mixed).toBeUndefined();
    const blockedClaim = await sendJson(player, "/api/v1/sets/mixed_set/claim", "POST", {});
    expect(blockedClaim.json.error).toMatchObject({ code: "set_completion_unavailable" });
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_set_completion_claims WHERE id = 'mixed_claim'").first<{n: number}>())?.n).toBe(1);
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)").bind(restricted.id, player.user!.id, owner.user!.id, now).run();
    const restored = await sendJson(player, "/api/v1/collections/col_test_public", "GET");
    expect((restored.json.progress as {total_cards: number; owned_copies: number}).total_cards).toBe(2);
    expect((restored.json.collection as {card_count: number}).card_count).toBe(2);
    expect((restored.json.progress as {total_cards: number; owned_copies: number}).owned_copies).toBe(1);
    expect((await collectionBinder(player, "col_test_public")).cards.map((card) => card.id)).toContain(fixture.cardId);
    const restoredSets = await sendJson(player, "/api/v1/sets", "GET");
    expect((restoredSets.json.items as Array<{slug: string}>).find((set) => set.slug === "mixed-set")).toBeUndefined();
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id = ? AND user_id = ?").bind(restricted.id, player.user!.id).run();
    expect((await collectionBinder(player, "col_test_public")).cards.map((card) => card.id)).not.toContain(fixture.cardId);
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).run();
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(player.tenant.id).first<{id: string}>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,revoked_at,created_at) VALUES ('mixed_revoked_admin',?,?,'admin','[\"content\"]','revoked',?,?)").bind(bot!.id, player.user!.id, now, now).run();
    const staleEditor = { ...player, user: { ...player.user!, role: "editor" as const, globalCollectionScope: { all: true, collectionIds: [] } } };
    const staleDetail = await sendJson(staleEditor, "/api/v1/collections/col_test_public", "GET");
    expect((staleDetail.json.collection as {card_count: number; cover_url: string | null})).toMatchObject({ card_count: 1, cover_url: null });
    expect((staleDetail.json.collection as { manageable: boolean }).manageable).toBe(false);
    expect(JSON.stringify(staleDetail.json.cards)).not.toContain("Test One");
    await expect(getCard(staleEditor, fixture.cardId)).rejects.toMatchObject({ code: "card_not_found" });
    const staleAdminList = await sendJson(staleEditor, "/api/v1/admin/collections", "GET");
    expect(JSON.stringify(staleAdminList.json)).not.toContain(restricted.id);
    const foreign = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const foreignGlobal = await createCollection(owner, { name: "Other global", scope: "global", status: "published", viewAudience: "private" });
    await runtime.DB.prepare("UPDATE fb_collections SET owner_tenant_id = ? WHERE id = ?").bind(foreign.tenant.id, foreignGlobal.id).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,added_by,added_at) VALUES (?,?,?,?,?)").bind(foreignGlobal.id, fixture.cardId, owner.tenant.id, owner.user!.id, now).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status = 'active', revoked_at = NULL WHERE id = 'mixed_revoked_admin'").run();
    const editor = { ...player, user: { ...player.user!, role: "editor" as const } };
    await expect(getCard(editor, fixture.cardId)).rejects.toMatchObject({ code: "card_not_found" });
    const revokedSets = await sendJson(player, "/api/v1/sets", "GET");
    expect((revokedSets.json.items as Array<{slug: string}>).find((set) => set.slug === "mixed-set")).toBeUndefined();
    await runtime.DB.prepare("INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,recipe_id,status,created_at) SELECT 'visible_edition',tenant_id,'visible_set_card',name,subject_asset_id,recipe_id,'published',created_at FROM fb_artwork_editions WHERE card_id = ? LIMIT 1").bind(fixture.cardId).run();
    await runtime.DB.prepare("INSERT INTO fb_variants (id,tenant_id,card_id,edition_id,material_id,effect_id,name,status,created_at) SELECT 'visible_variant',tenant_id,'visible_set_card','visible_edition',material_id,effect_id,name,'published',created_at FROM fb_variants WHERE id = ?").bind(fixture.variantId).run();
    await makeInstance(player, player.user!.id, { cardId: 'visible_set_card', variantId: 'visible_variant' });
    const incompleteWorld = await sendJson(player, "/api/v1/collections/col_test_public", "GET");
    expect(incompleteWorld.json.progress).toMatchObject({ total_cards: 1, owned_cards: 1, complete: null, variant_complete: null, progress_scope: "visible" });
  });

  it("rejects unknown draw and reward suffixes without spending or crediting", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const preview = await sendJson(player, "/api/v1/pools/test-pool", "GET");
    const before = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ balance: number }>();
    const countsBefore = await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_draws WHERE tenant_id = ? AND user_id = ?) AS draws, (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ?) AS ledger").bind(player.tenant.id, player.user!.id, player.tenant.id, player.user!.id).first();
    const draw = await sendJson(player, "/api/v1/draws/unexpected", "POST", { pool: "test-pool", expectedRevision: preview.json.expected_revision, expectedDistribution: preview.json.distribution_fingerprint });
    const claim = await sendJson(player, "/api/v1/rewards/claim/unexpected", "POST", {});
    expect(draw.response.status).toBe(404);
    expect(claim.response.status).toBe(404);
    const after = await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?").bind(player.tenant.id, player.user!.id).first<{ balance: number }>();
    const countsAfter = await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_draws WHERE tenant_id = ? AND user_id = ?) AS draws, (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ?) AS ledger").bind(player.tenant.id, player.user!.id, player.tenant.id, player.user!.id).first();
    expect(after).toEqual(before);
    expect(countsAfter).toEqual(countsBefore);
    const preferences = await sendJson(player, "/api/v1/me/preferences", "GET");
    const wrongPreferences = await sendJson(player, "/api/v1/me/preferences/extra", "PATCH", { reducedMotion: !preferences.json.reduced_motion });
    expect(wrongPreferences.response.status).toBe(404);
    expect((await sendJson(player, "/api/v1/me/preferences", "GET")).json.reduced_motion).toBe(preferences.json.reduced_motion);
    expect((await sendJson(player, `/api/v1/cards/${fixture.cardId}/extra`, "GET")).response.status).toBe(404);
  });

  it("does not dispatch extra admin and platform path segments", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    for (const name of ["recipes", "tenant", "taxonomy", "economy", "audit", "agents", "members", "jobs", "topics"]) {
      expect((await sendJson(owner, `/api/v1/admin/${name}/unexpected`, "GET")).response.status, name).toBe(404);
    }
    for (const name of ["overview", "accounts", "people"]) {
      expect((await sendJson(owner, `/api/v1/platform/${name}/unexpected`, "GET")).response.status, name).toBe(404);
    }
    expect((await sendJson(owner, "/api/v1/admin/tenant", "GET")).response.status).toBe(200);
    const before = (await sendJson(owner, "/api/v1/admin/tenant", "GET")).json;
    expect((await sendJson(owner, "/api/v1/admin/tenant/unexpected", "PATCH", { publicCatalogue: true })).response.status).toBe(404);
    expect((await sendJson(owner, "/api/v1/admin/tenant", "GET")).json).toEqual(before);
    expect((await sendJson(owner, "/api/v1/admin/topics/some-id/unexpected", "PATCH", { active: false })).response.status).toBe(404);
    expect((await sendJson(owner, "/api/v1/admin/wallets/some-id/adjust/unexpected", "POST", { amount: 1, reason: "fixture" })).response.status).toBe(404);
    expect((await sendJson(owner, "/api/v1/admin/agents/some-id/revoke/unexpected", "POST", {})).response.status).toBe(404);
    expect((await sendJson(owner, "/api/v1/admin/taxonomy/tag/some-id/unexpected", "DELETE")).response.status).toBe(404);
    for (const path of ["imports/preview", "renders/queue", "jobs/next/claim", "jobs/id/complete", "jobs/id/fail", "collections/id/cards", "collections/id/enable", "collections/id/viewers"]) {
      expect((await sendJson(owner, `/api/v1/admin/${path}/unexpected`, "POST", {})).response.status, path).toBe(404);
    }
    expect((await sendJson(owner, "/api/v1/admin/collections/id/cards/card/unexpected", "DELETE")).response.status).toBe(404);
    expect((await sendJson(owner, "/api/v1/admin/collections/id/viewers/unexpected", "GET")).response.status).toBe(404);
    expect((await sendJson(owner, "/api/v1/admin/collections/id/progress/unexpected", "GET")).response.status).toBe(404);
  });

  it("requires member and inventory-read authority for individual pool previews", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(owner);
    const anonymous = { ...player, user: null, actor: { type: "system" as const, id: "anonymous", representedUserId: null, label: "Anonymous" } };
    const wrongScope = agentFor(player, ["content:read"]);
    expect((await sendJson(player, "/api/v1/pools/test-pool", "GET")).response.status).toBe(200);
    expect((await sendJson(anonymous, "/api/v1/pools/test-pool", "GET")).response.status).toBe(401);
    expect((await sendJson(wrongScope, "/api/v1/pools/test-pool", "GET")).response.status).toBe(403);
  });

  it("routes gift receipts, trade detail and peer discovery to their own handlers", async () => {
    const owner = await withSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await withSession(await ctxFor("cabinet", "player@foilbury.local"));
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
    const stateBefore = await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id = ?").bind(trade.id).first();
    expect((await sendJson(owner, `/api/v1/trades/${trade.id}/cancel/extra`, "POST", {})).response.status).toBe(404);
    expect(await runtime.DB.prepare("SELECT status FROM fb_trades WHERE id = ?").bind(trade.id).first()).toEqual(stateBefore);

    const directory = await sendJson(player, "/api/v1/members", "GET");
    expect(directory.response.status).toBe(200);
    const members = directory.json.items as Array<Record<string, unknown>>;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => !("email" in member))).toBe(true);
    expect(members.every((member) => !("capabilities_json" in member))).toBe(true);
  });

  it("hides suspended members from peer discovery while the privileged route keeps them", async () => {
    const owner = await withSession(await ctxFor("cabinet", "owner@foilbury.local"));
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
    const inventoryOnly = await issuedAgent(owner,player,"inventory:read");
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
    const player = await withSession(await ctxFor("cabinet", "player@foilbury.local"));
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
    const clearTarget = await sendJson(player, "/api/v1/wishlist", "POST", { cardId: fixture.cardId, wanted: true, targetVariantId: null });
    expect(clearTarget.response.status).toBe(200);
    const reloaded = await sendJson(player, "/api/v1/wishlist", "GET");
    const anyFinish = (reloaded.json.items as Array<Record<string, unknown>>)[0]!;
    expect(anyFinish.target_variant_id).toBeNull();
    expect(anyFinish.target_material_key).toBeNull();
    expect(anyFinish.target_effect_key).toBeNull();
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

    const inventoryWrite = await issuedAgent(owner, player, "inventory:write");
    const favourite = await sendJson(inventoryWrite, `/api/v1/instances/${instanceId}/favourite`, "POST", { favourite: true });
    expect(favourite.response.status).toBe(200);
    const row = await runtime.DB.prepare("SELECT favourite FROM fb_card_instances WHERE id = ?").bind(instanceId).first<{ favourite: number }>();
    expect(row?.favourite).toBe(1);

    const profileWrite = await issuedAgent(owner,player,"profile:write");
    const prefs = await sendJson(profileWrite, "/api/v1/me/preferences", "PATCH", { sharingEnabled: true });
    expect(prefs.response.status).toBe(200);
    const profile = await sendJson(profileWrite, "/api/v1/shares", "POST", { kind: "profile", expiresInDays: 7 });
    expect(profile.response.status).toBe(200);
    expect(typeof profile.json.url).toBe("string");
    const share = await sendJson(profileWrite, "/api/v1/shares", "POST", { kind: "wishlist", expiresInDays: 7 });
    expect(share.response.status).toBe(403);
    expect((share.json.error as {code:string}).code).toBe('insufficient_scope');
    expect((await sendJson(inventoryWrite, '/api/v1/wishlist', 'POST', {cardId:fixture.cardId,wanted:true})).response.status).toBe(200);
    const bothGrant=await createAgentGrant(owner,{agentName:'wishlist share agent',representedUserId:player.user!.id,scopes:['profile:write','inventory:read'],expiresInDays:1});
    const both=await buildContext(new Request('https://foilbury.test/api/v1/shares',{headers:{authorization:`Bearer ${bothGrant.token}`}}));
    const completeShare=await sendJson(both,'/api/v1/shares','POST',{kind:'wishlist',expiresInDays:7});
    expect(completeShare.response.status).toBe(200);
    const stored=await runtime.DB.prepare("SELECT payload_json FROM fb_share_links WHERE tenant_id=? AND kind='wishlist' ORDER BY created_at DESC LIMIT 1").bind(player.tenant.id).first<{payload_json:string}>();
    expect(JSON.parse(stored!.payload_json).items).toMatchObject([{card_id:fixture.cardId}]);
  });
});
