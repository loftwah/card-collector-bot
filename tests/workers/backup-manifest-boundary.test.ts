import {describe,it,expect} from 'vitest';
import {bootstrap,ctxFor,fixturePool,makeInstance,runtime} from './helpers';
import {backupManifest} from '../../src/server/modules/economy';
import {visibleOwnerInventorySummary} from '../../src/server/modules/collection';
import {createAgentGrant} from '../../src/server/modules/identity';
import {resolveAgent} from '../../src/server/context';
import {routeApi} from '../../src/server/api/router';
import {nowIso} from '../../src/server/db';

async function session(ctx:Awaited<ReturnType<typeof ctxFor>>) {const now=nowIso(),id=`backup-${crypto.randomUUID()}`;await runtime.DB.prepare("INSERT INTO fb_sessions(id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};}
describe('full backup manifest authority',()=>{
 it('preserves exact asset counts for the Super Admin and denies non-platform Bot Owners, scoped editors and agents',async()=>{
  await bootstrap();const owner=await session(await ctxFor('cabinet','owner@foilbury.local')),fixture=await fixturePool(owner);
  await runtime.DB.prepare("UPDATE fb_assets SET r2_key='collection-brand-v1/test/private' WHERE id=?").bind(fixture.subjectAsset).run();
  const actual=await runtime.DB.prepare('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM fb_assets WHERE tenant_id=?').bind(owner.tenant.id).first<{n:number;bytes:number}>();
  const result=await backupManifest(owner);expect(result.counts.assets).toBe(actual!.n);expect(result.counts.assetBytes).toBe(actual!.bytes);
  const player=await session(await ctxFor('cabinet','player@foilbury.local'));
  await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\",\"economy\"]' WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,player.user!.id).run();
  const editor={...player,user:{...player.user!,role:'editor' as const,capabilities:['content','economy']}};
  await expect(backupManifest(editor)).rejects.toMatchObject({code:'backup_access_changed'});
  const agent={...owner,actor:{type:'agent' as const,id:'agent',representedUserId:owner.user!.id,label:'Agent'}};
  await expect(backupManifest(agent)).rejects.toMatchObject({code:'backup_access_changed'});
  const otherOwner=await session(await ctxFor('harbour','harbour.owner@foilbury.test'));
  await expect(backupManifest(otherOwner)).rejects.toMatchObject({code:'backup_access_changed'});
  const now=nowIso();
  await runtime.DB.prepare("INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,status,view_audience,created_by,created_at,updated_at) VALUES('backup-private','backup-private','Private','bot',?,'published','private',?,?,?)").bind(otherOwner.tenant.id,otherOwner.user!.id,now,now).run();
  await runtime.DB.prepare("INSERT INTO fb_collection_cards(collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES('backup-private',?,?,0,?,?)").bind(fixture.cardId,otherOwner.tenant.id,otherOwner.user!.id,now).run();
  await runtime.DB.prepare("UPDATE fb_memberships SET role='owner' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
  await runtime.DB.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(player.user!.id,owner.tenant.id).run();
  const botOwner={...editor,user:{...editor.user!,role:'owner' as const}};
  await expect(backupManifest(botOwner)).rejects.toMatchObject({code:'backup_access_changed'});
  await makeInstance(botOwner,botOwner.user!.id,fixture);
  const hidden=await visibleOwnerInventorySummary(botOwner);expect(hidden).toMatchObject({scope:'visible_owned_inventory',complete:false,visibleCopies:0});expect(hidden.exclusions).toContain('not a backup');
  await runtime.DB.prepare("INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES ('backup-private',?,?,?)").bind(botOwner.user!.id,otherOwner.user!.id,now).run();
  expect((await visibleOwnerInventorySummary(botOwner)).visibleCopies).toBe(0);
  await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id='backup-private' AND card_id=?").bind(fixture.cardId).run();
  expect((await visibleOwnerInventorySummary(botOwner)).visibleCopies).toBe(1);
  const grant=await createAgentGrant(botOwner,{agentName:'Owner summary',representedUserId:botOwner.user!.id,scopes:['inventory:read'],expiresInDays:1});
  const resolved=await resolveAgent(runtime.DB,botOwner.config,grant.token,botOwner.tenant);
  const agentOwner={...botOwner,...resolved,agentCredential:resolved.credential};
  expect((await visibleOwnerInventorySummary(agentOwner)).visibleCopies).toBe(1);
  const summaryResponse=await routeApi(new Request('http://localhost/api/v1/admin/backup/visible-summary'),agentOwner,'admin/backup/visible-summary');
  expect(await summaryResponse.json()).toMatchObject({scope:'visible_owned_inventory',complete:false,visibleCopies:1});
  await runtime.DB.prepare("INSERT INTO fb_collection_cards(collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES('backup-private',?,?,0,?,?)").bind(fixture.cardId,otherOwner.tenant.id,otherOwner.user!.id,now).run();
  expect((await visibleOwnerInventorySummary(agentOwner)).visibleCopies).toBe(0);
  await runtime.DB.prepare('UPDATE fb_agent_tokens SET revoked_at=? WHERE id=?').bind(nowIso(),agentOwner.agentCredential!.tokenId).run();
  await expect(visibleOwnerInventorySummary(agentOwner)).rejects.toMatchObject({code:'inventory_access_changed'});
 });
 it('returns no aggregate if the exact session is revoked immediately before the snapshot',async()=>{
  await bootstrap();const owner=await session(await ctxFor('cabinet','owner@foilbury.local'));let injected=false;
  const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes('backup:manifest'))return statement;return new Proxy(statement,{get(targetStatement,key){if(key==='bind')return (...args:unknown[])=>{const bound=targetStatement.bind(...args);return new Proxy(bound,{get(boundStatement,method){if(method==='first')return async (...args2:[])=>{if(!injected){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),owner.sessionId).run();}return boundStatement.first(...args2);};const value=Reflect.get(boundStatement,method,boundStatement);return typeof value==='function'?value.bind(boundStatement):value;}});};const value=Reflect.get(targetStatement,key,targetStatement);return typeof value==='function'?value.bind(targetStatement):value;}});};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
  await expect(backupManifest({...owner,db})).rejects.toMatchObject({code:'backup_access_changed'});
 });
 it('does not return a visible-owner summary after ownership changes in flight',async()=>{
  await bootstrap();const owner=await session(await ctxFor('cabinet','owner@foilbury.local')),player=await ctxFor('cabinet','player@foilbury.local');let injected=false;
  const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes('owner:visible-summary'))return statement;return new Proxy(statement,{get(targetStatement,key){if(key==='bind')return (...args:unknown[])=>{const bound=targetStatement.bind(...args);return new Proxy(bound,{get(boundStatement,method){if(method==='first')return async (...args2:[])=>{if(!injected){injected=true;await target.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(player.user!.id,owner.tenant.id).run();}return boundStatement.first(...args2);};const value=Reflect.get(boundStatement,method,boundStatement);return typeof value==='function'?value.bind(boundStatement):value;}});};const value=Reflect.get(targetStatement,key,targetStatement);return typeof value==='function'?value.bind(targetStatement):value;}});};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
  await expect(visibleOwnerInventorySummary({...owner,db})).rejects.toMatchObject({code:'inventory_owner_changed'});
 });
});
