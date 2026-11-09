import { describe,expect,it } from 'vitest';
import { bootstrap,ctxFor,fixturePool,runtime } from './helpers';
import { addMembership,createAgentGrant,createUser,ensureWallet } from '../../src/server/modules/identity';
import { listMyGiftReceipts,sendAdminGift } from '../../src/server/modules/admin-gifts';
import { nowIso } from '../../src/server/db';
import { buildContext } from '../../src/server/context';

async function signed(ctx:Awaited<ReturnType<typeof ctxFor>>) {
  const now=nowIso(),id=`receipt-session-${crypto.randomUUID()}`;
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)")
    .bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}

function beforeReceiptRead(change:()=>Promise<unknown>) {
  return new Proxy(runtime.DB,{get(target,key){
    if(key==='prepare') return (sql:string)=>{
      const stmt=target.prepare(sql);
      if(!sql.includes('AS can_view_card')) return stmt;
      return new Proxy(stmt,{get(inner,method){
        if(method==='bind') return (...args:unknown[])=>{
          const bound=inner.bind(...args);
          return new Proxy(bound,{get(result,operation){
            if(operation==='all') return async (...call:unknown[])=>{await change();return result.all(...call as []);};
            const value=Reflect.get(result,operation,result);return typeof value==='function'?value.bind(result):value;
          }});
        };
        const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;
      }});
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}

describe('gift receipt live boundaries',()=>{
  it('rechecks the session and neutralises card details after collection access is revoked',async()=>{
    await bootstrap();
    const owner=await signed(await ctxFor('cabinet','owner@foilbury.local'));
    const user=await createUser(runtime.DB,{email:'receipt-live@example.com',displayName:'Receipt user',password:'a-long-test-password'});
    await addMembership(runtime.DB,owner.tenant.id,user.id,'player');await ensureWallet(runtime.DB,owner.tenant.id,user.id);
    const viewer=await signed(await ctxFor('cabinet','receipt-live@example.com'));
    const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)").bind(user.id,owner.user!.id,nowIso()).run();
    await sendAdminGift(owner,{kind:'card',scope:'single',userIds:[user.id],cardId:fixture.cardId,reason:'Private gift reason',message:'Private gift message',idempotency:{key:'receipt-private',digest:'receipt-private'}});
    await sendAdminGift(owner,{kind:'foil',scope:'single',userIds:[user.id],amount:20,reason:'Foil reason',idempotency:{key:'receipt-foil',digest:'receipt-foil'}});
    await runtime.DB.prepare("UPDATE fb_gift_awards SET receipt_json=? WHERE user_id=? AND kind='card'").bind(JSON.stringify({description:'Unreviewed secret variant',serial:'legacy-serial'}),user.id).run();
    const before=await listMyGiftReceipts(viewer);
    expect(before.find((row)=>row.kind==='card')).toMatchObject({description:'Card gift',receipt:{}});
    expect(JSON.stringify(before)).not.toContain('Unreviewed secret variant');
    const grant=await createAgentGrant(owner,{agentName:'Receipt fixture',representedUserId:user.id,scopes:['trade:write'],expiresInDays:1});
    const agent=await buildContext(new Request('https://foilbury.test/api/v1/gifts/received',{headers:{authorization:`Bearer ${grant.token}`}}));
    expect((await listMyGiftReceipts(agent)).length).toBe(2);
    const agentRevoked=beforeReceiptRead(()=>runtime.DB.prepare('UPDATE fb_agent_tokens SET revoked_at=? WHERE id=?').bind(nowIso(),agent.agentCredential!.tokenId).run());
    expect(await listMyGiftReceipts({...agent,db:agentRevoked})).toEqual([]);
    await runtime.DB.prepare('UPDATE fb_agent_tokens SET revoked_at=NULL WHERE id=?').bind(agent.agentCredential!.tokenId).run();
    const grantRevoked=beforeReceiptRead(()=>runtime.DB.prepare("UPDATE fb_agent_grants SET status='revoked',revoked_at=? WHERE id=?").bind(nowIso(),agent.agentCredential!.grantId).run());
    expect(await listMyGiftReceipts({...agent,db:grantRevoked})).toEqual([]);
    const db=beforeReceiptRead(()=>runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?").bind(nowIso(),user.id).run());
    const after=await listMyGiftReceipts({...viewer,db});
    const card=after.find((row)=>row.kind==='card');
    expect(card).toMatchObject({description:'A card gift is not currently available.',message:null,reason:null,receipt:{}});
    expect(JSON.stringify(card)).not.toMatch(/Private gift|Test/);
    expect(after.find((row)=>row.kind==='foil')?.amount).toBe(20);
    const revoked=beforeReceiptRead(()=>runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),viewer.sessionId).run());
    expect(await listMyGiftReceipts({...viewer,db:revoked})).toEqual([]);
  });
});
