import {describe,expect,it} from 'vitest';
import {bootstrap,ctxFor,fixturePool,makeInstance,runtime} from './helpers';
import {createAgentGrant,createSession} from '../../src/server/modules/identity';
import {resolveAgent,resolveSession} from '../../src/server/context';
import {cancelRecycle,recycleCommit,recyclePreview} from '../../src/server/modules/collection';
import {routeApi} from '../../src/server/api/router';

describe('recycle settlement boundary',()=>{
  it.each(['session','disabled','rates','favourite','locked'])('does not surrender or credit when %s changes after preview',async change=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,`RECYCLE-RACE-${change}`);
    const preview=await recyclePreview(ctx,id);const before=await runtime.DB.prepare('SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{balance:number}>();let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(++batches===2){
      if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),ctx.sessionId).run();
      else if(change==='disabled')await target.prepare('UPDATE fb_economy_settings SET recycle_enabled=0 WHERE tenant_id=?').bind(ctx.tenant.id).run();
      else if(change==='rates')await target.prepare("UPDATE fb_economy_settings SET recycle_rates_json=? WHERE tenant_id=?").bind(JSON.stringify({rarity:{common:999},material:{plain:0}}),ctx.tenant.id).run();
      else await target.prepare(`UPDATE fb_card_instances SET ${change==='favourite'?'favourite':'locked'}=1 WHERE id=?`).bind(id).run();
    }return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(recycleCommit({...ctx,db},{instanceId:id,expectedCredit:preview.credit,idempotencyKey:`race-${change}`})).rejects.toThrow();
    expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(id).first<{status:string}>())?.status).toBe('owned');
    expect((await runtime.DB.prepare('SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{balance:number}>())?.balance).toBe(before?.balance);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_recycle_receipts WHERE instance_id=?').bind(id).first<{n:number}>())?.n).toBe(0);
  });
  it('recovers a lost committed response with the original key and never credits twice',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-LOST');const preview=await recyclePreview(ctx,id);let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{const result=await target.batch(statements);if(++batches===2){throw new Error('lost response');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const first=await recycleCommit({...ctx,db},{instanceId:id,expectedCredit:preview.credit,idempotencyKey:'recycle-lost'});
    const replay=await recycleCommit(ctx,{instanceId:id,expectedCredit:preview.credit,idempotencyKey:'recycle-lost'});
    expect(replay).toEqual(first);
    await expect(recycleCommit(ctx,{instanceId:id,expectedCredit:preview.credit+1,idempotencyKey:'recycle-lost'})).rejects.toMatchObject({code:'recycle_conflict'});
    const other=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-OTHER');
    await expect(recycleCommit(ctx,{instanceId:other,expectedCredit:preview.credit,idempotencyKey:'recycle-lost'})).rejects.toMatchObject({code:'recycle_conflict'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(other).first<{status:string}>())?.status).toBe('owned');
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='recycle' AND user_id=?").bind(ctx.user!.id).first<{n:number}>())?.n).toBe(1);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_recycle_receipts WHERE instance_id=?').bind(id).first<{n:number}>())?.n).toBe(1);
  });
  it('replays a competing same-key commit that wins between lookup and quote',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-COMPETE');const preview=await recyclePreview(ctx,id);let injected=false;
    const input={instanceId:id,expectedCredit:preview.credit,idempotencyKey:'recycle-compete'};
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{const stmt=target.prepare(sql);if(!sql.includes('SELECT es.recycle_rates_json'))return stmt;
      return new Proxy(stmt,{get(s,k){if(k==='bind')return (...args:unknown[])=>{const bound=s.bind(...args);return new Proxy(bound,{get(b,p){if(p==='first')return async()=>{if(!injected){injected=true;await recycleCommit(ctx,input);}return b.first();};const v=Reflect.get(b,p,b);return typeof v==='function'?v.bind(b):v;}});};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const result=await recycleCommit({...ctx,db},input);
    expect(result).toEqual(await recycleCommit(ctx,input));
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='recycle' AND user_id=?").bind(ctx.user!.id).first<{n:number}>())?.n).toBe(1);
  });
  it('rolls back the surrender and credit if audit insertion fails',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-ROLLBACK');const preview=await recyclePreview(ctx,id);
    await runtime.DB.prepare("CREATE TRIGGER fixture_recycle_audit_failure BEFORE INSERT ON fb_audit_events WHEN NEW.action='instance.recycled' BEGIN SELECT RAISE(ABORT,'fixture failure'); END").run();
    try {await expect(recycleCommit(ctx,{instanceId:id,expectedCredit:preview.credit,idempotencyKey:'recycle-rollback'})).rejects.toMatchObject({code:'recycle_receipt_unavailable'});
      expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(id).first<{status:string}>())?.status).toBe('owned');
      expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_recycle_receipts WHERE instance_id=?').bind(id).first<{n:number}>())?.n).toBe(0);
    } finally {await runtime.DB.prepare('DROP TRIGGER fixture_recycle_audit_failure').run();}
  });
  it('accepts a live recycle agent and rejects its rotated token at settlement',async()=>{
    await bootstrap();const owner=await ctxFor('cabinet','owner@foilbury.local'),player=await ctxFor('cabinet','player@foilbury.local');const fixture=await fixturePool(player);
    const grant=await createAgentGrant(owner,{agentName:'recycle agent',representedUserId:player.user!.id,scopes:['recycle:write'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);const agent={...player,...principal,agentCredential:principal.credential};
    const firstId=await makeInstance(player,player.user!.id,fixture,'RECYCLE-AGENT-OK');
    const settled=await recycleCommit(agent,{instanceId:firstId,expectedCredit:10,idempotencyKey:'agent-ok'});
    expect(settled.credit).toBe(10);
    expect(await runtime.DB.prepare("SELECT actor_type,actor_id FROM fb_ledger_entries WHERE reference_type='recycle' AND reference_id=?").bind(settled.receipt_id).first()).toEqual({actor_type:'agent',actor_id:agent.actor.id});
    const secondId=await makeInstance(player,player.user!.id,fixture,'RECYCLE-AGENT-ROTATE');let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(++batches===2){await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('recycle-rotated',principal.credential.tokenId).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(recycleCommit({...agent,db},{instanceId:secondId,expectedCredit:10,idempotencyKey:'agent-rotated'})).rejects.toMatchObject({status:404});
    expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(secondId).first<{status:string}>())?.status).toBe('owned');
  });
  it('cancels a stale quote explicitly and permanently fences the old request',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-CANCEL-STALE');
    const old={instanceId:id,expectedCredit:99,idempotencyKey:'stale-quote'};
    await expect(recycleCommit(ctx,old)).rejects.toMatchObject({code:'credit_changed'});
    expect(await cancelRecycle(ctx,old)).toEqual({status:'cancelled'});
    expect(await cancelRecycle(ctx,old)).toEqual({status:'cancelled'});
    await expect(recycleCommit(ctx,old)).rejects.toMatchObject({code:'recycle_cancelled'});
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='recycle.cancelled' AND object_id=?").bind(id).first<{n:number}>())?.n).toBe(1);
    expect((await recycleCommit(ctx,{instanceId:id,expectedCredit:10,idempotencyKey:'new-quote'})).credit).toBe(10);
  });
  it.each(['cancel','commit'])('%s wins atomically against the competing operation',async winner=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,`RECYCLE-WIN-${winner}`);
    const input={instanceId:id,expectedCredit:10,idempotencyKey:`race-${winner}`};let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(++batches===2){if(winner==='cancel')await cancelRecycle(ctx,input);else await recycleCommit(ctx,input);}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    if(winner==='cancel') {
      await expect(recycleCommit({...ctx,db},input)).rejects.toMatchObject({code:'recycle_cancelled'});
      expect(await cancelRecycle(ctx,input)).toEqual({status:'cancelled'});
      expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(id).first<{status:string}>())?.status).toBe('owned');
    } else {
      const outcome=await cancelRecycle({...ctx,db},input);
      expect(outcome.status).toBe('completed');
      expect(outcome).toEqual(await cancelRecycle(ctx,input));
      expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(id).first<{status:string}>())?.status).toBe('surrendered');
    }
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_recycle_receipts WHERE instance_id=?').bind(id).first<{n:number}>())?.n).toBe(winner==='commit'?1:0);
  });
  it('does not cancel after session revocation or a failed cancellation audit',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-CANCEL-AUTH');const input={instanceId:id,expectedCredit:10,idempotencyKey:'cancel-auth'};let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(++batches===2)await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),ctx.sessionId).run();return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(cancelRecycle({...ctx,db},input)).rejects.toMatchObject({code:'recycle_resolution_unavailable'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_recycle_requests WHERE idempotency_key=?').bind(input.idempotencyKey).first<{status:string}>())?.status).toBe('pending');
    const newSession=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});const renewed={...base,sessionId:(await resolveSession(base.db,newSession.token))!.sessionId};
    await runtime.DB.prepare("CREATE TRIGGER fixture_cancel_audit_failure BEFORE INSERT ON fb_audit_events WHEN NEW.action='recycle.cancelled' BEGIN SELECT RAISE(ABORT,'fixture failure'); END").run();
    try {await expect(cancelRecycle(renewed,input)).rejects.toThrow();expect((await runtime.DB.prepare('SELECT status FROM fb_recycle_requests WHERE idempotency_key=?').bind(input.idempotencyKey).first<{status:string}>())?.status).toBe('pending');}
    finally {await runtime.DB.prepare('DROP TRIGGER fixture_cancel_audit_failure').run();}
    expect(await cancelRecycle(renewed,input)).toEqual({status:'cancelled'});
  });
  it('does not cancel after the exact delegated token is rotated',async()=>{
    await bootstrap();const owner=await ctxFor('cabinet','owner@foilbury.local'),player=await ctxFor('cabinet','player@foilbury.local');const fixture=await fixturePool(player),id=await makeInstance(player,player.user!.id,fixture,'RECYCLE-CANCEL-AGENT');
    const grant=await createAgentGrant(owner,{agentName:'cancel agent',representedUserId:player.user!.id,scopes:['recycle:write'],expiresInDays:1});const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);const agent={...player,...principal,agentCredential:principal.credential};const input={instanceId:id,expectedCredit:10,idempotencyKey:'agent-cancel'};let batches=0;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(++batches===2)await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-cancel-agent',principal.credential.tokenId).run();return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(cancelRecycle({...agent,db},input)).rejects.toMatchObject({code:'recycle_resolution_unavailable'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_recycle_requests WHERE idempotency_key=?').bind(input.idempotencyKey).first<{status:string}>())?.status).toBe('pending');
  });
  it('dispatches only the exact cancellation route with the original key',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId,csrfToken:'fixture-csrf'};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-CANCEL-ROUTE');
    const request=()=>new Request('https://foilbury.test/api/v1/recycle/cancel',{method:'POST',headers:{'content-type':'application/json','x-foilbury-csrf':'fixture-csrf','idempotency-key':'route-cancel-key'},body:JSON.stringify({instanceId:id,expectedCredit:10})});
    await expect(routeApi(request(),ctx,'recycle/cancel/extra')).rejects.toMatchObject({status:404});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_recycle_requests WHERE idempotency_key=?').bind('route-cancel-key').first<{n:number}>())?.n).toBe(0);
    expect(await (await routeApi(request(),ctx,'recycle/cancel')).json()).toEqual({status:'cancelled'});
    expect(await (await routeApi(request(),ctx,'recycle/cancel')).json()).toEqual({status:'cancelled'});
    await expect(recycleCommit(ctx,{instanceId:id,expectedCredit:10,idempotencyKey:'route-cancel-key'})).rejects.toMatchObject({code:'recycle_cancelled'});
  });
  it('holds a new recycle safely when the reservation schema is unavailable',async()=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const fixture=await fixturePool(ctx),id=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-MISSING-SCHEMA');
    const previousId=await makeInstance(ctx,ctx.user!.id,fixture,'RECYCLE-PRIOR-SCHEMA'),previous={instanceId:previousId,expectedCredit:10,idempotencyKey:'existing-receipt'};
    const receipt=await recycleCommit(ctx,previous);
    await runtime.DB.prepare('DROP TABLE fb_recycle_requests').run();
    expect(await recycleCommit(ctx,previous)).toEqual(receipt);
    await expect(recycleCommit(ctx,{instanceId:id,expectedCredit:10,idempotencyKey:'missing-schema'})).rejects.toMatchObject({status:503,code:'recycle_temporarily_unavailable'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_card_instances WHERE id=?').bind(id).first<{status:string}>())?.status).toBe('owned');
  });
});
