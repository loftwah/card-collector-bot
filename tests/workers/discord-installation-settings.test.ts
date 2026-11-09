import { beforeEach, describe, expect, it } from "vitest";
import { routeApi } from "../../src/server/api/router";
import { bootstrap, ctxFor, fixturePool, runtime, walletBalance } from "./helpers";
import { executeDraw, getPoolPreview } from "../../src/server/modules/pools";
import type { Ctx } from "../../src/server/context";
import { buildContext } from "../../src/server/context";
import { createAgentGrant } from "../../src/server/modules/identity";
import { poolScopeFromDiscord, resolveDiscordScope } from "../../src/server/discord/scope";
import type { DiscordInstallation } from "../../src/server/discord/types";

async function strongSession(ctx: Ctx, assurance: 'mfa' | 'passkey' = 'mfa'): Promise<Ctx> {
  const now = new Date().toISOString(), id = `install_session_${ctx.user!.id}`;
  await runtime.DB.prepare(`INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id,`${id}_hash`,ctx.user!.id,ctx.tenant.id,'test',now,new Date(Date.now()+3600000).toISOString(),now,assurance,now).run();
  return {...ctx,sessionId:id,sessionAssurance:assurance,sessionAuthTime:now};
}

describe("Discord installation collection settings", () => {
  beforeEach(async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare(`INSERT INTO fb_discord_installations (id, tenant_id, bot_id, application_id, guild_id, guild_name, channel_allowlist_json, game_enabled, website_enabled, api_enabled, public_catalogue_enabled, admin_gui_enabled, active, created_at, updated_at)
      VALUES ('dci_editor', ?, ?, '123', '456', 'Test server', '[]', 1, 1, 1, 1, 1, 1, ?, ?)`)
      .bind(owner.tenant.id, bot!.id, new Date().toISOString(), new Date().toISOString()).run();
  });
  const patch = (revision: number, collectionIds: string[] | null) => new Request("https://foilbury.test/api/v1/studio/discord-installations/dci_editor", {
    method: "PATCH", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify({ revision, collectionIds }),
  });
  const availability = (revision:number,surface:string,enabled:boolean)=>new Request('https://foilbury.test/api/v1/studio/discord-installations/dci_editor/availability',{
    method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify({revision,surface,enabled}),
  });
  it('updates availability through a strong session with revision fencing and audit',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    await routeApi(availability(1,'game',false),owner,'studio/discord-installations/dci_editor/availability');
    expect(await runtime.DB.prepare("SELECT game_enabled,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({game_enabled:0,configuration_revision:2});
    await expect(routeApi(availability(1,'game',true),owner,'studio/discord-installations/dci_editor/availability')).rejects.toMatchObject({code:'stale_installation'});
    await routeApi(availability(2,'game',true),owner,'studio/discord-installations/dci_editor/availability');
    expect(await runtime.DB.prepare("SELECT game_enabled,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({game_enabled:1,configuration_revision:3});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='discord.installation.availability.updated'").first<{n:number}>())?.n).toBe(2);
    await expect(routeApi(availability(3,'website',false),owner,'studio/discord-installations/dci_editor/availability')).rejects.toMatchObject({status:422});
    expect((await runtime.DB.prepare("SELECT website_enabled FROM fb_discord_installations WHERE id='dci_editor'").first<{website_enabled:number}>())?.website_enabled).toBe(1);
  });
  it('guards Platform installation writes, rejects unsupported switches and preserves revision and audit',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    const request=(body:unknown)=>new Request('https://foilbury.test/api/v1/platform/installations/dci_editor',{method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify(body)});
    await expect(routeApi(request({revision:1,websiteEnabled:false}),owner,'platform/installations/dci_editor')).rejects.toMatchObject({code:'installation_surface_unavailable'});
    await expect(routeApi(request({revision:1,gameEnabled:false}),owner,'platform/installations/dci_editor/extra')).rejects.toMatchObject({status:404});
    await routeApi(request({revision:1,gameEnabled:false}),owner,'platform/installations/dci_editor');
    await expect(routeApi(request({revision:1,gameEnabled:true}),owner,'platform/installations/dci_editor')).rejects.toMatchObject({code:'stale_installation'});
    expect(await runtime.DB.prepare("SELECT game_enabled,website_enabled,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({game_enabled:0,website_enabled:1,configuration_revision:2});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='platform.installation.updated'").first<{n:number}>())?.n).toBe(1);
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare("UPDATE fb_platform_admins SET status='revoked',revoked_at=? WHERE user_id=?").bind(new Date().toISOString(),owner.user!.id).run();return target.batch(...args);};
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(routeApi(request({revision:2,gameEnabled:true}),{...owner,db},'platform/installations/dci_editor')).rejects.toMatchObject({code:'stale_installation'});
    expect(await runtime.DB.prepare("SELECT game_enabled,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({game_enabled:0,configuration_revision:2});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='platform.installation.updated'").first<{n:number}>())?.n).toBe(1);
  });
  it('does not change availability when the strong session is revoked before the batch',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),owner.sessionId).run();return target.batch(...args);};
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(routeApi(availability(1,'game',false),{...owner,db},'studio/discord-installations/dci_editor/availability')).rejects.toMatchObject({code:'strong_auth_required'});
    expect(await runtime.DB.prepare("SELECT game_enabled,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({game_enabled:1,configuration_revision:1});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='discord.installation.availability.updated'").first<{n:number}>())?.n).toBe(0);
  });
  it('rolls back a Platform installation change when its audit fails',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    await runtime.DB.prepare("CREATE TRIGGER fail_platform_install_audit BEFORE INSERT ON fb_audit_events WHEN NEW.action='platform.installation.updated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    try {
      const request=new Request('https://foilbury.test/api/v1/platform/installations/dci_editor',{method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify({revision:1,gameEnabled:false})});
      await expect(routeApi(request,owner,'platform/installations/dci_editor')).rejects.toThrow();
      expect(await runtime.DB.prepare("SELECT game_enabled,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({game_enabled:1,configuration_revision:1});
    } finally { await runtime.DB.prepare('DROP TRIGGER fail_platform_install_audit').run(); }
  });
  it('attributes a cross-Bot Platform change to the target installation tenant',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    const foreign=await ctxFor('harbour','harbour.owner@foilbury.test'),now=new Date().toISOString();
    const bot=await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(foreign.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("INSERT INTO fb_discord_installations (id,tenant_id,bot_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,website_enabled,api_enabled,public_catalogue_enabled,admin_gui_enabled,active,created_at,updated_at) VALUES ('foreign_install',?,?,'123','4567','Other server','[]',1,1,1,1,1,1,?,?)").bind(foreign.tenant.id,bot!.id,now,now).run();
    const request=new Request('https://foilbury.test/api/v1/platform/installations/foreign_install',{method:'PATCH',headers:{'content-type':'application/json','x-foilbury-csrf':'test'},body:JSON.stringify({revision:1,gameEnabled:false})});
    await routeApi(request,owner,'platform/installations/foreign_install');
    expect(await runtime.DB.prepare("SELECT tenant_id,object_id,actor_id,represented_user_id FROM fb_audit_events WHERE action='platform.installation.updated' AND object_id='foreign_install'").first()).toEqual({tenant_id:foreign.tenant.id,object_id:'foreign_install',actor_id:owner.user!.id,represented_user_id:owner.user!.id});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='platform.installation.updated' AND object_id='foreign_install' AND tenant_id=?").bind(owner.tenant.id).first<{n:number}>())?.n).toBe(0);
  });
  it('separates live settings and content authority for availability and collection controls',async()=>{
    const owner=await ctxFor('cabinet','owner@foilbury.local'),player=await ctxFor('cabinet','player@foilbury.local'),now=new Date().toISOString();
    const bot=await runtime.DB.prepare('SELECT id FROM fb_bots WHERE tenant_id=?').bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"settings\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('settings_only',?,?,'admin','[\"settings\"]','active',?)").bind(bot!.id,player.user!.id,now).run();
    const scoped=await strongSession(await ctxFor('cabinet','player@foilbury.local'));
    const response=await routeApi(new Request('https://foilbury.test/api/v1/studio/discord-installations'),scoped,'studio/discord-installations');
    const payload=await response.json() as {permissions:{canManageCollections:boolean;canManageAvailability:boolean};collections:unknown[]};
    expect(payload.permissions).toEqual({canManageCollections:false,canManageAvailability:true});
    expect(payload.collections).toEqual([]);
    await routeApi(availability(1,'game',false),scoped,'studio/discord-installations/dci_editor/availability');
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='[\"content\"]' WHERE id='settings_only'").run();
    await expect(routeApi(availability(2,'game',true),scoped,'studio/discord-installations/dci_editor/availability')).rejects.toMatchObject({code:'insufficient_role'});
    const limited=await (await routeApi(new Request('https://foilbury.test/api/v1/studio/discord-installations'),scoped,'studio/discord-installations')).json() as {permissions:{canManageCollections:boolean;canManageAvailability:boolean};installations:Array<Record<string,unknown>>};
    expect(limited.permissions).toEqual({canManageCollections:true,canManageAvailability:false});
    expect(limited.installations[0]).not.toHaveProperty('game_enabled');
    expect((await runtime.DB.prepare("SELECT game_enabled FROM fb_discord_installations WHERE id='dci_editor'").first<{game_enabled:number}>())?.game_enabled).toBe(0);
  });
  it('fences a Discord draw if gameplay is disabled after preview and preserves committed replay',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    await fixturePool(owner);
    const row=await runtime.DB.prepare("SELECT bot_id,channel_allowlist_json,collection_allowlist_json,channel_audience_json,channel_key,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first<{bot_id:string|null;channel_allowlist_json:string;collection_allowlist_json:string|null;channel_audience_json:string|null;channel_key:string|null;configuration_revision:number}>();
    const scopedInput=async()=>{
      const installation=await runtime.DB.prepare("SELECT * FROM fb_discord_installations WHERE id='dci_editor'").first<DiscordInstallation>();
      const scope=poolScopeFromDiscord(await resolveDiscordScope(owner,installation!,null));
      const preview=await getPoolPreview(owner,'test-pool',undefined,{scope});
      return {pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,scope,discordInstallation:scope.drawInstallation,authorizedReplayOnly:true,idempotency:{key:'discord-switch-draw',digest:'discord-switch-draw'}};
    };
    let input=await scopedInput();
    const before=await walletBalance(owner,owner.user!.id);
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{await target.prepare("UPDATE fb_discord_installations SET game_enabled=0 WHERE id='dci_editor'").run();return target.batch(...args);};
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(executeDraw({...owner,db},input)).rejects.toMatchObject({code:'discord_game_disabled'});
    expect(await walletBalance(owner,owner.user!.id)).toBe(before);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='discord-switch-draw'").first<{n:number}>())?.n).toBe(0);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET game_enabled=1 WHERE id='dci_editor'").run();
    for (const field of ['channel_allowlist_json','collection_allowlist_json'] as const) {
      input=await scopedInput();
      const scopedDb=new Proxy(runtime.DB,{get(target,key){
        if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{
          await target.prepare(`UPDATE fb_discord_installations SET ${field}=? WHERE id='dci_editor'`).bind(field==='channel_allowlist_json' ? '["123456789012345"]' : '[]').run();
          return target.batch(...args);
        };
        const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
      }});
      await expect(executeDraw({...owner,db:scopedDb},input)).rejects.toMatchObject({code:'stale_scope'});
      expect(await walletBalance(owner,owner.user!.id)).toBe(before);
      expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='discord-switch-draw'").first<{n:number}>())?.n).toBe(0);
      await runtime.DB.prepare(`UPDATE fb_discord_installations SET ${field}=? WHERE id='dci_editor'`).bind(field==='channel_allowlist_json' ? row!.channel_allowlist_json : row!.collection_allowlist_json).run();
    }
    input=await scopedInput();
    const committed=await executeDraw(owner,input);
    const after=await walletBalance(owner,owner.user!.id);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET game_enabled=0 WHERE id='dci_editor'").run();
    const replay=await executeDraw(owner,input);
    expect(replay).toMatchObject({replayed:true,draw_id:committed.draw_id});
    expect(await walletBalance(owner,owner.user!.id)).toBe(after);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='discord-switch-draw'").first<{n:number}>())?.n).toBe(1);
  });
  it('recovers an authorised scoped API receipt after disable without exposing it to another or revoked user',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    const player=await strongSession(await ctxFor('cabinet','player@foilbury.local'));
    await fixturePool(owner);
    const previewResponse=await routeApi(new Request('https://foilbury.test/api/v1/pools/test-pool?installation=dci_editor'),owner,'pools/test-pool');
    const preview=await previewResponse.json() as {revision:number;distribution_fingerprint:string};
    const body={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,installationId:'dci_editor'};
    const request=(key:string)=>new Request('https://foilbury.test/api/v1/draws',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key,'x-foilbury-csrf':'test'},body:JSON.stringify(body)});
    const first=await (await routeApi(request('scoped-replay-test'),owner,'draws')).json() as {draw_id:string;replayed:boolean};
    const after=await walletBalance(owner,owner.user!.id);
    expect(Number.isFinite(after)).toBe(true);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET game_enabled=0,channel_allowlist_json='[\"123456789012345\"]',collection_allowlist_json='[]',configuration_revision=configuration_revision+1 WHERE id='dci_editor'").run();
    const replay=await (await routeApi(request('scoped-replay-test'),owner,'draws')).json() as {draw_id:string;replayed:boolean};
    expect(replay).toMatchObject({draw_id:first.draw_id,replayed:true});
    await expect(routeApi(request('scoped-replay-test'),player,'draws')).rejects.toMatchObject({code:'discord_game_disabled'});
    await expect(routeApi(request('scoped-new-draw'),owner,'draws')).rejects.toMatchObject({code:'discord_game_disabled'});
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),owner.sessionId).run();
    await expect(routeApi(request('scoped-replay-test'),owner,'draws')).rejects.toMatchObject({code:'discord_game_disabled'});
    expect(await walletBalance(owner,owner.user!.id)).toBe(after);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='scoped-replay-test'").first<{n:number}>())?.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND amount=-80").bind(first.draw_id).first<{n:number}>())?.n).toBe(1);
  });
  it('returns the competing same-key receipt when an API draw commits just before gameplay is paused',async()=>{
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    await fixturePool(owner);
    const preview=await (await routeApi(new Request('https://foilbury.test/api/v1/pools/test-pool?installation=dci_editor'),owner,'pools/test-pool')).json() as {revision:number;distribution_fingerprint:string};
    const body={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,installationId:'dci_editor'};
    const request=()=>new Request('https://foilbury.test/api/v1/draws',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'competing-api-draw','x-foilbury-csrf':'test'},body:JSON.stringify(body)});
    let fired=false, winner: {draw_id:string}|null=null;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{
        if(!fired){fired=true;winner=await (await routeApi(request(),owner,'draws')).json() as {draw_id:string};await target.prepare("UPDATE fb_discord_installations SET game_enabled=0 WHERE id='dci_editor'").run();}
        return target.batch(...args);
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    const result=await (await routeApi(request(),{...owner,db},'draws')).json() as {draw_id:string;replayed:boolean};
    expect(result).toMatchObject({draw_id:winner!.draw_id,replayed:true});
    const after=await walletBalance(owner,owner.user!.id);
    expect(Number.isFinite(after)).toBe(true);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key='competing-api-draw'").first<{n:number}>())?.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='draw' AND reference_id=? AND amount=-80").bind(result.draw_id).first<{n:number}>())?.n).toBe(1);
  });
  it('fences scoped API draws against session, membership and delegated grant revocation at commit', async () => {
    const owner=await strongSession(await ctxFor('cabinet','owner@foilbury.local'));
    await fixturePool(owner);
    const grant=await createAgentGrant(owner,{agentName:'draw-agent',representedUserId:owner.user!.id,scopes:['draw:execute','inventory:read'],expiresInDays:1});
    const agentRequest=new Request('https://foilbury.test/api/v1/draws',{headers:{authorization:`Bearer ${grant.token}`}});
    const agent=await buildContext(agentRequest);
    const preview=await (await routeApi(new Request('https://foilbury.test/api/v1/pools/test-pool?installation=dci_editor'),owner,'pools/test-pool')).json() as {revision:number;distribution_fingerprint:string};
    const body={pool:'test-pool',expectedRevision:preview.revision,expectedDistribution:preview.distribution_fingerprint,installationId:'dci_editor'};
    const before=await walletBalance(owner,owner.user!.id);
    for (const mode of ['session','membership','grant'] as const) {
      const ctx=mode==='grant'?agent:owner;
      const request=new Request('https://foilbury.test/api/v1/draws',{method:'POST',headers:{'content-type':'application/json','idempotency-key':`auth-race-${mode}`,'x-foilbury-csrf':'test',...(mode==='grant'?{authorization:`Bearer ${grant.token}`}:{})},body:JSON.stringify(body)});
      const db=new Proxy(runtime.DB,{get(target,key){
        if(key==='batch') return async(...args:Parameters<typeof target.batch>)=>{
          if(mode==='session') await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),owner.sessionId).run();
          if(mode==='membership') await target.prepare("UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,owner.user!.id).run();
          if(mode==='grant') await target.prepare("UPDATE fb_agent_grants SET status='revoked' WHERE id=?").bind(grant.grantId).run();
          return target.batch(...args);
        };
        const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
      }});
      await expect(routeApi(request,{...ctx,db},'draws')).rejects.toMatchObject({code:'draw_authority_changed'});
      expect(await walletBalance(owner,owner.user!.id)).toBe(before);
      expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_draws WHERE idempotency_key=?').bind(`auth-race-${mode}`).first<{n:number}>())?.n).toBe(0);
      if(mode==='session') await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=NULL WHERE id=?').bind(owner.sessionId).run();
      if(mode==='membership') await runtime.DB.prepare("UPDATE fb_memberships SET status='active' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,owner.user!.id).run();
    }
  });
  it("saves an explicit empty selection, rejects stale writes, then restores inheritance", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const strong = await strongSession(owner, "passkey");
    const read = await routeApi(new Request("https://foilbury.test/api/v1/studio/discord-installations"), owner, "studio/discord-installations");
    const payload = await read.json() as { installations: Array<{ configuration_revision: number; collection_allowlist_json: string | null }> };
    const revision = payload.installations[0].configuration_revision;
    expect(payload.installations[0].collection_allowlist_json).toBeNull();
    await routeApi(patch(revision, []), strong, "studio/discord-installations/dci_editor");
    await expect(routeApi(patch(revision, null), strong, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 409, code: "stale_installation" });
    let row = await runtime.DB.prepare("SELECT collection_allowlist_json FROM fb_discord_installations WHERE id = 'dci_editor'").first<{ collection_allowlist_json: string | null }>();
    expect(row?.collection_allowlist_json).toBe("[]");
    const emptyRead=await (await routeApi(new Request("https://foilbury.test/api/v1/studio/discord-installations"),owner,"studio/discord-installations")).json() as {installations:Array<{selection_state:string;collection_allowlist_json:string|null}>};
    expect(emptyRead.installations[0]).toMatchObject({selection_state:'available',collection_allowlist_json:'[]'});
    await routeApi(patch(revision + 1, null), strong, "studio/discord-installations/dci_editor");
    row = await runtime.DB.prepare("SELECT collection_allowlist_json FROM fb_discord_installations WHERE id = 'dci_editor'").first<{ collection_allowlist_json: string | null }>();
    expect(row?.collection_allowlist_json).toBeNull();
    const inheritedRead=await (await routeApi(new Request("https://foilbury.test/api/v1/studio/discord-installations"),owner,"studio/discord-installations")).json() as {installations:Array<{selection_state:string;collection_allowlist_json:string|null}>};
    expect(inheritedRead.installations[0]).toMatchObject({selection_state:'available',collection_allowlist_json:null});
    const count = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_audit_events WHERE action = 'discord.installation.collections.updated'").first<{ count: number }>();
    expect(count?.count).toBe(2);
  });
  it("rejects players, stale authentication and unknown collection ids", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await expect(routeApi(patch(1, []), player, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await expect(routeApi(patch(1, []), owner, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    const strong = await strongSession(owner, "passkey");
    await expect(routeApi(patch(1, ["another-bot-private-collection"]), strong, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 400, code: "invalid_collection" });
  });
  it("limits a scoped content admin to their own Bot and saves valid selections", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const harbour = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const response = await routeApi(new Request("https://foilbury.test/api/v1/studio/discord-installations"), owner, "studio/discord-installations");
    const payload = await response.json() as { collections: Array<{ id: string }> };
    expect(payload.collections.length).toBeGreaterThan(0);
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at) VALUES ('test_admin', ?, ?, 'admin', '[\"content\"]', 'active', ?)").bind(bot!.id, player.user!.id, new Date().toISOString()).run();
    const scoped = await strongSession(await ctxFor("cabinet", "player@foilbury.local"));
    await routeApi(patch(1, [payload.collections[0].id]), scoped, "studio/discord-installations/dci_editor");
    const saved = await runtime.DB.prepare("SELECT collection_allowlist_json FROM fb_discord_installations WHERE id = 'dci_editor'").first<{ collection_allowlist_json: string }>();
    expect(JSON.parse(saved!.collection_allowlist_json)).toEqual([payload.collections[0].id]);
    const foreign = { ...harbour, sessionAssurance: "mfa", sessionAuthTime: new Date().toISOString() };
    await expect(routeApi(patch(2, []), foreign, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 404 });
    // Use the still-valid request context after a real capability revocation.
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json = '[\"economy\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"economy\"]' WHERE id = 'test_admin'").run();
    await expect(routeApi(patch(2, []), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    await expect(routeApi(new Request("https://foilbury.test/api/v1/studio/discord-installations"), scoped, "studio/discord-installations")).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    const after = await runtime.DB.prepare("SELECT collection_allowlist_json, configuration_revision FROM fb_discord_installations WHERE id = 'dci_editor'").first<{ collection_allowlist_json: string; configuration_revision: number }>();
    expect(after?.collection_allowlist_json).toBe(saved?.collection_allowlist_json);
    expect(after?.configuration_revision).toBe(2);
  });
  it("fences a revocation that occurs after the request check and before the write", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at) VALUES ('test_admin', ?, ?, 'admin', '[\"content\"]', 'active', ?)").bind(bot!.id, player.user!.id, new Date().toISOString()).run();
    const scoped = await strongSession(await ctxFor("cabinet", "player@foilbury.local"));
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_bot_admins SET status = 'revoked' WHERE id = 'test_admin'").run();
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(routeApi(patch(1, []), { ...scoped, db }, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    const row = await runtime.DB.prepare("SELECT collection_allowlist_json, configuration_revision FROM fb_discord_installations WHERE id = 'dci_editor'").first<{ collection_allowlist_json: string | null; configuration_revision: number }>();
    expect(row).toMatchObject({ collection_allowlist_json: null, configuration_revision: 1 });
    const audit = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_audit_events WHERE action = 'discord.installation.collections.updated'").first<{ count: number }>();
    expect(audit?.count).toBe(0);
  });
  it("fences a collection viewer grant revoked between selection and the write", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const foreign = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const now = new Date().toISOString();
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id=?").bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor', capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('race_admin',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id,player.user!.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('race_collection','race-collection','Shared private','test','global',?,'brass','published','private',?,?,?)").bind(foreign.tenant.id,owner.user!.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('race_collection',?,?,?)").bind(player.user!.id,owner.user!.id,now).run();
    const scoped = await strongSession(await ctxFor("cabinet", "player@foilbury.local"));
    const readDb = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'prepare') return (sql:string) => {
        const stmt=target.prepare(sql);
        if (!sql.includes('SELECT picked.id')) return stmt;
        return new Proxy(stmt,{get(inner,method) {
          if (method === 'bind') return (...values:unknown[]) => {
            const bound=inner.bind(...values);
            return new Proxy(bound,{get(result,operation) {
              if (operation === 'all') return async () => {
                await target.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='race_collection' AND user_id=?").bind(now,player.user!.id).run();
                return result.all();
              };
              const v=Reflect.get(result,operation,result);return typeof v==='function'?v.bind(result):v;
            }});
          };
          const v=Reflect.get(inner,method,inner);return typeof v==='function'?v.bind(inner):v;
        }});
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const read = await routeApi(new Request('https://foilbury.test/api/v1/studio/discord-installations'),{...scoped,db:readDb},'studio/discord-installations');
    expect((await read.json() as {collections:Array<{id:string}>}).collections.some(c=>c.id==='race_collection')).toBe(false);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json=? WHERE id='dci_editor'").bind(JSON.stringify(['race_collection'])).run();
    const hidden=await routeApi(new Request('https://foilbury.test/api/v1/studio/discord-installations'),scoped,'studio/discord-installations');
    const hiddenJson=await hidden.json() as {installations:Array<{collection_allowlist_json:string|null;selection_state:string}>};
    expect(hiddenJson.installations[0]).toMatchObject({collection_allowlist_json:null,selection_state:'unavailable'});
    expect(JSON.stringify(hiddenJson)).not.toContain('race_collection');
    expect((await runtime.DB.prepare("SELECT collection_allowlist_json FROM fb_discord_installations WHERE id='dci_editor'").first<{collection_allowlist_json:string}>())?.collection_allowlist_json).toBe('["race_collection"]');
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json=NULL WHERE id='dci_editor'").run();
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='race_collection' AND user_id=?").bind(player.user!.id).run();
    const db = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='race_collection' AND user_id=?").bind(now,player.user!.id).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(routeApi(patch(1,['race_collection']),{...scoped,db},'studio/discord-installations/dci_editor')).rejects.toMatchObject({status:409,code:'stale_installation'});
    expect(await runtime.DB.prepare("SELECT collection_allowlist_json,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({collection_allowlist_json:null,configuration_revision:1});
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='discord.installation.collections.updated'").first<{n:number}>())?.n).toBe(0);
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='race_collection' AND user_id=?").bind(player.user!.id).run();
    const archiveDb = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_collections SET status='archived' WHERE id='race_collection'").run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(routeApi(patch(1,['race_collection']),{...scoped,db:archiveDb},'studio/discord-installations/dci_editor')).rejects.toMatchObject({status:409,code:'stale_installation'});
    expect(await runtime.DB.prepare("SELECT collection_allowlist_json,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({collection_allowlist_json:null,configuration_revision:1});
    await runtime.DB.prepare("UPDATE fb_collections SET status='published' WHERE id='race_collection'").run();
    await runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id='race_collection'").run();
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id,user_id,role,scopes_json,status,granted_by,granted_at,reason) VALUES ('race_scope',?,'global_collection_admin',?,'active',?,?,'test')").bind(player.user!.id,JSON.stringify({all:false,collectionIds:['race_collection']}),owner.user!.id,now).run();
    const roleDb = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_platform_role_assignments SET status='revoked',revoked_at=? WHERE id='race_scope'").bind(now).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(routeApi(patch(1,['race_collection']),{...scoped,db:roleDb},'studio/discord-installations/dci_editor')).rejects.toMatchObject({status:409,code:'stale_installation'});
    expect(await runtime.DB.prepare("SELECT collection_allowlist_json,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({collection_allowlist_json:null,configuration_revision:1});
  });
  it("checks the actual session and membership revocation on every save", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare(`INSERT INTO fb_sessions (id, token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at, assurance, auth_time)
      VALUES ('editor_session', 'editor_token_hash', ?, ?, 'test', ?, ?, ?, 'passkey', ?)`)
      .bind(owner.user!.id, owner.tenant.id, now, new Date(Date.now() + 60_000).toISOString(), now, now).run();
    const scoped = { ...owner, sessionId: "editor_session", sessionAssurance: "passkey", sessionAuthTime: now };
    await routeApi(patch(1, []), scoped, "studio/discord-installations/dci_editor");
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at = ? WHERE id = 'editor_session'").bind(now).run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at = NULL, expires_at = ? WHERE id = 'editor_session'").bind(new Date(Date.now() - 60_000).toISOString()).run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_sessions SET expires_at = ? WHERE id = 'editor_session'").bind(new Date(Date.now() + 60_000).toISOString()).run();
    await runtime.DB.prepare("UPDATE fb_memberships SET revoked_at = ? WHERE tenant_id = ? AND user_id = ?").bind(now, owner.tenant.id, owner.user!.id).run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
  });
  it("requires a bound strong session and fences its downgrade at commit", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString();
    await expect(routeApi(patch(1,[]),{...owner,sessionAssurance:'mfa',sessionAuthTime:now},'studio/discord-installations/dci_editor')).rejects.toMatchObject({code:'strong_auth_required'});
    const strong = await strongSession(owner);
    const access = {...strong,sessionAssurance:'access',accessStatus:'linked' as const,accessIdentity:{subject:'fixture',email:owner.user!.email,audience:'fixture',payload:{exp:Math.floor(Date.now()/1000)+3600}}};
    await expect(routeApi(patch(1,[]),access,'studio/discord-installations/dci_editor')).rejects.toMatchObject({code:'strong_auth_required'});
    const db = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_sessions SET assurance='email' WHERE id=?").bind(strong.sessionId).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(routeApi(patch(1,[]),{...strong,db},'studio/discord-installations/dci_editor')).rejects.toMatchObject({code:'strong_auth_required'});
    await runtime.DB.prepare("UPDATE fb_sessions SET assurance='mfa',auth_time=? WHERE id=?").bind(now,strong.sessionId).run();
    const staleDb = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_sessions SET auth_time='2000-01-01T00:00:00.000Z' WHERE id=?").bind(strong.sessionId).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(routeApi(patch(1,[]),{...strong,db:staleDb},'studio/discord-installations/dci_editor')).rejects.toMatchObject({code:'strong_auth_required'});
    expect(await runtime.DB.prepare("SELECT collection_allowlist_json,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({collection_allowlist_json:null,configuration_revision:1});
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='discord.installation.collections.updated'").first<{n:number}>())?.n).toBe(0);
  });
  it("fences Bot ownership transfer even if the former owner retains content capabilities", async () => {
    const owner = await ctxFor('cabinet','owner@foilbury.local');
    const player = await ctxFor('cabinet','player@foilbury.local');
    await runtime.DB.prepare("UPDATE fb_users SET platform_admin=0 WHERE id=?").bind(owner.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,owner.user!.id).run();
    const strong=await strongSession(owner);
    const db=new Proxy(runtime.DB,{get(target,key) {
      if(key==='batch') return async (...args:Parameters<typeof target.batch>)=>{
        await target.prepare("UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?").bind(player.user!.id,owner.tenant.id).run();
        return target.batch(...args);
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(routeApi(patch(1,[]),{...strong,db},'studio/discord-installations/dci_editor')).rejects.toMatchObject({status:403,code:'insufficient_role'});
    expect(await runtime.DB.prepare("SELECT collection_allowlist_json,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({collection_allowlist_json:null,configuration_revision:1});
  });
  it("requires current content capability and respects explicit Bot Admin revocation", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role = 'editor', capabilities_json = '[]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    const scoped = await strongSession(await ctxFor("cabinet", "player@foilbury.local"));
    await expect(routeApi(patch(1, []), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    const db = new Proxy(runtime.DB, { get(target,key) {
      if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_memberships SET capabilities_json='[\"economy\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(routeApi(patch(1, []), {...scoped,db}, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await routeApi(patch(1, []), scoped, "studio/discord-installations/dci_editor");
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at, revoked_at) VALUES ('test_revoked', ?, ?, 'admin', '[\"content\"]', 'revoked', ?, ?)").bind(bot!.id, player.user!.id, new Date().toISOString(), new Date().toISOString()).run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status = 'active' WHERE id = 'test_revoked'").run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_bot_admins SET revoked_at = NULL WHERE id = 'test_revoked'").run();
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, player.user!.id).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET role='owner' WHERE id='test_revoked'").run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("UPDATE fb_bot_admins SET role='admin' WHERE id='test_revoked'").run();
    await runtime.DB.prepare("UPDATE fb_users SET disabled_at = ? WHERE id = ?").bind(new Date().toISOString(), player.user!.id).run();
    await expect(routeApi(patch(2, null), scoped, "studio/discord-installations/dci_editor")).rejects.toMatchObject({ status: 403 });
  });
  it("rolls back the settings write if its audit insert fails", async () => {
    const owner = await strongSession(await ctxFor("cabinet", "owner@foilbury.local"));
    await runtime.DB.prepare("CREATE TRIGGER fail_install_audit BEFORE INSERT ON fb_audit_events WHEN NEW.action='discord.installation.collections.updated' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    try {
      await expect(routeApi(patch(1,[]),owner,'studio/discord-installations/dci_editor')).rejects.toThrow();
      expect(await runtime.DB.prepare("SELECT collection_allowlist_json,configuration_revision FROM fb_discord_installations WHERE id='dci_editor'").first()).toEqual({collection_allowlist_json:null,configuration_revision:1});
    } finally {
      await runtime.DB.prepare("DROP TRIGGER fail_install_audit").run();
    }
  });
  it("binds delegated reads to the exact live token, grant and tenant", async () => {
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const a=await createAgentGrant(owner,{agentName:'reader-a',representedUserId:owner.user!.id,scopes:['content:read'],expiresInDays:1});
    const b=await createAgentGrant(owner,{agentName:'reader-b',representedUserId:owner.user!.id,scopes:['content:read'],expiresInDays:1});
    await runtime.DB.prepare("UPDATE fb_agent_grants SET agent_id=(SELECT agent_id FROM fb_agent_grants WHERE id=?) WHERE id=?").bind(a.grantId,b.grantId).run();
    const request=(token:string)=>new Request('https://foilbury.test/api/v1/admin/discord-installations',{headers:{authorization:`Bearer ${token}`}});
    const ctxA=await buildContext(request(a.token)), ctxB=await buildContext(request(b.token));
    expect(ctxA.agentCredential?.grantId).toBe(a.grantId);
    expect(ctxB.agentCredential?.grantId).toBe(b.grantId);
    expect((await (await routeApi(request(a.token),ctxA,'admin/discord-installations')).json() as {installations:unknown[]}).installations).toHaveLength(1);
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json='[\"foreign-private-secret\"]' WHERE id='dci_editor'").run();
    const limited=await (await routeApi(request(a.token),ctxA,'admin/discord-installations')).json() as {installations:Array<{selection_state:string;collection_allowlist_json:string|null}>};
    expect(limited.installations[0]).toMatchObject({selection_state:'unavailable',collection_allowlist_json:null});
    expect(JSON.stringify(limited)).not.toContain('foreign-private-secret');
    await runtime.DB.prepare("UPDATE fb_discord_installations SET collection_allowlist_json=NULL WHERE id='dci_editor'").run();
    await expect(routeApi(request(a.token),{...ctxA,agentCredential:{grantId:a.grantId,tokenId:ctxB.agentCredential!.tokenId}},'admin/discord-installations')).rejects.toMatchObject({status:403});
    const foreign=await ctxFor('harbour','harbour.owner@foilbury.test');
    await expect(routeApi(request(a.token),{...ctxA,tenant:foreign.tenant},'admin/discord-installations')).rejects.toMatchObject({status:403});
    await runtime.DB.prepare("UPDATE fb_agent_tokens SET revoked_at=? WHERE id=?").bind(new Date().toISOString(),ctxA.agentCredential!.tokenId).run();
    await expect(routeApi(request(a.token),ctxA,'admin/discord-installations')).rejects.toMatchObject({status:403});
    expect((await (await routeApi(request(b.token),ctxB,'admin/discord-installations')).json() as {installations:unknown[]}).installations).toHaveLength(1);
    const revokedDuringRead = new Proxy(runtime.DB,{get(target,key) {
      if (key==='prepare') return (sql:string) => {
        const stmt=target.prepare(sql); if (!sql.includes('SELECT picked.id')) return stmt;
        return new Proxy(stmt,{get(inner,method) {
          if(method==='bind') return (...values:unknown[]) => {
            const bound=inner.bind(...values);
            return new Proxy(bound,{get(result,operation) {
              if(operation==='all') return async()=>{await target.prepare("UPDATE fb_agent_grants SET status='revoked' WHERE id=?").bind(b.grantId).run();return result.all();};
              const v=Reflect.get(result,operation,result);return typeof v==='function'?v.bind(result):v;
            }});
          };
          const v=Reflect.get(inner,method,inner);return typeof v==='function'?v.bind(inner):v;
        }});
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(routeApi(request(b.token),{...ctxB,db:revokedDuringRead},'admin/discord-installations')).rejects.toMatchObject({status:403});
  });
  it("does not return a multi-query read when authority is revoked during loading", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const db = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SELECT picked.id")) return statement;
        return new Proxy(statement, { get(stmt, operation) {
          if (operation === "bind") return (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return new Proxy(bound, { get(inner, method) {
              if (method === "all") return async () => {
                await target.prepare("UPDATE fb_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?").bind(owner.tenant.id, owner.user!.id).run();
                return inner.all();
              };
              const value = Reflect.get(inner, method, inner);
              return typeof value === "function" ? value.bind(inner) : value;
            } });
          };
          const value = Reflect.get(stmt, operation, stmt);
          return typeof value === "function" ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(routeApi(new Request("https://foilbury.test/api/v1/studio/discord-installations"), { ...owner, db }, "studio/discord-installations")).rejects.toMatchObject({ status: 403 });
  });
});
