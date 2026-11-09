import { describe, expect, it } from 'vitest';
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from './helpers';
import { countInventory, getInstance, getInventory } from '../../src/server/modules/collection';

describe('card detail history and draw reads', () => {
  it('keeps authorization first and measures the independent detail reads', async () => {
    await bootstrap();
    const rawOwner=await ctxFor('cabinet','owner@foilbury.local');
    const now=new Date().toISOString(),session='detail-session';
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(session,session,rawOwner.user!.id,rawOwner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const owner={...rawOwner,sessionId:session,sessionAssurance:'passkey',sessionAuthTime:now};
    const fixture=await fixturePool(owner);
    const instance=await makeInstance(owner,owner.user!.id,fixture,'DETAIL-WATERFALL');
    let active=0,maxActive=0,reads=0,failHistory=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const prepared=target.prepare(sql);
        if(!sql.includes('FROM fb_instance_history') && !sql.includes('FROM fb_draws')) return prepared;
        return new Proxy(prepared,{get(statement,method){
          if(method==='bind') return (...args:unknown[])=>{
            const bound=statement.bind(...args);
            return new Proxy(bound,{get(inner,operation){
              if(operation==='all') return async()=>{reads++;active++;maxActive=Math.max(maxActive,active);try{await new Promise(resolve=>setTimeout(resolve,20));if(failHistory && sql.includes('FROM fb_instance_history')) throw new Error('fixture history failure');return await inner.all();}finally{active--;}};
              const value=Reflect.get(inner,operation,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(statement,method,statement);return typeof value==='function'?value.bind(statement):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const durations:number[]=[];
    for(let n=0;n<12;n++){
      const start=performance.now();const result=await getInstance({...owner,db},instance);
      durations.push(performance.now()-start);
      expect(result.instance.id).toBe(instance);expect(result.history).toEqual([]);expect(result.draws).toEqual([]);
    }
    durations.sort((a,b)=>a-b);
    console.log(`card-detail synthetic 20ms/read p50=${durations[6]!.toFixed(1)}ms p95=${durations[11]!.toFixed(1)}ms reads=${reads} max-in-flight=${maxActive}`);
    expect(reads).toBe(24);expect(maxActive).toBe(2);
    await expect(getInstance({...owner,db},'missing-card')).rejects.toMatchObject({code:'instance_not_found'});
    expect(reads).toBe(24);
    failHistory=true;
    await expect(getInstance({...owner,db},instance)).rejects.toThrow('fixture history failure');
    expect(reads).toBe(26);
    failHistory=false;
    await runtime.DB.prepare("INSERT INTO fb_instance_history (id,tenant_id,instance_id,event,created_at) VALUES ('detail-order-a',?,?,'gifted','2026-01-01T00:00:00.000Z'),('detail-order-b',?,?,'locked','2026-01-02T00:00:00.000Z')").bind(owner.tenant.id,instance,owner.tenant.id,instance).run();
    expect((await getInstance({...owner,db},instance)).history.map((row)=>row.id)).toEqual(['detail-order-a','detail-order-b']);
  });
});

describe('card detail live authority', () => {
  it('does not use a revoked content grant to expose an owned private Bot card', async () => {
    await bootstrap();
    const { addMembership, createUser } = await import('../../src/server/modules/identity');
    const owner=await ctxFor('cabinet','owner@foilbury.local'),fixture=await fixturePool(owner),now=new Date().toISOString();
    const editor=await createUser(runtime.DB,{email:'own-private-editor@example.test',displayName:'Editor',password:'a-long-test-password'});
    await addMembership(runtime.DB,owner.tenant.id,editor.id,'editor');
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,editor.id).run();
    const bot=await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('own-content',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id,editor.id,now).run();
    await runtime.DB.prepare("UPDATE fb_collections SET scope='bot',view_audience='private' WHERE id='col_test_public'").run();
    const instance=await makeInstance(owner,editor.id,fixture,'OWN-PRIVATE');
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('own-content-session','own-content-hash',?,?,'test',?,?,?,'passkey',?)").bind(editor.id,owner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const ctx={...await ctxFor('cabinet','own-private-editor@example.test'),sessionId:'own-content-session',sessionAssurance:'passkey',sessionAuthTime:now};
    expect((await getInstance(ctx,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status='revoked',revoked_at=? WHERE id='own-content'").bind(now).run();
    await expect(getInstance(ctx,instance)).rejects.toMatchObject({code:'instance_not_found'});
    expect(await runtime.DB.prepare('SELECT id FROM fb_card_instances WHERE id=?').bind(instance).first()).toBeTruthy();
  });

  it('separates inventory authority, collection visibility, sessions and agent grants', async () => {
    await bootstrap();
    const { addMembership, createAgentGrant, createUser } = await import('../../src/server/modules/identity');
    const { buildContext } = await import('../../src/server/context');
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const target=await ctxFor('cabinet','player@foilbury.local');
    const fixture=await fixturePool(owner);
    const instance=await makeInstance(owner,target.user!.id,fixture,'DETAIL-AUTH');
    const admin=await createUser(runtime.DB,{email:'detail-admin@example.test',displayName:'Detail admin',password:'a-long-test-password'});
    await addMembership(runtime.DB,owner.tenant.id,admin.id,'editor');
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"economy\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,admin.id).run();
    const base=await ctxFor('cabinet','detail-admin@example.test');const now=new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('detail-admin-session','detail-admin-hash',?,?,'test',?,?,?,'passkey',?)").bind(admin.id,owner.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const scoped={...base,sessionId:'detail-admin-session',sessionAssurance:'passkey',sessionAuthTime:now};
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"inventory\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,admin.id).run();
    expect((await getInstance(scoped,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('detail-owner-session','detail-owner-hash',?,?,'test',?,?,?,'passkey',?)").bind(target.user!.id,target.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const owned={...target,sessionId:'detail-owner-session',sessionAssurance:'passkey',sessionAuthTime:now};
    await expect(getInstance(owned,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(target.user!.id,owner.user!.id,now).run();
    expect((await getInstance(owned,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?").bind(now,target.user!.id).run();
    await expect(getInstance(owned,instance)).rejects.toMatchObject({code:'instance_not_found'});
    expect(await runtime.DB.prepare('SELECT id FROM fb_card_instances WHERE id=?').bind(instance).first()).toBeTruthy();
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id,user_id,role,scopes_json,status,granted_by,granted_at,reason) VALUES ('detail-global',?,'global_collection_admin','{\"all\":false,\"collectionIds\":[\"col_test_public\"]}','active',?,?,'Fixture')").bind(admin.id,owner.user!.id,now).run();
    expect((await getInstance(scoped,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json='{\"all\":false,\"collectionIds\":[\"different\"]}' WHERE id='detail-global'").run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json='{\"all\":1,\"collectionIds\":[\"col_test_public\"]}' WHERE id='detail-global'").run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET status='revoked' WHERE id='detail-global'").run();
    await runtime.DB.prepare("UPDATE fb_collections SET scope='bot' WHERE id='col_test_public'").run();
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"inventory\",\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,admin.id).run();
    expect((await getInstance(scoped,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"inventory\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,admin.id).run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_collections SET scope='global' WHERE id='col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(admin.id,owner.user!.id,now).run();
    expect((await getInstance(scoped,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?").bind(now,admin.id).run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='public' WHERE id='col_test_public'").run();
    const bot=await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('detail-grant',?,?,'admin','[\"inventory\"]','active',?)").bind(bot!.id,admin.id,now).run();
    expect((await getInstance(scoped,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status='revoked',revoked_at=? WHERE id='detail-grant'").bind(now).run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status='active',revoked_at=NULL WHERE id='detail-grant'").run();
    await runtime.DB.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(now,owner.tenant.id,admin.id).run();
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("UPDATE fb_memberships SET status='active',revoked_at=NULL WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,admin.id).run();
    const unrelatedGrant=await createAgentGrant(owner,{agentName:'detail-unrelated',representedUserId:admin.id,scopes:['profile:read'],expiresInDays:1});
    const unrelatedRequest=new Request('https://foilbury.test/api/v1/instances/test',{headers:{authorization:`Bearer ${unrelatedGrant.token}`}});
    await expect(getInstance(await buildContext(unrelatedRequest),instance)).rejects.toMatchObject({code:'instance_not_found'});
    const grant=await createAgentGrant(owner,{agentName:'detail-reader',representedUserId:admin.id,scopes:['inventory:read'],expiresInDays:1});
    const request=new Request('https://foilbury.test/api/v1/instances/test',{headers:{authorization:`Bearer ${grant.token}`}});
    const agent=await buildContext(request);
    expect((await getInstance(agent,instance)).instance.id).toBe(instance);
    await runtime.DB.prepare("UPDATE fb_agent_grants SET status='revoked' WHERE id=?").bind(grant.grantId).run();
    await expect(getInstance(agent,instance)).rejects.toMatchObject({code:'instance_not_found'});
    await runtime.DB.prepare("INSERT INTO fb_instance_history (id,tenant_id,instance_id,event,created_at) VALUES ('detail-history',?,?,'drawn',?)").bind(owner.tenant.id,instance,now).run();
    let fired=false;
    const db=new Proxy(runtime.DB,{get(dbTarget,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=dbTarget.prepare(sql);
        if(!sql.includes('WHERE ci.tenant_id=? AND ci.id=?')) return statement;
        return new Proxy(statement,{get(stmt,method){
          if(method==='bind') return (...params:unknown[])=>{
            const bound=stmt.bind(...params);
            return new Proxy(bound,{get(inner,action){
              if(action==='first') return async()=>{const result=await inner.first();if(!fired){fired=true;await dbTarget.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='detail-admin-session'").bind(now).run();}return result;};
              const value=Reflect.get(inner,action,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(stmt,method,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(dbTarget,key,dbTarget);return typeof value==='function'?value.bind(dbTarget):value;
    }});
    await expect(getInstance({...scoped,db},instance)).rejects.toMatchObject({code:'instance_not_found'});
    await expect(getInstance(scoped,instance)).rejects.toMatchObject({code:'instance_not_found'});
  });
});


describe('inventory listing visibility', () => {
  it('filters mixed-audience owned rows and rejects revoked sessions and agent credentials', async () => {
    await bootstrap();
    const {createAgentGrant}=await import('../../src/server/modules/identity');
    const {buildContext}=await import('../../src/server/context');
    const owner=await ctxFor('cabinet','owner@foilbury.local'),player=await ctxFor('cabinet','player@foilbury.local');
    const fixture=await fixturePool(owner),instance=await makeInstance(owner,player.user!.id,fixture,'INVENTORY-VIEW');
    const now=new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('inventory-view-session','inventory-view-hash',?,?,'test',?,?,?,'passkey',?)").bind(player.user!.id,player.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
    const ctx={...player,sessionId:'inventory-view-session',sessionAssurance:'passkey',sessionAuthTime:now};
    expect((await getInventory(ctx)).map(row=>row.id)).toEqual([instance]);expect(await countInventory(ctx)).toBe(1);
    await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('inventory-private','inventory-private','Hidden','', 'global',?,'brass','published','private','test',?,?)").bind(owner.tenant.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('inventory-private',?,?,0,?,?)").bind(fixture.cardId,owner.tenant.id,owner.user!.id,now).run();
    expect(await getInventory(ctx)).toEqual([]);expect(await countInventory(ctx)).toBe(0);
    expect(await getInventory(ctx,{search:'Test One'})).toEqual([]);expect(await countInventory(ctx,{search:'Test One'})).toBe(0);
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('inventory-private',?,?,?)").bind(player.user!.id,owner.user!.id,now).run();
    expect((await getInventory(ctx)).map(row=>row.id)).toEqual([instance]);expect(await countInventory(ctx)).toBe(1);
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='inventory-private' AND user_id=?").bind(now,player.user!.id).run();
    expect(await getInventory(ctx)).toEqual([]);expect(await countInventory(ctx)).toBe(0);
    expect(await runtime.DB.prepare('SELECT id FROM fb_card_instances WHERE id=?').bind(instance).first()).toBeTruthy();
    const grant=await createAgentGrant(owner,{agentName:'inventory-reader',representedUserId:player.user!.id,scopes:['inventory:read'],expiresInDays:1});
    const agent=await buildContext(new Request('https://foilbury.test/api/v1/inventory',{headers:{authorization:`Bearer ${grant.token}`}}));
    expect(await getInventory(agent)).toEqual([]);
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='inventory-private' AND user_id=?").bind(player.user!.id).run();
    expect((await getInventory(agent)).map(row=>row.id)).toEqual([instance]);
    const {buildDiscordContext}=await import('../../src/server/discord/context');
    await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('inventory-discord',?,'123456789012345678',?,'fixture',?,?)").bind(player.tenant.id,player.user!.id,now,now).run();
    const discord=buildDiscordContext(runtime as never,player.tenant,player.user!,{id:'987654321098765432',application_id:'111111111111111111',type:2,token:'fixture',version:1,member:{user:{id:'123456789012345678',username:'fixture'}}});
    expect((await getInventory(discord)).map(row=>row.id)).toEqual([instance]);
    await runtime.DB.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE id='inventory-discord'").bind(now).run();
    await expect(getInventory(discord)).rejects.toMatchObject({code:'inventory_access_changed'});
    const unrelated=await createAgentGrant(owner,{agentName:'profile-only',representedUserId:player.user!.id,scopes:['profile:read'],expiresInDays:1});
    const unrelatedCtx=await buildContext(new Request('https://foilbury.test/api/v1/inventory',{headers:{authorization:`Bearer ${unrelated.token}`}}));
    await expect(getInventory(unrelatedCtx)).rejects.toMatchObject({code:'inventory_access_changed'});
    await runtime.DB.prepare("UPDATE fb_agent_grants SET status='revoked' WHERE id=?").bind(grant.grantId).run();
    await expect(getInventory(agent)).rejects.toMatchObject({code:'inventory_access_changed'});
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='inventory-view-session'").bind(now).run();
    await expect(countInventory(ctx)).rejects.toMatchObject({code:'inventory_access_changed'});
  });
});
