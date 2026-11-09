import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { getWishlist, toggleWishlist } from "../../src/server/modules/collection";
import { updatePreferences } from "../../src/server/modules/economy";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import { wishlistAcquisitionPaths } from "../../src/server/modules/wishlist-paths";
import { routeApi } from "../../src/server/api/router";
import { createAgentGrant } from "../../src/server/modules/identity";
import { resolveAgent } from "../../src/server/context";

async function collectionSession(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  const now=new Date().toISOString(),id=`collection-fixture-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}


describe("wishlist visibility and eligible acquisition paths", () => {
  beforeEach(async () => { await bootstrap(); });
  it.each(['session','audience'])('does not return a saved wish when %s is revoked at the read boundary',async change=>{
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(player);
    await toggleWishlist(player,fixture.cardId,true);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{
      const stmt=target.prepare(sql);if(!sql.includes('FROM fb_wishlists w JOIN fb_card_definitions'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='all')return async()=>{if(!injected){injected=true;if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();else await target.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();}return b.all();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    expect(await getWishlist({...player,db})).toEqual([]);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{n:number}>())?.n).toBe(1);
  });
  it('withholds a private wish if its viewer grant is revoked at the read boundary',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(owner);
    const collection=await createCollection(owner,{name:'Read boundary private',scope:'global',status:'published',viewAudience:'private'});
    await addCollectionCards(owner,collection.id,[fixture.cardId]);
    await runtime.DB.prepare('DELETE FROM fb_collection_cards WHERE collection_id=?').bind('col_test_public').run();
    await runtime.DB.prepare('INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES(?,?,?,?)').bind(collection.id,player.user!.id,owner.user!.id,new Date().toISOString()).run();
    await toggleWishlist(player,fixture.cardId,true);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{
      const stmt=target.prepare(sql);if(!sql.includes('FROM fb_wishlists w JOIN fb_card_definitions'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='all')return async()=>{if(!injected){injected=true;await target.prepare('DELETE FROM fb_collection_viewers WHERE collection_id=? AND user_id=?').bind(collection.id,player.user!.id).run();}return b.all();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    expect(await getWishlist({...player,db})).toEqual([]);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{n:number}>())?.n).toBe(1);
  });
  it('does not write a wish if the session is revoked at the write boundary', async () => {
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(player); let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=target.prepare(sql);
        if (!sql.includes('INSERT INTO fb_wishlists')) return statement;
        return new Proxy(statement,{get(s,k){
          if(k==='bind')return (...args:unknown[])=>{
            const bound=s.bind(...args);
            return new Proxy(bound,{get(b,p){if(p==='run')return async()=>{if(!injected){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();}return b.run();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});
          };
          const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;
        }});
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(toggleWishlist({...player,db},fixture.cardId,true)).rejects.toMatchObject({status:404});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{n:number}>())?.n).toBe(0);
  });
  it.each(['audience','finish'])('does not save a wish if its %s changes at the write boundary',async change=>{
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(player);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{
      const stmt=target.prepare(sql);if(!sql.includes('INSERT INTO fb_wishlists'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='run')return async()=>{if(!injected){injected=true;if(change==='audience')await target.prepare("UPDATE fb_collections SET view_audience='private', public_approved_at=NULL WHERE id='col_test_public'").run();else await target.prepare("UPDATE fb_variants SET status='draft' WHERE id=?").bind(fixture.variantId).run();}return b.run();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    await expect(toggleWishlist({...player,db},fixture.cardId,true,{variantId:fixture.variantId})).rejects.toMatchObject({status:404});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{n:number}>())?.n).toBe(0);
  });
  it('preserves a wish when its session is revoked before removal',async()=>{
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(player);
    await toggleWishlist(player,fixture.cardId,true);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();}return target.batch(statements);};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    await expect(toggleWishlist({...player,db},fixture.cardId,false)).rejects.toMatchObject({status:404});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{n:number}>())?.n).toBe(1);
  });
  it('accepts a live inventory-write agent and denies its rotated token',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(player);
    const grant=await createAgentGrant(owner,{agentName:'wishlist fixture',representedUserId:player.user!.id,scopes:['inventory:write'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);
    const agent={...player,...principal,agentCredential:principal.credential};
    expect(await toggleWishlist(agent,fixture.cardId,true)).toMatchObject({wanted:true});
    await runtime.DB.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-wishlist-token',principal.credential.tokenId).run();
    await expect(toggleWishlist(agent,fixture.cardId,false)).rejects.toMatchObject({status:404});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{n:number}>())?.n).toBe(1);
  });
  it('returns wishes only to a currently authorised inventory-read agent',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(player);
    await toggleWishlist(player,fixture.cardId,true);
    const grant=await createAgentGrant(owner,{agentName:'wishlist reader',representedUserId:player.user!.id,scopes:['inventory:read'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);
    const agent={...player,...principal,agentCredential:principal.credential};
    expect(await getWishlist(agent)).toHaveLength(1);
    await runtime.DB.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-wishlist-reader',principal.credential.tokenId).run();
    expect(await getWishlist(agent)).toEqual([]);
  });
  it('withholds an unpublished target finish while preserving the saved wish',async()=>{
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(player);
    await toggleWishlist(player,fixture.cardId,true,{variantId:fixture.variantId});
    await runtime.DB.prepare("UPDATE fb_variants SET name='Private finish',status='draft' WHERE id=?").bind(fixture.variantId).run();
    expect(await getWishlist(player)).toMatchObject([{card_id:fixture.cardId,target_variant_id:null,target_material_key:null,target_effect_key:null,variant_name:null}]);
    expect((await runtime.DB.prepare('SELECT target_variant_id FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(player.user!.id,fixture.cardId).first<{target_variant_id:string}>())?.target_variant_id).toBe(fixture.variantId);
  });
  it("shows only currently eligible target paths while preserving wishes and owned copies", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    await makeInstance(player, player.user!.id, fixture, "WISH-OWNED-FIXTURE");
    await toggleWishlist(player, fixture.cardId, true, { variantId: fixture.variantId });
    const wishes = await getWishlist(player);
    expect((await wishlistAcquisitionPaths(player, wishes)).get(fixture.cardId)?.map((item) => item.slug)).toContain("test-pool");
    const brokenDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        if (sql.includes("SELECT * FROM fb_pools")) throw new Error("fixture pool storage failure");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(wishlistAcquisitionPaths({ ...player, db: brokenDb }, wishes)).rejects.toThrow("fixture pool storage failure");
    await updatePreferences(player, { hiddenCollectionIds: ["col_test_public"] });
    expect((await wishlistAcquisitionPaths(player, await getWishlist(player))).get(fixture.cardId)).toEqual([]);
    await updatePreferences(player, { hiddenCollectionIds: [] });
    await runtime.DB.prepare("UPDATE fb_bot_collections SET enabled = 0 WHERE collection_id = 'col_test_public' AND bot_id IN (SELECT id FROM fb_bots WHERE tenant_id = ?)").bind(player.tenant.id).run();
    expect((await wishlistAcquisitionPaths(player, await getWishlist(player))).get(fixture.cardId)).toEqual([]);
    expect(await getWishlist(player)).toHaveLength(1);
    const count = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND card_id = ?").bind(player.tenant.id, player.user!.id, fixture.cardId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
  it("hides a stale wish after visibility is revoked and restores it when access returns", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const harbour = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Private fixture", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)").bind(collection.id, player.user!.id, owner.user!.id, new Date().toISOString()).run();
    await toggleWishlist(player, fixture.cardId, true);
    expect(await getWishlist(player)).toHaveLength(1);
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id = ? AND user_id = ?").bind(collection.id, player.user!.id).run();
    expect(await getWishlist(player)).toEqual([]);
    const response = await routeApi(new Request("https://foilbury.test/api/v1/wishlist"), player, "wishlist");
    const responseText = await response.text();
    expect(responseText).not.toContain("Test One");
    expect(JSON.parse(responseText).items).toEqual([]);
    await expect(toggleWishlist(player, fixture.cardId, true)).rejects.toMatchObject({ status: 404 });
    await expect(toggleWishlist(harbour, fixture.cardId, true)).rejects.toMatchObject({ status: 404 });
    const stored = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_wishlists WHERE tenant_id = ? AND user_id = ? AND card_id = ?").bind(player.tenant.id, player.user!.id, fixture.cardId).first<{ count: number }>();
    expect(stored?.count).toBe(1);
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)").bind(collection.id, player.user!.id, owner.user!.id, new Date().toISOString()).run();
    expect(await getWishlist(player)).toHaveLength(1);
  });
  it("does not retain private wishlist visibility from a stale editor role after content grant revocation", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Bot private fixture", scope: "bot", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at) VALUES ('wishlist_editor', ?, ?, 'admin', '[\"content\"]', 'active', ?)").bind(bot!.id, player.user!.id, new Date().toISOString()).run();
    const editor = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    await toggleWishlist(editor, fixture.cardId, true);
    expect(await getWishlist(editor)).toHaveLength(1);
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json = '[]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status = 'revoked', revoked_at = ? WHERE id = 'wishlist_editor'").bind(new Date().toISOString()).run();
    expect(await getWishlist(editor)).toEqual([]);
    await expect(toggleWishlist(editor, fixture.cardId, true)).rejects.toMatchObject({ status: 404 });
  });
  it("rechecks a scoped Global Collection Admin assignment instead of stale context", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Scoped global fixture", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT id, ?, 1, ? FROM fb_bots WHERE tenant_id = ?").bind(collection.id, new Date().toISOString(), owner.tenant.id).run();
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id, user_id, role, scopes_json, status, granted_by, granted_at, reason) VALUES ('wishlist_global_scope', ?, 'global_collection_admin', ?, 'active', ?, ?, 'fixture')").bind(player.user!.id, JSON.stringify({ all: false, collectionIds: [collection.id] }), owner.user!.id, new Date().toISOString()).run();
    await toggleWishlist(player, fixture.cardId, true);
    const savedWishes = await getWishlist(player);
    expect(savedWishes).toHaveLength(1);
    expect((await wishlistAcquisitionPaths(player, savedWishes)).get(fixture.cardId)).toHaveLength(1);
    const beforePreview = await getPoolPreview(player, "test-pool");
    const stale = { ...player, user: { ...player.user!, globalCollectionScope: { all: true, collectionIds: [] } } };
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json = ? WHERE id = 'wishlist_global_scope'").bind(JSON.stringify({ all: false, collectionIds: ["another-collection"] })).run();
    expect(await getWishlist(stale)).toEqual([]);
    expect((await wishlistAcquisitionPaths(stale, savedWishes)).get(fixture.cardId)).toEqual([]);
    expect((await getPoolPreview(stale, "test-pool")).eligible_count).toBe(0);
    const response = await routeApi(new Request("http://localhost:5173/api/v1/pools/test-pool"), stale, "pools/test-pool");
    expect((await response.json() as { eligible_count: number }).eligible_count).toBe(0);
    await expect(executeDraw(stale, { pool: "test-pool", expectedRevision: beforePreview.revision, expectedDistribution: beforePreview.distribution_fingerprint, idempotency: { key: "scoped-revoked", digest: "scoped-revoked" } })).rejects.toMatchObject({ code: "empty_pool" });
    await expect(toggleWishlist(stale, fixture.cardId, true)).rejects.toMatchObject({ status: 404 });
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json = '{broken' WHERE id = 'wishlist_global_scope'").run();
    expect(await getWishlist(stale)).toEqual([]);
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET status = 'revoked' WHERE id = 'wishlist_global_scope'").run();
    expect(await getWishlist(stale)).toEqual([]);
  });
});
