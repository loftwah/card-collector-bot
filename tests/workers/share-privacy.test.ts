import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { createShareLink, listShareLinks, revokeShareLink, updatePreferences } from "../../src/server/modules/economy";
import { resolveShareView } from "../../src/server/modules/shares";
import { addCollectionCards, createCollection } from "../../src/server/modules/collections";
import { toggleWishlist } from "../../src/server/modules/collection";
import { resolveAgent, type Ctx } from "../../src/server/context";
import { nowIso } from "../../src/server/db";
import { createUser, addMembership, createAgentGrant } from "../../src/server/modules/identity";

async function collectionSession(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  const now=new Date().toISOString(),id=`collection-fixture-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}


function anonymous(ctx: Ctx): Ctx {
  return {
    ...ctx,
    user: null,
    actor: { type: "system", id: "anonymous", representedUserId: null, label: "Anonymous" },
    csrfToken: "",
  };
}

describe("share privacy and lifecycle policy", () => {
  beforeEach(async () => {
    await bootstrap();
  });
  it('does not create a share for an unfiled draft copy',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);const instance=await makeInstance(owner,player.user!.id,fixture);
    await updatePreferences(player,{sharingEnabled:true});
    await runtime.DB.batch([
      runtime.DB.prepare('DELETE FROM fb_collection_cards WHERE card_id=?').bind(fixture.cardId),
      runtime.DB.prepare("UPDATE fb_card_definitions SET status='draft' WHERE id=?").bind(fixture.cardId),
    ]);
    await expect(createShareLink(player,{kind:'card',targetId:instance})).rejects.toMatchObject({code:'instance_not_found'});
  });
  it.each(['card','collection','profile','wishlist'] as const)('uses the current account name in a %s share rather than a stale request context',async kind=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);const instance=await makeInstance(owner,player.user!.id,fixture);
    await updatePreferences(player,{sharingEnabled:true});
    await runtime.DB.prepare('UPDATE fb_users SET display_name=? WHERE id=?').bind('Current name',player.user!.id).run();
    const targetId=kind==='card'?instance:kind==='collection'?'col_test_public':undefined;
    expect((await createShareLink(player,{kind,targetId})).owner_display_name).toBe('Current name');
  });
  it('does not create a card share from a sessionless request context',async()=>{
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const fixture=await fixturePool(owner);const instance=await makeInstance(owner,owner.user!.id,fixture);
    await updatePreferences(owner,{sharingEnabled:true});
    await expect(createShareLink(owner,{kind:'card',targetId:instance})).rejects.toMatchObject({code:'share_access_changed'});
  });
  it.each(['session','membership','audience','draft','ownership','back'])('does not create a card share when %s changes before commit',async change=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);const instance=await makeInstance(owner,player.user!.id,fixture);
    await updatePreferences(player,{sharingEnabled:true});
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(statements:Parameters<typeof target.batch>[0])=>{
        if(!injected){injected=true;const now=nowIso();
          if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(now,player.sessionId).run();
          else if(change==='membership')await target.prepare('UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?').bind(now,player.tenant.id,player.user!.id).run();
          else if(change==='audience')await target.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
          else if(change==='draft')await target.prepare("UPDATE fb_card_definitions SET status='draft' WHERE id=?").bind(fixture.cardId).run();
          else if(change==='ownership')await target.prepare('UPDATE fb_card_instances SET user_id=? WHERE id=?').bind(owner.user!.id,instance).run();
          else await target.prepare("INSERT INTO fb_variant_back_renders(id,tenant_id,variant_id,recipe_id,asset_id,width,height,sha256,status,created_at,published_at) VALUES ('share-race-back',?,?,?,?,750,1050,'hash','published',?,?)").bind(player.tenant.id,fixture.variantId,fixture.recipeId,fixture.renderAsset,now,now).run();
        }
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(createShareLink({...player,db},{kind:'card',targetId:instance})).rejects.toMatchObject({code:'share_access_changed'});
    expect(injected).toBe(true);
    expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_share_links WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it.each(['session','membership','audience','preference','viewer grant'])('does not create a collection share when %s changes before commit',async change=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    await fixturePool(owner);await updatePreferences(player,{sharingEnabled:true});
    let collection='col_test_public';
    if(change==='viewer grant'){
      const privateCollection=await createCollection(owner,{name:'Revoked share fixture',scope:'global',status:'published',viewAudience:'private'});
      collection=privateCollection.id;
      await runtime.DB.prepare('INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES(?,?,?,?)').bind(collection,player.user!.id,owner.user!.id,nowIso()).run();
    }
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{
        if(!injected){injected=true;
          if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),player.sessionId).run();
          else if(change==='membership')await target.prepare('UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?').bind(nowIso(),player.tenant.id,player.user!.id).run();
          else if(change==='audience')await target.prepare("UPDATE fb_collections SET view_audience='private' WHERE id=?").bind(collection).run();
          else if(change==='preference')await target.prepare('UPDATE fb_player_preferences SET sharing_enabled=0 WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).run();
          else await target.prepare('DELETE FROM fb_collection_viewers WHERE collection_id=? AND user_id=?').bind(collection,player.user!.id).run();
        }
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(createShareLink({...player,db},{kind:'collection',targetId:collection})).rejects.toMatchObject({code:'share_access_changed'});
    expect(injected).toBe(true);
    expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_share_links WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it('lets a profile-write agent create a collection share but rejects a rotated credential at commit',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    await fixturePool(owner);await updatePreferences(player,{sharingEnabled:true});
    const grant=await createAgentGrant(owner,{agentName:'collection share agent',representedUserId:player.user!.id,scopes:['profile:write'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);
    const agent={...player,...principal,agentCredential:principal.credential};
    expect((await createShareLink(agent,{kind:'collection',targetId:'col_test_public'})).kind).toBe('collection');
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-collection-share',principal.credential.tokenId).run();}
      return target.batch(statements);
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(createShareLink({...agent,db},{kind:'collection',targetId:'col_test_public'})).rejects.toMatchObject({code:'share_access_changed'});
    expect(injected).toBe(true);
    expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_share_links WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(1);
  });
  it.each(['unpin','ownership','audience','session'])('does not create a profile share when %s changes before commit',async change=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);const instance=await makeInstance(owner,player.user!.id,fixture);
    await runtime.DB.prepare('UPDATE fb_card_instances SET favourite=1 WHERE id=?').bind(instance).run();
    await updatePreferences(player,{sharingEnabled:true});let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;
        if(change==='unpin')await target.prepare('UPDATE fb_card_instances SET favourite=0 WHERE id=?').bind(instance).run();
        else if(change==='ownership')await target.prepare('UPDATE fb_card_instances SET user_id=? WHERE id=?').bind(owner.user!.id,instance).run();
        else if(change==='audience')await target.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
        else await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),player.sessionId).run();
      }return target.batch(statements);
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(createShareLink({...player,db},{kind:'profile'})).rejects.toMatchObject({code:'share_access_changed'});
    expect(injected).toBe(true);
    expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_share_links WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it.each(['unlock','definition','roster','session'])('does not create an achievement share when %s changes before commit',async change=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const fixture=await fixturePool(owner);const now=nowIso();
    const criteria=JSON.stringify({type:'collection_complete',collection_id:'col_test_public',roster_card_ids:[fixture.cardId]});
    await runtime.DB.prepare("INSERT INTO fb_achievement_definitions (id,scope,tenant_id,key,version,name,description,criteria_json,visibility,art_key,category,status,created_by,created_at,updated_at) VALUES ('race_badge','bot',?,'race_badge',1,'Badge','Description',?,'member','medal-generic','collection','active',?,?,?)").bind(owner.tenant.id,criteria,owner.user!.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_achievement_unlocks (id,tenant_id,user_id,achievement_id,achievement_version,earned_at,created_at) VALUES ('race_unlock',?,?,'race_badge',1,?,?)").bind(owner.tenant.id,owner.user!.id,now,now).run();
    await updatePreferences(owner,{sharingEnabled:true});let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;
        if(change==='unlock')await target.prepare("UPDATE fb_achievement_unlocks SET earned_at='2000-01-01T00:00:00.000Z' WHERE id='race_unlock'").run();
        else if(change==='definition')await target.prepare("UPDATE fb_achievement_definitions SET criteria_json='{}' WHERE id='race_badge'").run();
        else if(change==='roster')await target.prepare('DELETE FROM fb_collection_cards WHERE collection_id=? AND card_id=?').bind('col_test_public',fixture.cardId).run();
        else await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),owner.sessionId).run();
      }return target.batch(statements);
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(createShareLink({...owner,db},{kind:'achievement',targetId:'race_unlock'})).rejects.toMatchObject({code:'share_access_changed'});
    expect(injected).toBe(true);
    expect((await runtime.DB.prepare('SELECT COUNT(*) AS n FROM fb_share_links WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,owner.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it('withholds a shared wishlist if a viewer grant is revoked while resolving it',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const viewer=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(owner);
    const collection=await createCollection(owner,{name:'Race private world',scope:'global',status:'published',viewAudience:'private'});
    await addCollectionCards(owner,collection.id,[fixture.cardId]);await runtime.DB.prepare('DELETE FROM fb_collection_cards WHERE collection_id=?').bind('col_test_public').run();
    await runtime.DB.prepare('INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES(?,?,?,?)').bind(collection.id,viewer.user!.id,owner.user!.id,nowIso()).run();
    await toggleWishlist(owner,fixture.cardId,true);await updatePreferences(owner,{sharingEnabled:true});const share=await createShareLink(owner,{kind:'wishlist'});let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes('SELECT cd.id FROM fb_card_definitions cd WHERE'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='all')return async()=>{const result=await b.all();if(!injected){injected=true;await target.prepare('DELETE FROM fb_collection_viewers WHERE collection_id=? AND user_id=?').bind(collection.id,viewer.user!.id).run();}return result;};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    const result=await resolveShareView({...viewer,db},share.token);
    expect(JSON.stringify(result.payload)).not.toContain('Test One');
    expect((await runtime.DB.prepare('SELECT status FROM fb_share_links WHERE id=?').bind(share.id).first<{status:string}>())?.status).toBe('active');
  });
  it.each(['session','membership','audience','link'])('withholds share metadata when %s changes before final read',async change=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const viewer=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(owner);
    await toggleWishlist(owner,fixture.cardId,true);await updatePreferences(owner,{sharingEnabled:true});const share=await createShareLink(owner,{kind:'wishlist'});let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes('SELECT 1 AS ok FROM fb_share_links l'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='first')return async()=>{if(!injected){injected=true;
        if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),viewer.sessionId).run();
        else if(change==='membership')await target.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(nowIso(),viewer.tenant.id,viewer.user!.id).run();
        else if(change==='audience')await target.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();
        else await target.prepare("UPDATE fb_share_links SET status='revoked' WHERE id=?").bind(share.id).run();
      }return b.first();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    const result=await resolveShareView({...viewer,db},share.token);expect(result.payload).toEqual({});expect(result.visible).toBe(false);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_share_links WHERE id=?').bind(share.id).first<{n:number}>())?.n).toBe(1);
  });
  it('requires a live scoped agent credential for member share access',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const viewer=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));const fixture=await fixturePool(owner);
    await toggleWishlist(owner,fixture.cardId,true);await updatePreferences(owner,{sharingEnabled:true});const share=await createShareLink(owner,{kind:'wishlist'});
    const grant=await createAgentGrant(owner,{agentName:'share reader',representedUserId:viewer.user!.id,scopes:['inventory:read'],expiresInDays:1});
    const principal=await resolveAgent(viewer.db,viewer.config,grant.token,viewer.tenant);const agent={...viewer,...principal,agentCredential:principal.credential};
    expect(JSON.stringify((await resolveShareView(agent,share.token)).payload)).toContain('Test One');
    const wrong=await createAgentGrant(owner,{agentName:'wrong scope',representedUserId:viewer.user!.id,scopes:['profile:read'],expiresInDays:1});
    const wrongPrincipal=await resolveAgent(viewer.db,viewer.config,wrong.token,viewer.tenant);
    expect((await resolveShareView({...viewer,...wrongPrincipal,agentCredential:wrongPrincipal.credential},share.token)).visible).toBe(false);
    let injected=false;const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes('SELECT 1 AS ok FROM fb_share_links l'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='first')return async()=>{if(!injected){injected=true;await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-share-token',principal.credential.tokenId).run();}return b.first();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    expect((await resolveShareView({...agent,db},share.token)).visible).toBe(false);
  });
  it.each(['session','audience','variant','wishlist','preference','trigger'])('does not create a snapshot if %s changes at the share transaction',async change=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await collectionSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);await toggleWishlist(player,fixture.cardId,true,{variantId:fixture.variantId});await updatePreferences(player,{sharingEnabled:true});let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;
      if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),player.sessionId).run();
      else if(change==='audience')await target.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();
      else if(change==='variant')await target.prepare("UPDATE fb_variants SET name='Private finish',status='draft' WHERE id=?").bind(fixture.variantId).run();
      else if(change==='preference')await target.prepare('UPDATE fb_player_preferences SET sharing_enabled=0 WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).run();
      else if(change==='trigger')await target.prepare('DROP TRIGGER draw_epoch_fb_collections_update').run();
      else await target.prepare('DELETE FROM fb_wishlists WHERE tenant_id=? AND user_id=? AND card_id=?').bind(player.tenant.id,player.user!.id,fixture.cardId).run();
    }return target.batch(statements);};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    await expect(createShareLink({...player,db},{kind:'wishlist'})).rejects.toMatchObject({code:'share_access_changed'});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_share_links WHERE user_id=? AND kind='wishlist'").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it('allows an authenticated intentionally empty wishlist snapshot',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));await updatePreferences(owner,{sharingEnabled:true});
    const share=await createShareLink(owner,{kind:'wishlist'});
    expect(share.preview.items).toEqual([]);
  });
  it('does not publish a free-form finish name in a wishlist snapshot',async()=>{
    const owner=await collectionSession(await ctxFor('cabinet','owner@foilbury.local'));const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_variants SET name='Private print label' WHERE id=?").bind(fixture.variantId).run();
    await toggleWishlist(owner,fixture.cardId,true,{variantId:fixture.variantId});await updatePreferences(owner,{sharingEnabled:true});
    const share=await createShareLink(owner,{kind:'wishlist'});
    const stored=await runtime.DB.prepare('SELECT payload_json FROM fb_share_links WHERE id=?').bind(share.id).first<{payload_json:string}>();
    expect(stored!.payload_json).not.toContain('Private print label');
    expect(JSON.parse(stored!.payload_json).items).toMatchObject([{target:'Selected finish'}]);
    await runtime.DB.prepare('UPDATE fb_share_links SET payload_json=? WHERE id=?').bind(JSON.stringify({audience:'member',items:[{card_id:fixture.cardId,card_name:'Test One',card_slug:'test-one',target:'Private print label'}]}),share.id).run();
    const legacy=await resolveShareView(owner,share.token);
    expect(JSON.stringify(legacy.payload)).not.toContain('Private print label');
    expect(legacy.payload.items).toMatchObject([{target:'Selected finish'}]);
    expect((await runtime.DB.prepare('SELECT target_variant_id FROM fb_wishlists WHERE user_id=? AND card_id=?').bind(owner.user!.id,fixture.cardId).first<{target_variant_id:string}>())?.target_variant_id).toBe(fixture.variantId);
  });

  it("never exposes a member-only share or serial to an anonymous or cross-Bot viewer", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    await updatePreferences(owner, { sharingEnabled: true });
    const profile = await createShareLink(owner, { kind: "wishlist", expiresInDays: 7 });

    const anon = await resolveShareView(anonymous(owner), profile.token);
    expect(anon.active).toBe(true);
    expect(anon.publicView).toBe(false);
    expect(anon.visible).toBe(false);

    const member = await resolveShareView(player, profile.token);
    expect(member.visible).toBe(true);
    expect(JSON.stringify(member.payload)).not.toMatch(/email|wallet|ledger|account_id|serial/i);

    const harbourUser = await createUser(runtime.DB, { email: "harbour-viewer@example.test", displayName: "Harbour Viewer", password: "a-long-test-password" });
    const harbour = await runtime.DB.prepare("SELECT id, slug, name FROM fb_tenants WHERE slug = 'harbour'").first<{ id: string; slug: string; name: string }>();
    await addMembership(runtime.DB, harbour!.id, harbourUser.id, "player");
    const crossBot: Ctx = {
      ...owner,
      user: {
        id: harbourUser.id,
        email: harbourUser.email,
        displayName: "Harbour Viewer",
        role: "player",
        platformAdmin: false,
        emailVerified: true,
        capabilities: [],
      },
      actor: { type: "user", id: harbourUser.id, representedUserId: harbourUser.id, label: "Harbour Viewer" },
    };
    const cross = await resolveShareView(crossBot, profile.token);
    expect(cross.visible).toBe(false);
  });

  it("keeps a public snapshot safe while refusing private identifiers", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-PUBLIC-1");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect(share.audience).toBe("public");

    const anon = await resolveShareView(anonymous(owner), share.token);
    expect(anon.active).toBe(true);
    expect(anon.publicView).toBe(true);
    expect(anon.visible).toBe(true);
    // The serial exists in the private record, but is never shown to a public
    // viewer; the page renders it only when showSerial is true.
    expect(anon.showSerial).toBe(false);
    expect(anon.payload.serial).toBeUndefined();
    const ownerView = await resolveShareView(owner, share.token);
    expect(ownerView.showSerial).toBe(true);
    expect(ownerView.payload.serial).toBe("SHARE-PUBLIC-1");
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),owner.sessionId).run();
    const revokedOwner=await resolveShareView(owner,share.token);
    expect(revokedOwner.showSerial).toBe(false);
    expect(JSON.stringify(revokedOwner.payload)).not.toContain('SHARE-PUBLIC-1');
  });

  it("closes a public link when the collection audience changes", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const instanceId = await makeInstance(owner, owner.user!.id, fixture, "SHARE-AUDIENCE-1");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instanceId, expiresInDays: 7 });
    expect((await resolveShareView(anonymous(owner), share.token)).publicView).toBe(true);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'members', public_approved_at = NULL WHERE id = 'col_test_public'").run();
    const closed = await resolveShareView(anonymous(owner), share.token);
    expect(closed.active).toBe(true);
    expect(closed.publicView).toBe(false);
    expect(closed.visible).toBe(false);
    // A member still sees the member-audience snapshot.
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    expect((await resolveShareView(player, share.token)).visible).toBe(true);
  });

  it("rechecks every card collection when a public card later becomes private", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const instance = await makeInstance(owner, owner.user!.id, fixture, "SHARE-MIXED-1");
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "card", targetId: instance });
    const privateCollection = await createCollection(owner, { name: "Private extra", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, privateCollection.id, [fixture.cardId]);
    const anonymousView = await resolveShareView(anonymous(owner), share.token);
    expect(anonymousView.visible).toBe(false);
    expect(anonymousView.payload).toEqual({});
    const memberView = await resolveShareView(player, share.token);
    expect(memberView.visible).toBe(false);
    expect(memberView.payload).toEqual({});
  });

  it("reauthorizes each wishlist snapshot item for its creator and viewer, suppressing legacy items", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    const privateCollection = await createCollection(owner, { name: "Private wishlist", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, privateCollection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)").bind(privateCollection.id, player.user!.id, owner.user!.id, nowIso()).run();
    const other = await createUser(runtime.DB, { email: "wishlist-viewer@example.test", displayName: "Viewer", password: "a-long-test-password" });
    await addMembership(runtime.DB, owner.tenant.id, other.id, "player");
    const viewer: Ctx = await collectionSession({ ...player, user: { ...player.user!, id: other.id, email: other.email, displayName: "Viewer" }, actor: { type: "user", id: other.id, representedUserId: other.id, label: "Viewer" } });
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)").bind(privateCollection.id, other.id, owner.user!.id, nowIso()).run();
    await toggleWishlist(player, fixture.cardId, true);
    await updatePreferences(player, { sharingEnabled: true });
    const share = await createShareLink(player, { kind: "wishlist" });
    const initial = await resolveShareView(owner, share.token);
    expect(initial.visible).toBe(true);
    expect(JSON.stringify(initial.payload)).toContain("Test One");
    expect(JSON.stringify(initial.payload)).not.toContain(fixture.cardId);
    expect(JSON.stringify((await resolveShareView(viewer, share.token)).payload)).toContain("Test One");
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id = ? AND user_id = ?").bind(privateCollection.id, other.id).run();
    expect(JSON.stringify((await resolveShareView(viewer, share.token)).payload)).not.toContain("Test One");
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id = ? AND user_id = ?").bind(privateCollection.id, player.user!.id).run();
    expect(JSON.stringify((await resolveShareView(owner, share.token)).payload)).not.toContain("Test One");
    expect(JSON.stringify(await listShareLinks(player))).not.toContain("Test One");
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)").bind(privateCollection.id, player.user!.id, owner.user!.id, nowIso()).run();
    expect(JSON.stringify((await resolveShareView(owner, share.token)).payload)).toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_share_links SET payload_json = ? WHERE id = ?").bind(JSON.stringify({ audience: "member", items: [{ card_name: "Legacy restricted", card_slug: "test-one" }] }), share.id).run();
    expect(JSON.stringify((await resolveShareView(owner, share.token)).payload)).not.toContain("Legacy restricted");
  });

  it("rechecks scoped collection authority for both wishlist creator and viewer", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Scoped share fixture", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    const scope = JSON.stringify({ all: false, collectionIds: [collection.id] });
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id, user_id, role, scopes_json, status, granted_by, granted_at, reason) VALUES ('share_scope', ?, 'global_collection_admin', ?, 'active', ?, ?, 'fixture')").bind(player.user!.id, scope, owner.user!.id, nowIso()).run();
    await toggleWishlist(player, fixture.cardId, true);
    await updatePreferences(player, { sharingEnabled: true });
    const playerShare = await createShareLink(player, { kind: "wishlist" });
    expect(JSON.stringify((await resolveShareView(owner, playerShare.token)).payload)).toContain("Test One");
    await toggleWishlist(owner, fixture.cardId, true);
    await updatePreferences(owner, { sharingEnabled: true });
    const ownerShare = await createShareLink(owner, { kind: "wishlist" });
    expect(JSON.stringify((await resolveShareView(player, ownerShare.token)).payload)).toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json = ? WHERE id = 'share_scope'").bind(JSON.stringify({ all: false, collectionIds: ["other"] })).run();
    expect(JSON.stringify((await resolveShareView(owner, playerShare.token)).payload)).not.toContain("Test One");
    expect(JSON.stringify((await resolveShareView(player, ownerShare.token)).payload)).not.toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json = ?, status = 'revoked' WHERE id = 'share_scope'").bind(scope).run();
    expect(JSON.stringify((await resolveShareView(owner, playerShare.token)).payload)).not.toContain("Test One");
    expect(JSON.stringify((await resolveShareView(player, ownerShare.token)).payload)).not.toContain("Test One");
  });

  it("reauthorizes 100 wishlist entries in bounded queries", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    await fixturePool(owner);
    const harbour = await runtime.DB.prepare("SELECT id FROM fb_tenants WHERE slug = 'harbour'").first<{ id: string }>();
    await addMembership(runtime.DB, harbour!.id, player.user!.id, "player");
    const items: Array<{ card_id: string; card_name: string }> = [];
    for (let i = 0; i < 100; i++) {
      const id = `share_bulk_${i}`;
      const now = nowIso();
      await runtime.DB.batch([
        runtime.DB.prepare("INSERT INTO fb_card_definitions (id, tenant_id, logical_id, slug, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 'published', ?, ?)").bind(id, owner.tenant.id, id, id, `Bulk ${i}`, now, now),
        runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, added_by, added_at) VALUES ('col_test_public', ?, ?, ?, ?)").bind(id, owner.tenant.id, owner.user!.id, now),
      ]);
      items.push({ card_id: id, card_name: `Bulk ${i}` });
    }
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "wishlist" });
    await runtime.DB.prepare("UPDATE fb_share_links SET payload_json = ? WHERE id = ?").bind(JSON.stringify({ audience: "member", items }), share.id).run();
    const result = await resolveShareView(player, share.token);
    expect(result.payload.items).toHaveLength(100);
    expect(JSON.stringify(result.payload)).not.toContain("card_id");
  });

  it("shares only pinned cards and rechecks creator and viewer access", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Private pins", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)").bind(collection.id, player.user!.id, owner.user!.id, nowIso()).run();
    const instance = await makeInstance(owner, owner.user!.id, fixture, "PRIVATE-PIN-SERIAL");
    await runtime.DB.prepare("UPDATE fb_card_instances SET favourite = 1 WHERE id = ?").bind(instance).run();
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "profile" });
    expect(JSON.stringify(share.preview)).not.toContain(fixture.cardId);
    const initial = await resolveShareView(player, share.token);
    expect(JSON.stringify(initial.payload)).toContain("Test One");
    expect(JSON.stringify(initial.payload)).not.toMatch(/PRIVATE-PIN-SERIAL|card_id|badge|wallet/);
    expect((await resolveShareView(anonymous(owner), share.token)).visible).toBe(false);
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id = ? AND user_id = ?").bind(collection.id, player.user!.id).run();
    expect(JSON.stringify((await resolveShareView(player, share.token)).payload)).not.toContain("Test One");
    await runtime.DB.prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?").bind(nowIso(), owner.tenant.id, owner.user!.id).run();
    expect((await resolveShareView(player, share.token)).active).toBe(false);
  });

  it("shares only a verifiable achievement roster and rechecks its audience", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await collectionSession(await ctxFor("cabinet", "player@foilbury.local"));
    const fixture = await fixturePool(owner);
    const collection = await createCollection(owner, { name: "Badge private world", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, collection.id, [fixture.cardId]);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)").bind(collection.id, player.user!.id, owner.user!.id, nowIso()).run();
    const criteria = JSON.stringify({ type: "collection_complete", collection_id: collection.id, roster_card_ids: [fixture.cardId] });
    const now = nowIso();
    await runtime.DB.prepare("INSERT INTO fb_achievement_definitions (id,scope,tenant_id,key,version,name,description,criteria_json,visibility,art_key,category,status,created_by,created_at,updated_at) VALUES ('share_badge','bot',?,'share_badge',1,'Private badge','Private description',?,'member','medal-generic','collection','active',?,?,?)").bind(owner.tenant.id, criteria, owner.user!.id, now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_achievement_unlocks (id,tenant_id,user_id,achievement_id,achievement_version,earned_at,created_at) VALUES ('share_unlock',?,?,'share_badge',1,?,?)").bind(owner.tenant.id, owner.user!.id, now, now).run();
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "achievement", targetId: "share_unlock" });
    expect(JSON.stringify(share.preview)).not.toMatch(/criteria_hash|achievement_id|Private badge|Private description/);
    expect(JSON.stringify((await resolveShareView(player, share.token)).payload)).toContain("Badge private world · Achievement");
    for (const change of ['unlock','status','criteria'] as const) {
      let injected=false;const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes('SELECT 1 AS ok FROM fb_share_links l'))return stmt;
        return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='first')return async()=>{if(!injected){injected=true;
          if(change==='unlock')await target.prepare("UPDATE fb_achievement_unlocks SET earned_at='2000-01-01T00:00:00.000Z' WHERE id='share_unlock'").run();
          else if(change==='status')await target.prepare("UPDATE fb_achievement_definitions SET status='draft' WHERE id='share_badge'").run();
          else await target.prepare("UPDATE fb_achievement_definitions SET criteria_json='{}' WHERE id='share_badge'").run();
        }return b.first();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
      };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
      expect((await resolveShareView({...player,db},share.token)).payload).toEqual({});
      await runtime.DB.prepare("UPDATE fb_achievement_unlocks SET earned_at=? WHERE id='share_unlock'").bind(now).run();
      await runtime.DB.prepare("UPDATE fb_achievement_definitions SET status='active',criteria_json=? WHERE id='share_badge'").bind(criteria).run();
    }
    expect(JSON.stringify((await resolveShareView(player, share.token)).payload)).toContain("Badge private world · Achievement");
    expect((await resolveShareView(anonymous(owner), share.token)).visible).toBe(false);
    const hiddenExtra = await createCollection(owner, { name: "Restricted second membership", scope: "global", status: "published", viewAudience: "private" });
    await addCollectionCards(owner, hiddenExtra.id, [fixture.cardId]);
    expect((await resolveShareView(player, share.token)).payload).toEqual({});
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = ? AND card_id = ?").bind(hiddenExtra.id, fixture.cardId).run();
    expect(JSON.stringify((await resolveShareView(player, share.token)).payload)).toContain("Badge private world · Achievement");
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id = ? AND user_id = ?").bind(collection.id, player.user!.id).run();
    expect((await resolveShareView(player, share.token)).payload).toEqual({});
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES (?,?,?,?)").bind(collection.id, player.user!.id, owner.user!.id, nowIso()).run();
    await runtime.DB.prepare("UPDATE fb_achievement_definitions SET criteria_json = ? WHERE id = 'share_badge'").bind(JSON.stringify({ type: "collection_complete", collection_id: collection.id, roster_card_ids: ["other"] })).run();
    expect((await resolveShareView(player, share.token)).payload).toEqual({});
    await expect(createShareLink(owner, { kind: "achievement", targetId: "share_unlock" })).rejects.toMatchObject({ code: "achievement_share_unavailable" });
  });

  it("rejects hidden collection snapshots and suppresses unpublished and legacy profile shares", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await fixturePool(owner);
    const privateCollection = await createCollection(owner, { name: "Hidden fixture", scope: "global", status: "published", viewAudience: "private" });
    await updatePreferences(player, { sharingEnabled: true });
    await expect(createShareLink(player, { kind: "collection", targetId: privateCollection.id })).rejects.toMatchObject({ status: 404 });
    await updatePreferences(owner, { sharingEnabled: true });
    const publicShare = await createShareLink(owner, { kind: "collection", targetId: "col_test_public" });
    expect((await resolveShareView(anonymous(owner), publicShare.token)).visible).toBe(true);
    await runtime.DB.prepare("UPDATE fb_collections SET status = 'draft' WHERE id = 'col_test_public'").run();
    const hidden = await resolveShareView(anonymous(owner), publicShare.token);
    expect(hidden.visible).toBe(false);
    expect(hidden.payload).toEqual({});
    expect(hidden.collection).toBeNull();
    expect((await createShareLink(owner, { kind: "profile" })).kind).toBe("profile");
    const legacy = await createShareLink(owner, { kind: "wishlist" });
    await runtime.DB.prepare("UPDATE fb_share_links SET kind = 'profile', payload_json = ? WHERE id = ?").bind(JSON.stringify({ audience: "member", favourite_cards: [{ name: "Private profile fixture" }] }), legacy.id).run();
    const legacyView = await resolveShareView(player, legacy.token);
    expect(legacyView.visible).toBe(false);
    expect(legacyView.payload).toEqual({});
    expect(JSON.stringify(await listShareLinks(owner))).not.toContain("Private profile fixture");
    await runtime.DB.prepare("UPDATE fb_share_links SET kind = 'cabinet', payload_json = ? WHERE id = ?").bind(JSON.stringify({ audience: "member", cards: 456, favourites: 123 }), legacy.id).run();
    const oldCabinet = await resolveShareView(player, legacy.token);
    expect(oldCabinet.visible).toBe(false);
    expect(oldCabinet.payload).toEqual({});
    await expect(createShareLink(owner, { kind: "achievement", targetId: "badge-fixture" })).rejects.toMatchObject({ code: "achievement_share_unavailable" });
    await runtime.DB.prepare("UPDATE fb_share_links SET kind = 'achievement', payload_json = ? WHERE id = ?").bind(JSON.stringify({ audience: "member", achievement_name: "Private badge fixture", collection_logo_url: "/private/logo" }), legacy.id).run();
    const oldBadge = await resolveShareView(player, legacy.token);
    expect(oldBadge.visible).toBe(false);
    expect(oldBadge.payload).toEqual({});
    expect(JSON.stringify(await listShareLinks(owner))).not.toContain("Private badge fixture");
  });

  it("stops resolving on revocation, expiry or the owner's revoked membership", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    await updatePreferences(owner, { sharingEnabled: true });
    const revoked = await createShareLink(owner, { kind: "wishlist", expiresInDays: 7 });
    await revokeShareLink(owner, revoked.id);
    expect((await resolveShareView(owner, revoked.token)).active).toBe(false);

    const expired = await createShareLink(owner, { kind: "wishlist", expiresInDays: 1 });
    await runtime.DB.prepare("UPDATE fb_share_links SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), expired.id).run();
    expect((await resolveShareView(owner, expired.token)).active).toBe(false);

    const ownerRevoked = await createShareLink(owner, { kind: "wishlist", expiresInDays: 7 });
    await runtime.DB
      .prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?")
      .bind(nowIso(), owner.tenant.id, owner.user!.id)
      .run();
    // Even the owner's own browser cannot keep the snapshot alive once they are
    // no longer an active member of the Bot.
    expect((await resolveShareView(owner, ownerRevoked.token)).active).toBe(false);
  });

  it("does not resolve a cabinet share from another Bot", async () => {
    const owner = await collectionSession(await ctxFor("cabinet", "owner@foilbury.local"));
    await updatePreferences(owner, { sharingEnabled: true });
    const share = await createShareLink(owner, { kind: "wishlist", expiresInDays: 7 });
    const harbour = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const cross = await resolveShareView(harbour, share.token);
    expect(cross.active).toBe(false);
    expect(cross.visible).toBe(false);
  });
});
