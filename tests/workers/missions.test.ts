import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime, setBalance, walletBalance } from "./helpers";
import { claimDailyMission, DAILY_MISSION_CATALOGUE, getDailyMissions, recordDailyInteraction, recordCollectionExploration, utcDayKey } from "../../src/server/modules/missions";
import { createNpc } from "../../src/server/modules/npcs";
import { routeApi } from "../../src/server/api/router";
import { ApiError, buildContext, resolveSession, type Ctx } from "../../src/server/context";
import { createAgentGrant, createSession } from "../../src/server/modules/identity";

async function playerContext() {
  const ctx=await ctxFor('cabinet','player@foilbury.local'),now=new Date().toISOString(),id=`mission-session-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?, 'test',?,?,?,'password',?)")
    .bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'password' as const,sessionAuthTime:now};
}

async function seedOwnedCard(player: Ctx) {
  const fixture = await fixturePool(player);
  await makeInstance(player, player.user!.id, fixture, `MISSION-${Math.random().toString(36).slice(2, 10)}`);
  return fixture;
}

function backdateEvent(userId: string, tenantId: string, eventType: string, iso: string) {
  return runtime.DB.prepare(
    `INSERT INTO fb_domain_events (id, tenant_id, user_id, event_type, object_type, object_id, dedupe_key, payload_json, created_at)
     VALUES (?, ?, ?, ?, 'test', 'test', ?, '{}', ?)`,
  )
    .bind(`evt_${Math.random().toString(36).slice(2)}`, tenantId, userId, eventType, `backdate:${eventType}:${Math.random()}`, iso)
    .run();
}

async function send(ctx: Ctx, path: string, method = "GET", body?: unknown) {
  try {
    const response = await routeApi(
      new Request(`http://localhost:5173${path}`, {
        method,
        headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      ctx,
      path.replace(/^\/api\/v1\//, ""),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: { code: error.code } } };
    throw error;
  }
}

describe("daily missions", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("does not record exploration from collection GET or repeated reads", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    expect((await send(player,'/api/v1/collections/col_test_public')).status).toBe(200);
    expect((await send(player,'/api/v1/collections/col_test_public')).status).toBe(200);
    const count=await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE tenant_id=? AND user_id=? AND event_type='collection.explored'")
      .bind(player.tenant.id,player.user!.id).first<{n:number}>();
    expect(count?.n).toBe(0);
    expect(await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).toMatchObject({status:200,body:{recorded:true}});
    expect(await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).toMatchObject({status:200,body:{already_recorded:true}});
    const yesterday=new Date(Date.now()-86400000).toISOString();
    await runtime.DB.prepare("UPDATE fb_domain_events SET created_at=?,dedupe_key=? WHERE tenant_id=? AND user_id=? AND event_type='collection.explored'")
      .bind(yesterday,`explore:${player.user!.id}:col_test_public:${yesterday.slice(0,10)}`,player.tenant.id,player.user!.id).run();
    expect(await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).toMatchObject({status:200,body:{recorded:true}});
    expect((await getDailyMissions(player)).missions.find(m=>m.key==='explore')?.progress).toBe(1);
  });

  it('does not record a world visit after session or collection access is revoked at insertion', async () => {
    const player=await playerContext();await seedOwnedCard(player);
    for(const change of ['session','audience']) {
      let injected=false;
      const db=new Proxy(runtime.DB,{get(target,key){
        if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes("INSERT OR IGNORE INTO fb_domain_events"))return statement;
          return new Proxy(statement,{get(inner,member){if(member==='bind')return (...args:unknown[])=>{const bound=inner.bind(...args);return new Proxy(bound,{get(boundStatement,method){if(method==='run')return async()=>{if(!injected){injected=true;if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();else await target.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();}return boundStatement.run();};const value=Reflect.get(boundStatement,method,boundStatement);return typeof value==='function'?value.bind(boundStatement):value;}});};const value=Reflect.get(inner,member,inner);return typeof value==='function'?value.bind(inner):value;}});};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      expect((await send({...player,db},'/api/v1/collections/col_test_public/explore','POST',{})).status).toBe(404);
      expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='collection.explored' AND user_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
      await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=NULL WHERE id=?').bind(player.sessionId).run();
      await runtime.DB.prepare("UPDATE fb_collections SET view_audience='public',public_approved_at=? WHERE id='col_test_public'").bind(new Date().toISOString()).run();
    }
  });

  it('rejects malformed membership and explicit grant capabilities for a private world', async () => {
    const player=await playerContext();await seedOwnedCard(player);
    await runtime.DB.prepare("UPDATE fb_collections SET scope='bot',owner_tenant_id=?,view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").bind(player.tenant.id).run();
    for(const capabilities of ['{"x":"content"}','["content",1]']) {
      await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json=? WHERE tenant_id=? AND user_id=?").bind(capabilities,player.tenant.id,player.user!.id).run();
      expect((await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).status).toBe(404);
    }
    await runtime.DB.prepare("UPDATE fb_memberships SET capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(player.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins(id,bot_id,user_id,role,capabilities_json,status,created_at) SELECT 'fixture_bad_cap',id,?,'admin','{\"x\":\"content\"}','active',? FROM fb_bots WHERE tenant_id=?")
      .bind(player.user!.id,new Date().toISOString(),player.tenant.id).run();
    expect((await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='[\"content\",1]' WHERE id='fixture_bad_cap'").run();
    expect((await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json='[\"content\"]' WHERE id='fixture_bad_cap'").run();
    expect((await send(player,'/api/v1/collections/col_test_public/explore','POST',{})).status).toBe(200);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='collection.explored' AND user_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(1);
  });

  it('records inspection only on explicit owned-card POST and deduplicates retries', async () => {
    const player=await playerContext();const fixture=await fixturePool(player);
    const instance=await makeInstance(player,player.user!.id,fixture,'INSPECT-FIXTURE');
    expect((await send(player,`/api/v1/instances/${instance}`)).status).toBe(200);
    expect((await send(player,`/api/v1/instances/${instance}`)).status).toBe(200);
    const count=()=>runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE tenant_id=? AND user_id=? AND event_type='card.inspected'").bind(player.tenant.id,player.user!.id).first<{n:number}>();
    expect((await count())?.n).toBe(0);
    const first=await send(player,`/api/v1/instances/${instance}/inspect`,'POST',{});
    expect(first).toMatchObject({status:200,body:{recorded:true}});
    const repeat=await send(player,`/api/v1/instances/${instance}/inspect`,'POST',{});
    expect(repeat).toMatchObject({status:200,body:{already_recorded:true}});
    expect((await count())?.n).toBe(1);
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();
    expect((await send(player,`/api/v1/instances/${instance}/inspect`,'POST',{})).status).toBe(404);
    expect((await count())?.n).toBe(1);
  });

  it('does not record card inspection when access changes before insertion', async () => {
    const player=await playerContext();const fixture=await fixturePool(player);
    const instance=await makeInstance(player,player.user!.id,fixture,'INSPECT-REVOKED');let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!sql.includes("INSERT OR IGNORE INTO fb_domain_events"))return statement;
        return new Proxy(statement,{get(inner,member){if(member==='bind')return (...args:unknown[])=>{const bound=inner.bind(...args);return new Proxy(bound,{get(boundStatement,method){if(method==='run')return async()=>{if(!injected){injected=true;await target.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();}return boundStatement.run();};const value=Reflect.get(boundStatement,method,boundStatement);return typeof value==='function'?value.bind(boundStatement):value;}});};const value=Reflect.get(inner,member,inner);return typeof value==='function'?value.bind(inner):value;}});};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect((await send({...player,db},`/api/v1/instances/${instance}/inspect`,'POST',{})).status).toBe(404);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='card.inspected' AND user_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
  });

  it('does not credit another member or a delegated agent for intentional interactions', async () => {
    const player=await playerContext();const fixture=await fixturePool(player);
    const instance=await makeInstance(player,player.user!.id,fixture,'INSPECT-OTHER');
    const ownerBase=await ctxFor('cabinet','owner@foilbury.local');
    const session=await createSession(ownerBase.db,ownerBase.tenant,ownerBase.user!,{authMethod:'magic_link',assurance:'email'});
    const owner={...ownerBase,sessionId:(await resolveSession(ownerBase.db,session.token))!.sessionId};
    expect((await send(owner,`/api/v1/instances/${instance}/inspect`,'POST',{})).status).toBe(404);
    const grant=await createAgentGrant(owner,{agentName:'Mission read agent',representedUserId:player.user!.id,scopes:['missions:read','inventory:read'],expiresInDays:1});
    const agent=await buildContext(new Request('https://foilbury.test/api/v1/missions/daily',{headers:{authorization:`Bearer ${grant.token}`}}));
    expect((await send(agent,`/api/v1/instances/${instance}/inspect`,'POST',{})).status).toBe(403);
    expect((await send(agent,'/api/v1/collections/col_test_public/explore','POST',{})).status).toBe(403);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE user_id=? AND event_type IN ('card.inspected','collection.explored')").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
  });

  it("assigns a short, stable set with real progress and reset data", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    const state = await getDailyMissions(player);
    expect(state.missions.map((mission) => mission.key)).toEqual(["explore", "inspect", "open"]);
    expect(state.cap).toBe(180);
    expect(state.day).toBe(utcDayKey());
    expect(state.reset_local).toMatch(/Melbourne|AEDT|AEST/i);
    expect(state.reset_at.endsWith("T00:00:00.000Z")).toBe(true);
    expect(state.missions.every((mission) => mission.progress === 0 && !mission.complete && !mission.claimed)).toBe(true);
  });

  it('does not merge two different first assignments when balance changes concurrently', async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    await setBalance(player,player.user!.id,0);
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;await setBalance(player,player.user!.id,350);await getDailyMissions(player);}
      return target.batch(statements);
    };const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    const state=await getDailyMissions({...player,db});
    expect(state.missions.map(m=>m.key)).toEqual(['explore','inspect','open']);
    expect(state.missions.reduce((sum,m)=>sum+m.reward,0)).toBeLessThanOrEqual(state.cap);
  });

  it('rolls back a partial first assignment and preserves earlier reward history', async () => {
    const player=await playerContext();
    await seedOwnedCard(player);
    await runtime.DB.prepare("INSERT INTO fb_reward_claims (id,tenant_id,user_id,rule_key,rule_version,period_key,amount,created_at,idempotency_key) VALUES ('old-mission',?,?,'mission:2000-01-01:explore',1,'mission:2000-01-01',0,'2000-01-01T12:00:00.000Z','old-mission')").bind(player.tenant.id,player.user!.id).run();
    await runtime.DB.exec("CREATE TRIGGER fixture_mission_failure BEFORE INSERT ON fb_mission_assignments WHEN NEW.mission_key='inspect' BEGIN SELECT RAISE(ABORT,'fixture_mission_failure'); END;");
    await expect(getDailyMissions(player)).rejects.toThrow();
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_mission_assignments WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(0);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_reward_claims WHERE id='old-mission'").first<{n:number}>())?.n).toBe(1);
    await runtime.DB.exec('DROP TRIGGER fixture_mission_failure;');
    expect((await getDailyMissions(player)).missions.map(m=>m.key)).toEqual(['explore','inspect','open']);
  });

  it('enforces the daily cap for preserved legacy over-assignment under concurrent claims', async () => {
    const player=await playerContext();
    await seedOwnedCard(player);
    const initial=await getDailyMissions(player), now=new Date().toISOString();
    const extra=DAILY_MISSION_CATALOGUE.find(m=>m.key==='favourite')!;
    await runtime.DB.prepare('INSERT INTO fb_mission_assignments (tenant_id,user_id,period_key,mission_key,version,target,reward,definition_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(player.tenant.id,player.user!.id,initial.period_key,extra.key,extra.version,extra.target,extra.reward,JSON.stringify(extra),now).run();
    for(const mission of DAILY_MISSION_CATALOGUE) await backdateEvent(player.user!.id,player.tenant.id,mission.eventTypes[0]!,now);
    const balance=await walletBalance(player,player.user!.id);
    const outcomes=await Promise.allSettled(DAILY_MISSION_CATALOGUE.map(m=>claimDailyMission(player,m.key)));
    const total=await runtime.DB.prepare("SELECT COALESCE(SUM(amount),0) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=? AND period_key=? AND rule_key LIKE 'mission:%'").bind(player.tenant.id,player.user!.id,initial.period_key).first<{n:number}>();
    expect(total!.n).toBeLessThanOrEqual(initial.cap);
    expect(await walletBalance(player,player.user!.id)).toBe(balance+total!.n);
    expect(outcomes.some(result=>result.status==='rejected' && result.reason?.code==='mission_daily_cap')).toBe(true);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_mission_assignments WHERE tenant_id=? AND user_id=? AND period_key=?').bind(player.tenant.id,player.user!.id,initial.period_key).first<{n:number}>())?.n).toBe(4);
    const refreshed=await getDailyMissions(player);
    expect(refreshed.missions.filter(m=>m.claimed).length).toBeGreaterThan(0);
    expect(refreshed.missions.filter(m=>m.claimed).every(m=>!m.claimable && !m.cap_reached)).toBe(true);
    expect(refreshed.missions.filter(m=>!m.claimed).every(m=>!m.claimable && m.cap_reached)).toBe(true);
  });

  it.each(['session','membership','agent token','agent grant'])("does not credit a mission after %s revocation at commit", async (race) => {
    const player=await playerContext();
    await seedOwnedCard(player);await recordCollectionExploration(player,'col_test_public');await getDailyMissions(player);
    let claimant:Ctx=player;
    if (race.startsWith('agent')) {
      const owner=await ctxFor('cabinet','owner@foilbury.local');
      const grant=await createAgentGrant(owner,{agentName:'Mission race',representedUserId:player.user!.id,scopes:['missions:claim'],expiresInDays:1});
      claimant=await buildContext(new Request('https://foilbury.test/api/v1/missions/daily/claim',{headers:{authorization:`Bearer ${grant.token}`}}));
    }
    const before=await walletBalance(player,player.user!.id);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;
        if(race==='session') await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();
        if(race==='membership') await target.prepare("UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?").bind(new Date().toISOString(),player.tenant.id,player.user!.id).run();
        if(race==='agent token') await target.prepare('UPDATE fb_agent_tokens SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),claimant.agentCredential!.tokenId).run();
        if(race==='agent grant') await target.prepare("UPDATE fb_agent_grants SET status='revoked',revoked_at=? WHERE id=?").bind(new Date().toISOString(),claimant.agentCredential!.grantId).run();
      } return target.batch(statements);
    };const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(claimDailyMission({...claimant,db},'explore','mission-revoke-race')).rejects.toMatchObject({code:'mission_access_changed'});
    expect(await walletBalance(player,player.user!.id)).toBe(before);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=? AND rule_key LIKE '%:explore'").bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(0);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='mission.claimed' AND represented_user_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
  });

  it('does not return an existing mission receipt after session revocation', async () => {
    const player=await playerContext();await seedOwnedCard(player);await recordCollectionExploration(player,'col_test_public');
    const before=await walletBalance(player,player.user!.id),first=await claimDailyMission(player,'explore','mission-replay');
    expect(first.replayed).toBe(false);
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();
    await expect(claimDailyMission(player,'explore','mission-replay')).rejects.toMatchObject({code:'mission_access_changed'});
    expect(await walletBalance(player,player.user!.id)).toBe(before+first.amount);
  });

  it.each(['session','agent token','agent scope','Discord identity'])("does not create an assignment after %s revocation", async (race) => {
    const player=await playerContext();await seedOwnedCard(player);let viewer:Ctx=player;
    if(race.startsWith('agent')) {
      const owner=await ctxFor('cabinet','owner@foilbury.local');
      const grant=await createAgentGrant(owner,{agentName:'Mission read race',representedUserId:player.user!.id,scopes:['missions:read'],expiresInDays:1});
      viewer=await buildContext(new Request('https://foilbury.test/api/v1/missions/daily',{headers:{authorization:`Bearer ${grant.token}`}}));
    }
    if(race==='Discord identity') {
      const now=new Date().toISOString();
      await runtime.DB.prepare("INSERT INTO fb_discord_identities (id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('mission-discord',?,'123456789012345678',?,'fixture',?,?)").bind(player.tenant.id,player.user!.id,now,now).run();
      viewer={...player,sessionId:null,sessionAssurance:null,discordPrincipal:{discordUserId:'123456789012345678'}};
    }
    let injected=false;const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;
        if(race==='session') await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();
        if(race==='agent token') await target.prepare('UPDATE fb_agent_tokens SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),viewer.agentCredential!.tokenId).run();
        if(race==='agent scope') await target.prepare("UPDATE fb_agent_grants SET scopes_json='[\"profile:read\"]' WHERE id=?").bind(viewer.agentCredential!.grantId).run();
        if(race==='Discord identity') await target.prepare("UPDATE fb_discord_identities SET revoked_at=? WHERE id='mission-discord'").bind(new Date().toISOString()).run();
      }return target.batch(statements);
    };const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(getDailyMissions({...viewer,db})).rejects.toMatchObject({code:'mission_access_changed'});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_mission_assignments WHERE tenant_id=? AND user_id=?').bind(player.tenant.id,player.user!.id).first<{n:number}>())?.n).toBe(0);
  });

  it('does not return mission progress when the session is revoked during its read', async () => {
    const player=await playerContext();await seedOwnedCard(player);await recordCollectionExploration(player,'col_test_public');await getDailyMissions(player);
    let injected=false;const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='prepare') return (sql:string)=>{
      const statement=target.prepare(sql);
      if(!sql.includes('SELECT event_type, COUNT(*)')) return statement;
      return new Proxy(statement,{get(st,key){if(key==='bind') return (...args:unknown[])=>{
        const bound=st.bind(...args);return new Proxy(bound,{get(b,method){if(method==='all') return async ()=>{if(!injected){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();}return b.all();};const value=Reflect.get(b,method,b);return typeof value==='function'?value.bind(b):value;}});
      };const value=Reflect.get(st,key,st);return typeof value==='function'?value.bind(st):value;}});
    };const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(getDailyMissions({...player,db})).rejects.toMatchObject({code:'mission_access_changed'});
    expect(injected).toBe(true);
  });

  it('reports an uncertain committed result after revocation and recovers it with a new session', async () => {
    const player=await playerContext();await seedOwnedCard(player);await recordCollectionExploration(player,'col_test_public');await getDailyMissions(player);
    const before=await walletBalance(player,player.user!.id);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
      const result=await target.batch(statements);if(!injected){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();}return result;
    };const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(claimDailyMission({...player,db},'explore','post-commit-revoke')).rejects.toMatchObject({code:'mission_receipt_unavailable',message:expect.stringContaining('may already have been credited')});
    const retry=await claimDailyMission(await playerContext(),'explore','post-commit-revoke');
    expect(retry.replayed).toBe(true);expect(await walletBalance(player,player.user!.id)).toBe(before+retry.amount);
  });

  it("does not credit an incomplete mission and does credit one completed mission exactly once", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    const before = await walletBalance(player, player.user!.id);
    await expect(claimDailyMission(player, "explore")).rejects.toMatchObject({ code: "mission_incomplete" });
    expect(await walletBalance(player, player.user!.id)).toBe(before);

    await recordCollectionExploration(player, "col_test_public");
    const ready = await getDailyMissions(player);
    const explore = ready.missions.find((mission) => mission.key === "explore")!;
    expect(explore.complete).toBe(true);
    expect(explore.claimable).toBe(true);
    const first = await claimDailyMission(player, "explore", "mission-test-1");
    expect(first.amount).toBe(60);
    expect(first.replayed).toBe(false);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 60);
    const replay = await claimDailyMission(player, "explore", "mission-test-1");
    expect(replay.replayed).toBe(true);
    expect(replay.claim_id).toBe(first.claim_id);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 60);
    const claims = await runtime.DB
      .prepare("SELECT COUNT(*) AS count FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key = ?")
      .bind(player.tenant.id, player.user!.id, `${ready.period_key}:explore`)
      .first<{ count: number }>();
    expect(claims?.count).toBe(1);
    const ledger = await runtime.DB
      .prepare("SELECT description, amount FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?")
      .bind(player.tenant.id, player.user!.id, `mission:${ready.period_key}:explore`)
      .first<{ description: string; amount: number }>();
    expect(ledger).toMatchObject({ description: "Daily mission reward", amount: 60 });
  });

  it("is safe under concurrent claims", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    await recordCollectionExploration(player, "col_test_public");
    const before = await walletBalance(player, player.user!.id);
    const results = await Promise.allSettled([
      claimDailyMission(player, "explore", "mission-race-a"),
      claimDailyMission(player, "explore", "mission-race-b"),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await walletBalance(player, player.user!.id)).toBe(before + 60);
    const claims = await runtime.DB
      .prepare("SELECT COUNT(DISTINCT rule_key || period_key) AS count FROM fb_reward_claims WHERE tenant_id = ? AND user_id = ? AND rule_key LIKE '%:explore'")
      .bind(player.tenant.id, player.user!.id)
      .first<{ count: number }>();
    expect(claims?.count).toBe(1);
  });

  it("counts a deliberate inspect/favourite once per day, not on every reload or toggle", async () => {
    const player = await playerContext();
    const fixture = await seedOwnedCard(player);
    await setBalance(player, player.user!.id, 0);
    await recordDailyInteraction(player, "card.inspected", fixture.cardId);
    await recordDailyInteraction(player, "card.inspected", fixture.cardId);
    await recordDailyInteraction(player, "card.favourited", fixture.cardId);
    await recordDailyInteraction(player, "card.favourited", fixture.cardId);
    const state = await getDailyMissions(player);
    expect(state.missions.find((mission) => mission.key === "inspect")?.progress).toBe(1);
    expect(state.missions.find((mission) => mission.key === "favourite")?.progress).toBe(1);
    const events = await runtime.DB
      .prepare("SELECT event_type, COUNT(*) AS count FROM fb_domain_events WHERE user_id = ? AND event_type IN ('card.inspected','card.favourited') GROUP BY event_type")
      .bind(player.user!.id)
      .all<{ event_type: string; count: number }>();
    expect(events.results.find((row) => row.event_type === "card.inspected")?.count).toBe(1);
    expect(events.results.find((row) => row.event_type === "card.favourited")?.count).toBe(1);
  });

  it("keeps the day's assignment stable when the balance changes", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    const before = await getDailyMissions(player);
    expect(before.missions.map((mission) => mission.key)).toContain("open");
    await setBalance(player, player.user!.id, 0);
    const after = await getDailyMissions(player);
    expect(after.missions.map((mission) => mission.key)).toEqual(before.missions.map((mission) => mission.key));
    expect(after.missions.find((mission) => mission.key === "open")?.version).toBe(1);
  });

  it("gives fewer missions when the player has no cards or funds", async () => {
    const player = await playerContext();
    await setBalance(player, player.user!.id, 0);
    const state = await getDailyMissions(player);
    expect(state.missions.map((mission) => mission.key)).toEqual(["explore"]);
    expect(state.missions[0]?.claimed).toBe(false);
  });

  it("does not carry yesterday's progress into today", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await backdateEvent(player.user!.id, player.tenant.id, "collection.explored", yesterday);
    await backdateEvent(player.user!.id, player.tenant.id, "card.inspected", yesterday);
    const state = await getDailyMissions(player);
    expect(state.missions.find((mission) => mission.key === "explore")?.progress).toBe(0);
    expect(state.missions.find((mission) => mission.key === "inspect")?.progress).toBe(0);
  });

  it("rejects synthetic NPCs from the human mission loop", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const npc = await createNpc(owner, { name: "Missionless NPC", presetKey: "rookie" });
    const npcUser = await runtime.DB
      .prepare("SELECT u.id, u.email, u.display_name FROM fb_users u JOIN fb_npc_collectors n ON n.user_id = u.id WHERE n.id = ?")
      .bind(npc.id)
      .first<{ id: string; email: string; display_name: string }>();
    const npcCtx: Ctx = {
      ...owner,
      user: { id: npcUser!.id, email: npcUser!.email, displayName: npcUser!.display_name, role: "player", platformAdmin: false, capabilities: [], synthetic: true },
      actor: { type: "user", id: npcUser!.id, representedUserId: npcUser!.id, label: `NPC ${npcUser!.display_name}` },
    };
    await expect(getDailyMissions(npcCtx)).rejects.toMatchObject({ code: "synthetic_mission_blocked" });
  });

  it("enforces named read and claim scopes through the real router", async () => {
    const player = await playerContext();
    await seedOwnedCard(player);
    await recordCollectionExploration(player, "col_test_public");
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const readGrant=await createAgentGrant(owner,{agentName:'Mission reader',representedUserId:player.user!.id,scopes:['missions:read'],expiresInDays:1});
    const readOnly=await buildContext(new Request('https://foilbury.test/api/v1/missions/daily',{headers:{authorization:`Bearer ${readGrant.token}`}}));
    expect((await send(readOnly, "/api/v1/missions/daily")).status).toBe(200);
    expect((await send(readOnly, "/api/v1/missions/daily/claim", "POST", { key: "explore" })).status).toBe(403);
    const grant=await createAgentGrant(owner,{agentName:'Mission claimer',representedUserId:player.user!.id,scopes:['missions:read','missions:claim'],expiresInDays:1});
    const claimer=await buildContext(new Request('https://foilbury.test/api/v1/missions/daily/claim',{headers:{authorization:`Bearer ${grant.token}`}}));
    const claimed = await send(claimer, "/api/v1/missions/daily/claim", "POST", { key: "explore" });
    expect(claimed.status).toBe(200);
    expect(claimed.body.amount).toBe(60);
    const unknown = await send(claimer, "/api/v1/missions/daily/claim", "POST", { key: "not_assigned" });
    expect(unknown.status).toBe(404);
  });
});
