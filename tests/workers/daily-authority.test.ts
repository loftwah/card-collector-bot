import {describe,expect,it,vi} from 'vitest';
import {bootstrap,ctxFor,runtime,walletBalance} from './helpers';
import {createAgentGrant,createSession} from '../../src/server/modules/identity';
import {resolveAgent,resolveSession} from '../../src/server/context';
import {claimDailyReward} from '../../src/server/modules/economy';

describe('daily allowance mutation boundary',()=>{
  it('rejects an allowance if the quoted UTC day differs from the transaction day',async()=>{
    await bootstrap();
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const before=await walletBalance(ctx,ctx.user!.id);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2001-01-01T23:59:59.999Z'));
      await expect(claimDailyReward(ctx,{key:'daily-stale-day',digest:'daily-stale-day'})).rejects.toMatchObject({code:'reward_changed'});
    } finally {vi.useRealTimers();}
    expect(await walletBalance(ctx,ctx.user!.id)).toBe(before);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it('returns a complete receipt for concurrent retries of the same key',async()=>{
    await bootstrap();
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const before=await walletBalance(ctx,ctx.user!.id);
    const input={key:'daily-concurrent-key',digest:'daily-concurrent-key'};
    const results=await Promise.all([claimDailyReward(ctx,input),claimDailyReward(ctx,input)]);
    expect(results[0].claim_id).toBe(results[1].claim_id);
    for(const result of results){expect(result.balance_after).toBe(before+result.amount);expect(result.next_eligible_at).toBeTruthy();}
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{n:number}>())?.n).toBe(1);
  });
  it('recovers the same committed allowance after a lost batch response',async()=>{
    await bootstrap();
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const before=await walletBalance(ctx,ctx.user!.id);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{
      const result=await target.batch(statements);if(!injected){injected=true;throw new Error('response lost');}return result;
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const input={key:'daily-lost-response',digest:'daily-lost-response'};
    await expect(claimDailyReward({...ctx,db},input)).rejects.toThrow('response lost');
    const recovered=await claimDailyReward(ctx,input);
    expect(recovered.replayed).toBe(true);
    expect(await walletBalance(ctx,ctx.user!.id)).toBe(before+recovered.amount);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{n:number}>())?.n).toBe(1);
  });
  it('rejects a rotated agent token at commit without issuing an allowance',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const player=await ctxFor('cabinet','player@foilbury.local');
    const grant=await createAgentGrant(owner,{agentName:'daily agent',representedUserId:player.user!.id,scopes:['reward:claim'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);
    const ctx={...player,...principal,agentCredential:principal.credential};
    const before=await walletBalance(ctx,ctx.user!.id);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{
      if(!injected){injected=true;await target.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated',principal.credential.tokenId).run();}
      return target.batch(statements);
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(claimDailyReward({...ctx,db},{key:'daily-rotated-agent',digest:'daily-rotated-agent'})).rejects.toThrow();
    expect(await walletBalance(ctx,ctx.user!.id)).toBe(before);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{n:number}>())?.n).toBe(0);
  });
  it.each(['session','settings'])('does not credit when %s changes after the request check',async change=>{
    await bootstrap();const base=await ctxFor('cabinet','player@foilbury.local');const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const ctx={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};const before=await walletBalance(ctx,ctx.user!.id);let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;
      if(change==='session')await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),ctx.sessionId).run();
      else await target.prepare('UPDATE fb_economy_settings SET daily_reward=0,version=version+1 WHERE tenant_id=?').bind(ctx.tenant.id).run();
    }return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(claimDailyReward({...ctx,db},{key:`daily-${change}`,digest:`daily-${change}`})).rejects.toThrow();
    expect(await walletBalance(ctx,ctx.user!.id)).toBe(before);
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_reward_claims WHERE tenant_id=? AND user_id=?').bind(ctx.tenant.id,ctx.user!.id).first<{n:number}>())?.n).toBe(0);
  });
});
