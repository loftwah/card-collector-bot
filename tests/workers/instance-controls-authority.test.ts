import { describe, expect, it } from 'vitest';
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from './helpers';
import { createAgentGrant, createSession } from '../../src/server/modules/identity';
import { resolveAgent, resolveSession } from '../../src/server/context';
import { setLocked, toggleFavourite } from '../../src/server/modules/collection';
import { routeApi } from '../../src/server/api/router';

describe('owned instance control authority',()=>{
  it.each(['lock','favourite'])('does not apply %s after the exact session is revoked at commit',async mode=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,`CONTROL-${mode}`);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),ctx.sessionId).run();}return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const action=mode==='lock'?setLocked({...ctx,db},id,true):toggleFavourite({...ctx,db},id,true);
    await expect(action).rejects.toMatchObject({code:'instance_not_found'});
    expect(await runtime.DB.prepare('SELECT locked,favourite FROM fb_card_instances WHERE id=?').bind(id).first()).toEqual({locked:0,favourite:0});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE object_type='instance' AND object_id=?").bind(id).first<{n:number}>())?.n).toBe(0);
  });

  it.each(['owner','audience'])('does not change a copy when %s changes at the write boundary',async change=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local'),other=await ctxFor('cabinet','owner@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,`CONTROL-${change}`);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;if(change==='owner')await target.prepare('UPDATE fb_card_instances SET user_id=? WHERE id=?').bind(other.user!.id,id).run();else await target.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(toggleFavourite({...ctx,db},id,true)).rejects.toMatchObject({code:'instance_not_found'});
    expect((await runtime.DB.prepare('SELECT favourite FROM fb_card_instances WHERE id=?').bind(id).first<{favourite:number}>())?.favourite).toBe(0);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE object_type='instance' AND object_id=?").bind(id).first<{n:number}>())?.n).toBe(0);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='card.favourited' AND user_id=?").bind(ctx.user!.id).first<{n:number}>())?.n).toBe(0);
  });

  it('supports authorized controls and records a favourite event only once per day',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'CONTROL-POSITIVE');
    expect(await setLocked(ctx,id,true)).toMatchObject({locked:true});
    expect(await setLocked(ctx,id,false)).toMatchObject({locked:false});
    expect(await toggleFavourite(ctx,id,true)).toMatchObject({favourite:true});
    expect(await toggleFavourite(ctx,id,true)).toMatchObject({favourite:true});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='card.favourited' AND user_id=?").bind(ctx.user!.id).first<{n:number}>())?.n).toBe(1);
  });

  it('does not record progress for a pre-existing favourite, and denies a revoked no-op',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'CONTROL-NOOP');
    await runtime.DB.prepare('UPDATE fb_card_instances SET favourite=1 WHERE id=?').bind(id).run();
    expect(await toggleFavourite(ctx,id,true)).toMatchObject({favourite:true});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='card.favourited' AND user_id=?").bind(ctx.user!.id).first<{n:number}>())?.n).toBe(0);
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),ctx.sessionId).run();
    await expect(toggleFavourite(ctx,id,true)).rejects.toMatchObject({code:'instance_not_found'});
  });

  it('rejects an agent whose exact token is rotated at the write boundary',async()=>{
    await bootstrap();const owner=await ctxFor('cabinet','owner@foilbury.local'),player=await ctxFor('cabinet','player@foilbury.local');
    const fixture=await fixturePool(player),id=await makeInstance(player,player.user!.id,fixture,'CONTROL-AGENT');
    const grant=await createAgentGrant(owner,{agentName:'control agent',representedUserId:player.user!.id,scopes:['inventory:write'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);
    const agent={...player,...principal,agentCredential:principal.credential};
    const request=new Request(`http://localhost/api/v1/instances/${id}/favourite`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({favourite:true})});
    expect((await routeApi(request,agent,`instances/${id}/favourite`)).status).toBe(200);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_domain_events WHERE event_type='card.favourited' AND user_id=?").bind(player.user!.id).first<{n:number}>())?.n).toBe(0);
    const readGrant=await createAgentGrant(owner,{agentName:'read agent',representedUserId:player.user!.id,scopes:['inventory:read'],expiresInDays:1});
    const readPrincipal=await resolveAgent(player.db,player.config,readGrant.token,player.tenant);
    await expect(routeApi(new Request(`http://localhost/api/v1/instances/${id}/lock`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({locked:true})}),{...player,...readPrincipal,agentCredential:readPrincipal.credential},`instances/${id}/lock`)).rejects.toMatchObject({code:'insufficient_scope'});
    expect(await setLocked(agent,id,true)).toMatchObject({locked:true});
    expect(await setLocked(agent,id,false)).toMatchObject({locked:false});
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-control-token',principal.credential.tokenId).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(setLocked({...agent,db},id,true)).rejects.toMatchObject({code:'instance_not_found'});
    expect((await runtime.DB.prepare('SELECT locked FROM fb_card_instances WHERE id=?').bind(id).first<{locked:number}>())?.locked).toBe(0);
  });

  it('rolls back the instance change if its audit insertion fails',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'CONTROL-ROLLBACK');
    await runtime.DB.prepare("CREATE TRIGGER fixture_control_audit_failure BEFORE INSERT ON fb_audit_events WHEN NEW.action='instance.favourited' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END").run();
    try {await expect(toggleFavourite(ctx,id,true)).rejects.toThrow();expect((await runtime.DB.prepare('SELECT favourite FROM fb_card_instances WHERE id=?').bind(id).first<{favourite:number}>())?.favourite).toBe(0);}
    finally {await runtime.DB.prepare('DROP TRIGGER fixture_control_audit_failure').run();}
  });
});
