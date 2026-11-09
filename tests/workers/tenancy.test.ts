import { describe, expect, it } from "vitest";
import { createAgentGrant, revokeAgentGrant } from "../../src/server/modules/identity";
import { resolveAgent } from "../../src/server/context";
import { createCard, getCard } from "../../src/server/modules/catalogue";
import { getInventory } from "../../src/server/modules/collection";
import { getPoolPreview } from "../../src/server/modules/pools";
import { getWalletSummary } from "../../src/server/modules/wallet";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { routeApi } from "../../src/server/api/router";
import { viewerAccess } from "../../src/server/modules/visibility";
import { createCollection } from "../../src/server/modules/collections";

async function collectionSession(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  const now=new Date().toISOString(),id=`collection-fixture-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}


describe("tenant isolation", () => {
  it("does not resolve a cabinet object from another tenant", async () => {
    await bootstrap();
    const cabinet = await ctxFor("cabinet", "owner@foilbury.local");
    const harbour = await collectionSession(await ctxFor("harbour", "harbour.owner@foilbury.test"));
    const fixture = await fixturePool(cabinet);

    await expect(getCard(harbour, fixture.cardId)).rejects.toMatchObject({ code: "card_not_found" });
    await expect(getPoolPreview(harbour, "test-pool")).rejects.toMatchObject({ code: "pool_not_found" });
    expect((await getInventory(harbour)).length).toBe(0);
    expect((await getWalletSummary(harbour.db, harbour.tenant.id, harbour.user!.id, 1)).balance).toBe(200);
    expect((await getWalletSummary(cabinet.db, cabinet.tenant.id, cabinet.user!.id, 1)).balance).toBe(350);
  });

  it("keeps tenant ids and memberships separate even with a shared user email domain", async () => {
    await bootstrap();
    const cabinet = await ctxFor("cabinet", "player@foilbury.local");
    const attic = await ctxFor("attic", "attic.owner@foilbury.test");
    const cabinetWallet = await getWalletSummary(cabinet.db, cabinet.tenant.id, cabinet.user!.id, 1);
    const atticWallet = await getWalletSummary(attic.db, attic.tenant.id, attic.user!.id, 1);
    expect(cabinetWallet.balance).toBe(350);
    expect(atticWallet.balance).toBe(200);
    expect(cabinet.tenant.id).not.toBe(attic.tenant.id);
  });
});

describe("agent grants", () => {
  it("intersects editorial agent scopes with the represented member's live Bot grant", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await owner.db.prepare("UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    const bot = await owner.db.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await owner.db.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('agent_scope_admin',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id, player.user!.id, new Date().toISOString()).run();
    const grant = await createAgentGrant(owner, { agentName: "editor", representedUserId: player.user!.id, scopes: ["content:read", "content:write", "inventory:read"], expiresInDays: 5 });
    const request = new Request("http://localhost/api/v1/admin/recipes");
    const asAgent = async () => ({ ...owner, ...(await resolveAgent(owner.db, owner.config, grant.token, owner.tenant)) });
    expect((await routeApi(request, await asAgent(), "admin/recipes")).status).toBe(200);
    const draft = await createCard(owner, {slug:"agent-draft-fixture",name:"Agent draft",description:"fixture",logicalId:"agent:draft"});
    await expect(getCard(await asAgent(), draft.id)).rejects.toMatchObject({code:"card_not_found"});
    expect((await getCard(await asAgent(), draft.id, {includeDrafts:true})).id).toBe(draft.id);
    expect((await asAgent()).user.platformAdmin).toBe(false);
    const readOnly = await createAgentGrant(owner, { agentName: "inventory only", representedUserId: player.user!.id, scopes: ["inventory:read"], expiresInDays: 5 });
    const noContent = { ...owner, ...(await resolveAgent(owner.db, owner.config, readOnly.token, owner.tenant)) };
    await expect(routeApi(request, noContent, "admin/recipes")).rejects.toMatchObject({ code: "insufficient_scope" });
    await owner.db.prepare("UPDATE fb_bot_admins SET status = 'revoked', revoked_at = ? WHERE id = 'agent_scope_admin'").bind(new Date().toISOString()).run();
    const revoked = await asAgent();
    await expect(routeApi(request, revoked, "admin/recipes")).rejects.toMatchObject({ code: "insufficient_role" });
    await expect(getCard(revoked, draft.id, {includeDrafts:true})).rejects.toMatchObject({code:"card_not_found"});
    expect(revoked.scopes).toContain("inventory:read");
    await owner.db.prepare("UPDATE fb_bot_admins SET status = 'active', revoked_at = NULL, capabilities_json = '[\"economy\"]' WHERE id = 'agent_scope_admin'").run();
    await expect(routeApi(request, await asAgent(), "admin/recipes")).rejects.toMatchObject({ code: "insufficient_role" });
  });
  it("lets only a human owner create a grant and revokes it immediately", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    await expect(
      createAgentGrant(player, { agentName: "not-allowed", representedUserId: player.user!.id, scopes: ["inventory:read"], expiresInDays: 5 }),
    ).rejects.toMatchObject({ code: "owner_required" });

    const grant = await createAgentGrant(owner, {
      agentName: "test-reader",
      representedUserId: owner.user!.id,
      scopes: ["inventory:read", "content:read"],
      expiresInDays: 5,
    });
    const resolved = await resolveAgent(owner.db, owner.config, grant.token, owner.tenant);
    expect(resolved.user.id).toBe(owner.user!.id);
    expect(resolved.scopes).toEqual(["inventory:read", "content:read"]);
    const access = await viewerAccess({ ...owner, ...resolved });
    expect(access.platformAdmin).toBe(false);
    expect(access.adminTenantIds.size).toBe(0);
    expect(access.managesCurrentTenant).toBe(false);
    const foreign = await collectionSession(await ctxFor("harbour", "harbour.owner@foilbury.test"));
    const foreignCollection = await createCollection(foreign, { name: "Foreign private", scope: "bot", status: "published", viewAudience: "private" });
    const foreignGlobal = await createCollection(owner, { name: "Foreign global private", scope: "global", status: "published", viewAudience: "private" });
    await owner.db.prepare("UPDATE fb_collections SET owner_tenant_id = ? WHERE id = ?").bind(foreign.tenant.id, foreignGlobal.id).run();
    await owner.db.prepare("INSERT INTO fb_memberships (tenant_id,user_id,role,status,created_at) VALUES (?,?,'player','active',?)").bind(foreign.tenant.id, owner.user!.id, new Date().toISOString()).run();
    await owner.db.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)").bind(foreignCollection.id, owner.user!.id, foreign.user!.id, new Date().toISOString()).run();
    const bounded = await viewerAccess({ ...owner, ...resolved });
    expect(bounded.memberTenantIds.has(owner.tenant.id)).toBe(true);
    expect(bounded.memberTenantIds.has(foreign.tenant.id)).toBe(false);
    expect(bounded.explicitCollectionIds.has(foreignCollection.id)).toBe(false);
    const adminList = await routeApi(new Request("http://localhost/api/v1/admin/collections"), { ...owner, ...resolved }, "admin/collections");
    expect(JSON.stringify(await adminList.json())).not.toContain(foreignGlobal.id);
    const scopedAgent = { ...owner, ...resolved, user: { ...resolved.user, globalCollectionScope: { all: true, collectionIds: [] } } };
    expect((await viewerAccess(scopedAgent)).globalCollectionAdmin).toBe(false);
    await expect(routeApi(new Request(`http://localhost/api/v1/collections/${foreignCollection.id}`), { ...owner, ...resolved }, `collections/${foreignCollection.id}`)).rejects.toMatchObject({ code: "collection_not_found" });
    const unrelated = await viewerAccess({ ...owner, ...resolved, scopes: ["draw:execute"] });
    expect(unrelated.signedIn).toBe(false);
    expect(unrelated.memberTenantIds.size).toBe(0);

    await owner.db.prepare("UPDATE fb_agent_grants SET scopes_json = ? WHERE id = ?").bind('"inventory:read"', grant.grantId).run();
    await expect(resolveAgent(owner.db, owner.config, grant.token, owner.tenant)).rejects.toMatchObject({ code: "agent_unauthorised" });
    await owner.db.prepare("UPDATE fb_agent_grants SET scopes_json = ? WHERE id = ?").bind('["inventory:read","content:read"]', grant.grantId).run();

    await revokeAgentGrant(owner, grant.grantId);
    await expect(resolveAgent(owner.db, owner.config, grant.token, owner.tenant)).rejects.toMatchObject({
      code: "agent_unauthorised",
    });
  });

  it("rejects an expired grant even before revocation", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const grant = await createAgentGrant(owner, {
      agentName: "expiring-reader",
      representedUserId: owner.user!.id,
      scopes: ["inventory:read"],
      expiresInDays: 1,
    });
    await owner.db.prepare("UPDATE fb_agent_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(grant.grantId).run();
    await expect(resolveAgent(owner.db, owner.config, grant.token, owner.tenant)).rejects.toMatchObject({
      code: "agent_unauthorised",
    });
  });
});
