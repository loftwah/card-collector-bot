import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { addMembership, createAgentGrant, createUser, ensureWallet } from "../../src/server/modules/identity";
import { getGiftPolicy, listAdminGiftCampaigns, previewAdminGift, processGiftCampaign, recoverAdminGift, sendAdminGift } from "../../src/server/modules/admin-gifts";
import { listMyGiftReceipts } from "../../src/server/modules/admin-gifts";
import { routeApi } from "../../src/server/api/router";
import { buildContext } from "../../src/server/context";
import { nowIso } from "../../src/server/db";
import { sha256Hex } from "../../src/server/ids";

async function strong(ctx: Awaited<ReturnType<typeof ctxFor>>) {
  const now = nowIso();
  const session = `gift-session-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?, ?, ?, ?, 'test', ?, ?, ?, 'passkey', ?)")
    .bind(session, session, ctx.user!.id, ctx.tenant.id, now, new Date(Date.now() + 60000).toISOString(), now, now).run();
  return { ...ctx, sessionId: session, sessionAssurance: "passkey", sessionAuthTime: now };
}

async function member(tenantId: string, email: string) {
  const user = await createUser(runtime.DB, { email, displayName: email.split("@")[0]!, password: "a-long-test-password" });
  await addMembership(runtime.DB, tenantId, user.id, "player");
  await ensureWallet(runtime.DB, tenantId, user.id);
  return user;
}

describe("scoped administrator gifts", () => {
  it('provides only minimal same-Bot recipients and public enabled cards to a grants-only Studio sender', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const senderUser=await member(owner.tenant.id,'scoped-gift-sender@example.com');
    const recipient=await member(owner.tenant.id,'scoped-gift-recipient@example.com');
    const foreign=await ctxFor('harbour','harbour.owner@foilbury.test');
    const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"grants\"]',grant_limit=100 WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,senderUser.id).run();
    const sender=await strong(await ctxFor('cabinet','scoped-gift-sender@example.com'));
    const request=(path:string)=>new Request(`https://foilbury.test/api/v1/${path}`);
    const recipientResponse=await routeApi(request('studio/gifts/recipients'),sender,'studio/gifts/recipients');
    const people=await recipientResponse.json() as {items:Array<Record<string,unknown>>};
    expect(people.items.some((person)=>person.id===recipient.id)).toBe(true);
    expect(people.items.some((person)=>person.id===foreign.user!.id)).toBe(false);
    expect(people.items.every((person)=>Object.keys(person).sort().join(',')==='display_name,id')).toBe(true);
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET name='Private print secret' WHERE id=?").bind(fixture.editionId).run();
    await runtime.DB.prepare("UPDATE fb_variants SET name='Private variant secret' WHERE id=?").bind(fixture.variantId).run();
    const cardResponse=await routeApi(request('studio/gifts/cards'),sender,'studio/gifts/cards');
    const cardChoices=await cardResponse.json() as {items:unknown[]};
    expect(cardChoices.items).toContainEqual({id:fixture.cardId,name:'Test One',variant_id:fixture.variantId});
    expect(JSON.stringify(cardChoices)).not.toContain('Private print secret');
    expect(JSON.stringify(cardChoices)).not.toContain('Private variant secret');
    const sendRequest=new Request('https://foilbury.test/api/v1/studio/gifts',{method:'POST',headers:{'content-type':'application/json','x-foilbury-csrf':'test','idempotency-key':'scoped-gift-card'},body:JSON.stringify({kind:'card',scope:'single',userIds:[recipient.id],cardId:fixture.cardId,variantId:fixture.variantId,reason:'Scoped fixture'})});
    const delivered=await (await routeApi(sendRequest,sender,'studio/gifts')).json() as {sent_count:number};
    expect(delivered.sent_count).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_card_instances WHERE tenant_id=? AND user_id=? AND card_id=? AND variant_id=? AND acquired_via LIKE 'gift:%'").bind(owner.tenant.id,recipient.id,fixture.cardId,fixture.variantId).first<{n:number}>())?.n).toBe(1);
    await expect(routeApi(request('studio/members'),sender,'studio/members')).rejects.toMatchObject({status:403});
    const ownerMembers=await routeApi(request('studio/members'),owner,'studio/members');
    expect((await ownerMembers.json() as {items:unknown[]}).items.length).toBeGreaterThan(0);
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"members\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,senderUser.id).run();
    const memberAdmin=await strong(await ctxFor('cabinet','scoped-gift-sender@example.com'));
    expect((await (await routeApi(request('studio/members'),memberAdmin,'studio/members')).json() as {items:unknown[]}).items.length).toBeGreaterThan(0);
    const grant=await createAgentGrant(owner,{agentName:'members-reader',representedUserId:senderUser.id,scopes:['ops:read'],expiresInDays:1});
    const agentRequest=new Request('https://foilbury.test/api/v1/studio/members',{headers:{authorization:`Bearer ${grant.token}`}});
    const agent=await buildContext(agentRequest);
    expect((await (await routeApi(agentRequest,agent,'studio/members')).json() as {items:unknown[]}).items.length).toBeGreaterThan(0);
    await runtime.DB.prepare("UPDATE fb_agent_grants SET status='revoked' WHERE id=?").bind(grant.grantId).run();
    await expect(routeApi(agentRequest,agent,'studio/members')).rejects.toMatchObject({status:403});
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"grants\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,senderUser.id).run();
    // The existing catalogue route still has a legacy editor mapping; this change does not expand it.
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'").run();
    expect((await (await routeApi(request('studio/gifts/cards'),sender,'studio/gifts/cards')).json() as {items:unknown[]}).items).toEqual([]);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='public' WHERE id='col_test_public'").run();
    await runtime.DB.prepare("UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'").run();
    expect((await (await routeApi(request('studio/gifts/cards'),sender,'studio/gifts/cards')).json() as {items:unknown[]}).items).toEqual([]);
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,senderUser.id).run();
    await expect(routeApi(request('studio/gifts/recipients'),sender,'studio/gifts/recipients')).rejects.toMatchObject({code:'gift_authority_changed'});
    await expect(routeApi(request('studio/gifts/cards'),sender,'studio/gifts/cards')).rejects.toMatchObject({code:'gift_authority_changed'});
  });

  it('fences a reviewed Bot-wide roster against join and revocation before commit', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const base={kind:'foil' as const,scope:'bot_members' as const,amount:10,reason:'Roster fixture',idempotency:{key:'gift-roster-race',digest:'gift-roster-race'}};
    const preview=await previewAdminGift(owner,base);
    await member(owner.tenant.id,'gift-roster-joined@example.com');
    await expect(sendAdminGift(owner,{...base,expectedRecipientsDigest:preview.recipient_digest})).rejects.toMatchObject({code:'gift_recipients_changed'});
    const next=await previewAdminGift(owner,base);
    let changed=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{if(!changed){changed=true;await target.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=(SELECT id FROM fb_users WHERE email=?)").bind(nowIso(),owner.tenant.id,'gift-roster-joined@example.com').run();}return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(sendAdminGift({...owner,db},{...base,expectedRecipientsDigest:next.recipient_digest})).rejects.toThrow();
    const row=await runtime.DB.prepare('SELECT COUNT(*) AS count FROM fb_gift_campaigns WHERE idempotency_key=?').bind(base.idempotency.key).first<{count:number}>();
    expect(row?.count).toBe(0);
  });

  it('delivers a member-audience card to a current member of its enabled Bot', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const recipient=await member(owner.tenant.id,'member-card-gift@example.com');
    const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'").run();
    const result=await sendAdminGift(owner,{kind:'card',scope:'single',userIds:[recipient.id],cardId:fixture.cardId,reason:'Member gift',idempotency:{key:'member-card-gift',digest:'member-card-gift'}});
    expect(result).toMatchObject({status:'completed',sent_count:1});
    const privateRecipient=await member(owner.tenant.id,'private-card-gift@example.com');
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(privateRecipient.id,owner.user!.id,nowIso()).run();
    const privateResult=await sendAdminGift(owner,{kind:'card',scope:'single',userIds:[privateRecipient.id],cardId:fixture.cardId,reason:'Private gift',idempotency:{key:'private-card-gift',digest:'private-card-gift'}});
    expect(privateResult).toMatchObject({status:'completed',sent_count:1});
  });
  it('binds opening gifts to the reviewed price, prevents price races and freezes retry value', async () => {
    await bootstrap();
    const root=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const owner={...root,user:{...root.user!,platformAdmin:false}};
    const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_pools SET slug='cabinet-draw' WHERE id=?").bind(fixture.poolId).run();
    const recipient=await member(owner.tenant.id,'opening-gift@example.com');
    const before=await walletBalance(owner,recipient.id);
    const base={kind:'opening' as const,scope:'single' as const,userIds:[recipient.id],openings:2,reason:'Opening fixture',idempotency:{key:'opening-gift',digest:'opening-gift'}};
    const preview=await previewAdminGift(owner,base);
    expect(preview).toMatchObject({per_recipient_foil:160,standard_opening_price:80,standard_opening_revision:1});
    await expect(previewAdminGift(owner,{...base,openings:20})).rejects.toMatchObject({code:'amount_limit'});
    const reviewed={...base,expectedOpeningPrice:80,expectedPoolRevision:1};
    let batches=0;
    const racing=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{batches++;if(batches===1) await target.prepare('UPDATE fb_pools SET price=90,revision=revision+1 WHERE id=?').bind(fixture.poolId).run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(sendAdminGift({...owner,db:racing},reviewed)).rejects.toThrow();
    expect(await walletBalance(owner,recipient.id)).toBe(before);
    const noCampaign=await runtime.DB.prepare('SELECT COUNT(*) AS count FROM fb_gift_campaigns WHERE idempotency_key=?').bind(base.idempotency.key).first<{count:number}>();
    expect(noCampaign?.count).toBe(0);
    await runtime.DB.prepare('UPDATE fb_pools SET price=80,revision=1 WHERE id=?').bind(fixture.poolId).run();
    let count=0;
    const afterCommit=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{count++;if(count===2) await target.prepare('UPDATE fb_pools SET price=500,revision=revision+1 WHERE id=?').bind(fixture.poolId).run();if(count===3)return target.batch([...statements,target.prepare('SELECT * FROM missing_gift_receipt_fixture')]);return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const pending=await sendAdminGift({...owner,db:afterCommit},reviewed);
    expect(pending).toMatchObject({status:'sending',pending_count:1});
    expect(await walletBalance(owner,recipient.id)).toBe(before+160);
    await processGiftCampaign(owner,pending.campaign_id);
    expect(await walletBalance(owner,recipient.id)).toBe(before+160);
  });
  it("holds a card award when any associated collection is not public", async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const recipient=await member(owner.tenant.id,'held-card-gift@example.com');
    const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
    const input={kind:'card' as const,scope:'single' as const,userIds:[recipient.id],cardId:fixture.cardId,reason:'Held card fixture',idempotency:{key:'held-card-gift',digest:'held-card-gift'}};
    const result=await sendAdminGift(owner,input);
    expect(result).toMatchObject({status:'sending',pending_count:1,reconciliation_pending:true});
    const row=await runtime.DB.prepare('SELECT COUNT(*) AS count FROM fb_card_instances WHERE user_id=?').bind(recipient.id).first<{count:number}>();
    expect(row?.count).toBe(0);
  });

  it('does not award a card when its collection becomes restricted just before the card batch', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const recipient=await member(owner.tenant.id,'card-visibility-race@example.com');
    const fixture=await fixturePool(owner);
    let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{batches++;if(batches===2) await target.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const result=await sendAdminGift({...owner,db},{kind:'card',scope:'single',userIds:[recipient.id],cardId:fixture.cardId,reason:'Visibility race',idempotency:{key:'card-visibility-race',digest:'card-visibility-race'}});
    expect(result).toMatchObject({status:'sending',pending_count:1});
    const count=await runtime.DB.prepare('SELECT COUNT(*) AS count FROM fb_card_instances WHERE user_id=?').bind(recipient.id).first<{count:number}>();
    expect(count?.count).toBe(0);
  });
  it("allows a current grants delegate and denies a revoked or malformed explicit grant", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor('cabinet', 'owner@foilbury.local'));
    const editorUser = await member(owner.tenant.id, 'gift-editor@example.com');
    const recipient = await member(owner.tenant.id, 'gift-editor-recipient@example.com');
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"grants\"]',grant_limit=100 WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,editorUser.id).run();
    const bot = await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES (?, ?, ?, 'admin', '[\"grants\"]', 'active', ?)")
      .bind(`gift-admin-${crypto.randomUUID()}`,bot!.id,editorUser.id,nowIso()).run();
    const editor = await strong(await ctxFor('cabinet','gift-editor@example.com'));
    const input = { kind: 'foil' as const, scope: 'single' as const, userIds: [recipient.id], amount: 20, reason: 'Fixture gift', idempotency: { key: 'gift-editor', digest: 'gift-editor' } };
    expect((await previewAdminGift(editor,input)).recipient_count).toBe(1);
    const before = await walletBalance(owner,recipient.id);
    await sendAdminGift(editor,input);
    expect(await walletBalance(owner,recipient.id)).toBe(before + 20);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='\"grants\"' WHERE bot_id=? AND user_id=?").bind(bot!.id,editorUser.id).run();
    await expect(previewAdminGift(editor,input)).rejects.toMatchObject({code:'gift_authority_changed'});
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='[\"grants\"]',revoked_at=? WHERE bot_id=? AND user_id=?").bind(nowIso(),bot!.id,editorUser.id).run();
    await expect(sendAdminGift(editor,input)).rejects.toMatchObject({code:'gift_authority_changed'});
    await expect(listAdminGiftCampaigns(editor)).rejects.toMatchObject({code:'gift_authority_changed'});
  });

  it('enforces live grants, self-grant policy and reductions at the credit boundary', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const user=await member(owner.tenant.id,'gift-grant-limit@example.com');
    const recipient=await member(owner.tenant.id,'gift-grant-target@example.com');
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"economy\"]',grant_limit=100,self_grants_enabled=0 WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,user.id).run();
    const economyOnly=await strong(await ctxFor('cabinet','gift-grant-limit@example.com'));
    const input={kind:'foil' as const,scope:'single' as const,userIds:[recipient.id],amount:50,reason:'Grant fixture',idempotency:{key:'gift-grant-race',digest:'gift-grant-race'}};
    await expect(sendAdminGift(economyOnly,input)).rejects.toMatchObject({code:'gift_authority_changed'});
    await expect(getGiftPolicy(economyOnly)).rejects.toMatchObject({code:'gift_authority_changed'});
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"grants\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,user.id).run();
    const delegate=await strong(await ctxFor('cabinet','gift-grant-limit@example.com'));
    expect(await getGiftPolicy(delegate)).toEqual({per_recipient_foil:100,self_grants_allowed:false});
    const policyResponse=await routeApi(new Request('https://foilbury.test/api/v1/admin/gifts/policy'),delegate,'admin/gifts/policy');
    expect(await policyResponse.json()).toEqual({per_recipient_foil:100,self_grants_allowed:false});
    await expect(routeApi(new Request('https://foilbury.test/api/v1/admin/gifts/policy/extra'),delegate,'admin/gifts/policy/extra')).rejects.toMatchObject({status:404});
    await expect(previewAdminGift(delegate,{...input,userIds:[user.id]})).rejects.toMatchObject({code:'gift_grant_limit'});
    const before=await walletBalance(owner,recipient.id);
    let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{batches++;if(batches===2) await target.prepare('UPDATE fb_memberships SET grant_limit=10 WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,user.id).run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const pending=await sendAdminGift({...delegate,db},input);
    expect(pending).toMatchObject({status:'sending',pending_count:1});
    expect(await walletBalance(owner,recipient.id)).toBe(before);
    const replay=await sendAdminGift(delegate,input);
    expect(replay).toMatchObject({replayed:true,pending_count:1});
    expect(await getGiftPolicy(delegate)).toEqual({per_recipient_foil:10,self_grants_allowed:false});
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),delegate.sessionId).run();
    await expect(getGiftPolicy(delegate)).rejects.toMatchObject({code:'gift_authority_changed'});
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=NULL WHERE id=?').bind(delegate.sessionId).run();
    expect(await walletBalance(owner,recipient.id)).toBe(before);
    await runtime.DB.prepare('UPDATE fb_memberships SET grant_limit=100,self_grants_enabled=1 WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,user.id).run();
    let selfBatches=0;
    const selfRace=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{selfBatches++;if(selfBatches===2) await target.prepare('UPDATE fb_memberships SET self_grants_enabled=0 WHERE tenant_id=? AND user_id=?').bind(owner.tenant.id,user.id).run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const ownBefore=await walletBalance(owner,user.id);
    const ownPending=await sendAdminGift({...delegate,db:selfRace},{...input,userIds:[user.id],idempotency:{key:'gift-self-race',digest:'gift-self-race'}});
    expect(ownPending).toMatchObject({status:'sending',pending_count:1});
    expect(await walletBalance(owner,user.id)).toBe(ownBefore);
  });

  it('shows gift receipts only for an active membership in the current Bot', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const recipient=await member(owner.tenant.id,'receipt-scope@example.com');
    await sendAdminGift(owner,{kind:'foil',scope:'single',userIds:[recipient.id],amount:20,reason:'Scope fixture',idempotency:{key:'gift-receipt-scope',digest:'gift-receipt-scope'}});
    const viewer=await strong(await ctxFor('cabinet','receipt-scope@example.com'));
    expect(await listMyGiftReceipts(viewer)).toHaveLength(1);
    expect(await listMyGiftReceipts({...viewer,tenant:{...viewer.tenant,id:'foreign-tenant'}})).toHaveLength(0);
    await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(nowIso(),owner.tenant.id,recipient.id).run();
    expect(await listMyGiftReceipts(viewer)).toHaveLength(0);
  });
  it("denies a revoked session during the campaign batch without a campaign or credit", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "gift-revocation@example.com");
    const before = await walletBalance(owner, recipient.id);
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        await target.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?").bind(nowIso(), owner.sessionId).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const input = { kind: 'foil' as const, scope: 'single' as const, userIds: [recipient.id], amount: 20, reason: 'Fixture gift', idempotency: { key: 'gift-revoked', digest: 'gift-revoked' } };
    await expect(sendAdminGift({ ...owner, db }, input)).rejects.toMatchObject({ code: 'gift_authority_changed' });
    expect(await walletBalance(owner, recipient.id)).toBe(before);
    const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_gift_campaigns WHERE idempotency_key=?").bind(input.idempotency.key).first<{count:number}>();
    expect(row?.count).toBe(0);
    await expect(previewAdminGift(owner, input)).rejects.toMatchObject({ code: 'gift_authority_changed' });
  });

  it("does not create a campaign when a recipient loses membership before commit", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const recipient = await member(owner.tenant.id, 'gift-recipient-race@example.com');
    const before = await walletBalance(owner,recipient.id);
    const db = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        await target.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(nowIso(),owner.tenant.id,recipient.id).run();
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target); return typeof value==='function' ? value.bind(target) : value;
    }});
    const input = { kind:'foil' as const, scope:'single' as const, userIds:[recipient.id], amount:20, reason:'Fixture gift', idempotency:{key:'gift-recipient-race',digest:'gift-recipient-race'} };
    await expect(sendAdminGift({...owner,db},input)).rejects.toThrow();
    expect(await walletBalance(owner,recipient.id)).toBe(before);
    const campaign=await runtime.DB.prepare('SELECT COUNT(*) AS count FROM fb_gift_campaigns WHERE idempotency_key=?').bind(input.idempotency.key).first<{count:number}>();
    expect(campaign?.count).toBe(0);
  });

  it("rolls back the campaign and idempotency record on a later batch failure", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "gift-rollback@example.com");
    const before = await walletBalance(owner, recipient.id);
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => target.batch([...statements, target.prepare('SELECT * FROM gift_missing_fixture')]);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const input = { kind: 'foil' as const, scope: 'single' as const, userIds: [recipient.id], amount: 20, reason: 'Fixture gift', idempotency: { key: 'gift-rollback', digest: 'gift-rollback' } };
    await expect(sendAdminGift({ ...owner, db }, input)).rejects.toThrow();
    expect(await walletBalance(owner, recipient.id)).toBe(before);
    const campaign = await runtime.DB.prepare('SELECT COUNT(*) AS count FROM fb_gift_campaigns WHERE idempotency_key=?').bind(input.idempotency.key).first<{count:number}>();
    const key = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_idempotency_keys WHERE idempotency_key=?").bind(input.idempotency.key).first<{count:number}>();
    expect(campaign?.count).toBe(0);
    expect(key?.count).toBe(0);
  });

  it("stops before credit if the operator is revoked after campaign creation and resumes once authorised", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "gift-credit-revocation@example.com");
    const before = await walletBalance(owner, recipient.id);
    let batches = 0;
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
        batches++;
        if (batches === 2) await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(), owner.sessionId).run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const input = { kind: 'foil' as const, scope: 'single' as const, userIds: [recipient.id], amount: 20, reason: 'Fixture gift', idempotency: { key: 'gift-credit-revoked', digest: 'gift-credit-revoked' } };
    await expect(sendAdminGift({ ...owner, db }, input)).rejects.toMatchObject({ code: 'gift_campaign_pending' });
    expect(await walletBalance(owner, recipient.id)).toBe(before);
    const campaign = await runtime.DB.prepare('SELECT id FROM fb_gift_campaigns WHERE idempotency_key=?').bind(input.idempotency.key).first<{id:string}>();
    expect(campaign?.id).toBeTruthy();
    const renewed = await strong(await ctxFor('cabinet', 'owner@foilbury.local'));
    await Promise.allSettled([processGiftCampaign(renewed, campaign!.id), processGiftCampaign(renewed, campaign!.id)]);
    expect(await walletBalance(owner, recipient.id)).toBe(before + 20);
    const ledger = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE reference_type='admin_gift' AND reference_id=?").bind(campaign!.id).first<{count:number}>();
    expect(ledger?.count).toBe(1);
    const outbox = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_outbox WHERE topic='gift.received' AND json_extract(payload_json,'$.campaign_id')=?").bind(campaign!.id).first<{count:number}>();
    expect(outbox?.count).toBe(1);
    const summary = await runtime.DB.prepare('SELECT status,sent_count,failed_count FROM fb_gift_campaigns WHERE id=?').bind(campaign!.id).first<{status:string;sent_count:number;failed_count:number}>();
    expect(summary).toMatchObject({status:'completed',sent_count:1,failed_count:0});
  });

  it('attributes a later credit to the retrying operator while preserving campaign creator', async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const admin=await member(owner.tenant.id,'gift-original-admin@example.com');
    const recipient=await member(owner.tenant.id,'gift-retry-target@example.com');
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"grants\"]',grant_limit=100 WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,admin.id).run();
    const sender=await strong(await ctxFor('cabinet','gift-original-admin@example.com'));
    let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(statements:Parameters<typeof target.batch>[0])=>{batches++;if(batches===2) await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),sender.sessionId).run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const input={kind:'foil' as const,scope:'single' as const,userIds:[recipient.id],amount:20,reason:'Retry attribution',idempotency:{key:'gift-retry-attribution',digest:'gift-retry-attribution'}};
    await expect(sendAdminGift({...sender,db},input)).rejects.toMatchObject({code:'gift_campaign_pending'});
    const campaign=await runtime.DB.prepare('SELECT id FROM fb_gift_campaigns WHERE idempotency_key=?').bind(input.idempotency.key).first<{id:string}>();
    await processGiftCampaign(owner,campaign!.id);
    const ledger=await runtime.DB.prepare("SELECT actor_id,json_extract(metadata_json,'$.campaign_created_by') AS creator FROM fb_ledger_entries WHERE reference_type='admin_gift' AND reference_id=?").bind(campaign!.id).first<{actor_id:string;creator:string}>();
    expect(ledger).toEqual({actor_id:owner.user!.id,creator:admin.id});
    const fixture=await fixturePool(owner);
    const renewedSender=await strong(await ctxFor('cabinet','gift-original-admin@example.com'));
    let cardBatches=0;
    const cardDb=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(statements:Parameters<typeof target.batch>[0])=>{cardBatches++;if(cardBatches===2) await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),renewedSender.sessionId).run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const cardInput={kind:'card' as const,scope:'single' as const,userIds:[recipient.id],cardId:fixture.cardId,reason:'Card retry attribution',idempotency:{key:'gift-card-retry-attribution',digest:'gift-card-retry-attribution'}};
    await expect(sendAdminGift({...renewedSender,db:cardDb},cardInput)).rejects.toMatchObject({code:'gift_campaign_pending'});
    const cardCampaign=await runtime.DB.prepare('SELECT id FROM fb_gift_campaigns WHERE idempotency_key=?').bind(cardInput.idempotency.key).first<{id:string}>();
    await processGiftCampaign(owner,cardCampaign!.id);
    const history=await runtime.DB.prepare("SELECT from_user_id,json_extract(metadata_json,'$.campaign_created_by') AS creator,json_extract(metadata_json,'$.processed_by') AS processor FROM fb_instance_history WHERE reference_type='admin_gift' AND reference_id=?").bind(cardCampaign!.id).first<{from_user_id:string;creator:string;processor:string}>();
    expect(history).toEqual({from_user_id:admin.id,creator:admin.id,processor:owner.user!.id});
  });

  it("holds an uncertain award pending and derives completed totals after retry", async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const firstUser=await member(owner.tenant.id,'a-gift-partial@example.com');
    const secondUser=await member(owner.tenant.id,'z-gift-partial@example.com');
    let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
        batches++;
        if(batches===2) await target.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(nowIso(),owner.tenant.id,firstUser.id).run();
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const input={kind:'foil' as const,scope:'recipients' as const,userIds:[firstUser.id,secondUser.id],amount:20,reason:'Partial fixture',idempotency:{key:'gift-partial',digest:'gift-partial'}};
    const partial=await sendAdminGift({...owner,db},input);
    expect(partial).toMatchObject({status:'sending',sent_count:1,failed_count:0,pending_count:1,reconciliation_pending:true});
    await runtime.DB.prepare("UPDATE fb_memberships SET status='active',revoked_at=NULL WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,firstUser.id).run();
    const complete=await processGiftCampaign(owner,partial.campaign_id);
    expect(complete).toMatchObject({status:'completed',sent_count:2,failed_count:0});
    const ledger=await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE reference_type='admin_gift' AND reference_id=?").bind(partial.campaign_id).first<{count:number}>();
    expect(ledger?.count).toBe(2);
  });

  it("does not call a committed credit failed when receipt recording fails", async () => {
    await bootstrap();
    const owner=await strong(await ctxFor('cabinet','owner@foilbury.local'));
    const recipient=await member(owner.tenant.id,'gift-receipt-interruption@example.com');
    const before=await walletBalance(owner,recipient.id);
    let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
        batches++;
        if(batches===3) return target.batch([...statements,target.prepare('SELECT * FROM missing_gift_receipt_fixture')]);
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const input={kind:'foil' as const,scope:'single' as const,userIds:[recipient.id],amount:20,reason:'Receipt interruption',idempotency:{key:'gift-receipt-interruption',digest:'gift-receipt-interruption'}};
    const pending=await sendAdminGift({...owner,db},input);
    expect(pending).toMatchObject({status:'sending',sent_count:0,failed_count:0,pending_count:1,reconciliation_pending:true});
    expect(await walletBalance(owner,recipient.id)).toBe(before+20);
    const complete=await processGiftCampaign(owner,pending.campaign_id);
    expect(complete).toMatchObject({status:'completed',sent_count:1,failed_count:0,pending_count:0});
    expect(await walletBalance(owner,recipient.id)).toBe(before+20);
    const ledger=await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE reference_type='admin_gift' AND reference_id=?").bind(pending.campaign_id).first<{count:number}>();
    expect(ledger?.count).toBe(1);
  });
  it("delivers an exact published finish when a card gift names the variant", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const recipient = await member(owner.tenant.id, "gold.gift@example.com");
    const gold = await runtime.DB.prepare("SELECT id FROM fb_materials WHERE tenant_id = ? AND key = 'gold'").bind(owner.tenant.id).first<{ id: string }>();
    const none = await runtime.DB.prepare("SELECT id FROM fb_effects WHERE tenant_id = ? AND key = 'none'").bind(owner.tenant.id).first<{ id: string }>();
    const now = nowIso();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES ('var_gift_gold', ?, ?, ?, ?, ?, 'Gold', 'published', ?)",
      ).bind(owner.tenant.id, fixture.cardId, fixture.editionId, gold!.id, none!.id, now),
      runtime.DB.prepare(
        "INSERT INTO fb_variant_renders (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, status, created_at, published_at) VALUES ('vr_gift_gold', ?, 'var_gift_gold', ?, ?, '/media/public/gift-gold', 750, 1050, 'gift-gold-hash', 'published', ?, ?)",
      ).bind(owner.tenant.id, fixture.recipeId, fixture.renderAsset, now, now),
    ]);
    const key = "gift-exact-finish";
    const result = await sendAdminGift(owner, {
      kind: "card",
      scope: "single",
      userIds: [recipient.id],
      cardId: fixture.cardId,
      variantId: "var_gift_gold",
      reason: "Exact-finish gift proof",
      idempotency: { key, digest: await sha256Hex(key) },
    });
    expect(result.status).toBe("completed");
    const instance = await runtime.DB.prepare("SELECT variant_id, serial FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, recipient.id).first<{ variant_id: string; serial: string }>();
    expect(instance?.variant_id).toBe("var_gift_gold");
    await expect(sendAdminGift(owner, {
      kind: "card",
      scope: "single",
      userIds: [recipient.id],
      cardId: fixture.cardId,
      variantId: "var_not_a_finish",
      reason: "Invalid exact finish",
      idempotency: { key: "gift-bad-finish", digest: await sha256Hex("gift-bad-finish") },
    })).rejects.toMatchObject({ code: "variant_invalid" });
  });

  it("previews, sends and retries a Foil gift without double-crediting", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "gift.recipient@example.com");
    const before = await walletBalance(owner, recipient.id);
    const input = {
      kind: "foil" as const,
      scope: "single" as const,
      userIds: [recipient.id],
      amount: 480,
      reason: "Community night thank-you",
      message: "Thanks for being part of the first season.",
      idempotency: { key: "gift-test-1", digest: "gift-digest-1" },
    };
    const preview = await previewAdminGift(owner, input);
    expect(preview.recipient_count).toBe(1);
    expect(preview.per_recipient_foil).toBe(480);
    const sent = await sendAdminGift(owner, input);
    expect(sent.status).toBe("completed");
    expect(sent.sent_count).toBe(1);
    expect(await walletBalance(owner, recipient.id)).toBe(before + 480);
    const replay = await sendAdminGift(owner, input);
    expect(replay.replayed).toBe(true);
    expect(replay).toMatchObject({status:'completed',sent_count:1,pending_count:0});
    expect(await recoverAdminGift(owner,input.idempotency.key)).toMatchObject({found:true,campaign:{id:sent.campaign_id,status:'completed',sent_count:1}});
    expect(await recoverAdminGift(owner,'gift-unknown-key')).toEqual({found:false});
    expect(await walletBalance(owner, recipient.id)).toBe(before + 480);
    const ledger = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'admin_gift'").bind(owner.tenant.id, recipient.id).first<{ count: number }>();
    expect(ledger?.count).toBe(1);
    const campaign = await runtime.DB.prepare("SELECT status, sent_count FROM fb_gift_campaigns WHERE id = ?").bind(sent.campaign_id).first<{ status: string; sent_count: number }>();
    expect(campaign?.status).toBe("completed");
    expect(campaign?.sent_count).toBe(1);
  });

  it("resumes a failed campaign without double-crediting the same award", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "gift.resume@example.com");
    const before = await walletBalance(owner, recipient.id);
    const sent = await sendAdminGift(owner, {
      kind: "foil",
      scope: "single",
      userIds: [recipient.id],
      amount: 120,
      reason: "Resume proof",
      idempotency: { key: "gift-resume", digest: await sha256Hex("gift-resume") },
    });
    expect(sent.status).toBe("completed");
    expect(await walletBalance(owner, recipient.id)).toBe(before + 120);

    // Simulate a crash that left the durable campaign record failed after the
    // award was already delivered. The resume must transition through sending
    // before effects and must not credit the same award twice.
    await runtime.DB.prepare(
      "UPDATE fb_gift_campaigns SET status = 'failed', completed_at = NULL WHERE id = ? AND tenant_id = ?",
    )
      .bind(sent.campaign_id, owner.tenant.id)
      .run();
    const resumed = await processGiftCampaign(owner, sent.campaign_id);
    expect(resumed.status).toBe("completed");
    expect(resumed.sent_count).toBe(1);
    expect(await walletBalance(owner, recipient.id)).toBe(before + 120);
    const ledger = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND reference_type = 'admin_gift'",
    )
      .bind(owner.tenant.id, recipient.id)
      .first<{ count: number }>();
    expect(ledger?.count).toBe(1);
  });

  it("delivers a card gift as one owned copy with a serial and a receipt", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const fixture = await fixturePool(owner);
    const recipient = await member(owner.tenant.id, "card.gift@example.com");
    const input = {
      kind: "card" as const,
      scope: "single" as const,
      userIds: [recipient.id],
      cardId: fixture.cardId,
      reason: "Prize for the launch quiz",
      idempotency: { key: "gift-card-1", digest: "gift-card-digest" },
    };
    const sent = await sendAdminGift(owner, input);
    expect(sent.sent_count).toBe(1);
    const instance = await runtime.DB.prepare("SELECT id, serial, user_id, acquired_via FROM fb_card_instances WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, recipient.id).first<{ id: string; serial: string; user_id: string; acquired_via: string }>();
    expect(instance?.user_id).toBe(recipient.id);
    expect(instance?.serial).toMatch(/^FB-G-/);
    expect(instance?.acquired_via).toContain("gift:");
    const receiptCtx = await strong(await ctxFor("cabinet", "card.gift@example.com"));
    const receipts = await listMyGiftReceipts(receiptCtx);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.kind).toBe("card");
  });

  it("denies a player and enforces the per-recipient limit", async () => {
    await bootstrap();
    const player = await strong(await ctxFor("cabinet", "player@foilbury.local"));
    const recipient = await member(player.tenant.id, "limit.recipient@example.com");
    await expect(
      sendAdminGift(player, {
        kind: "foil",
        scope: "single",
        userIds: [recipient.id],
        amount: 10,
        reason: "Not allowed",
        idempotency: { key: "gift-denied", digest: "denied" },
      }),
    ).rejects.toMatchObject({ code: "insufficient_role" });

    const ownerCtx = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const owner = { ...ownerCtx, user: { ...ownerCtx.user!, platformAdmin: false } };
    await expect(
      sendAdminGift(owner, {
        kind: "foil",
        scope: "single",
        userIds: [recipient.id],
        amount: 1001,
        reason: "Too large for a Bot Owner",
        idempotency: { key: "gift-limit", digest: "limit" },
      }),
    ).rejects.toMatchObject({ code: "amount_limit" });
  });

  it("sanitises mass mentions in the gift message", async () => {
    await bootstrap();
    const owner = await strong(await ctxFor("cabinet", "owner@foilbury.local"));
    const recipient = await member(owner.tenant.id, "mention@example.com");
    const preview = await previewAdminGift(owner, {
      kind: "foil",
      scope: "single",
      userIds: [recipient.id],
      amount: 10,
      reason: "Message hygiene",
      message: "@everyone <@123456789012345678> hello",
      idempotency: { key: "gift-message", digest: "message" },
    });
    expect(preview.message).not.toContain("@everyone");
    expect(preview.message).not.toContain("<@");
  });
});

