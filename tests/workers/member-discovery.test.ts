import { describe, expect, it } from 'vitest';
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from './helpers';
import { getMemberTradeInventory, listTenantMembers } from '../../src/server/modules/collection';
import { createAgentGrant, createSession } from '../../src/server/modules/identity';
import { resolveAgent, resolveSession } from '../../src/server/context';

describe('trade partner discovery', () => {
  it('does not expose another member’s private card or its source metadata', async () => {
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const player={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const card=await fixturePool(owner);
    const instanceId=await makeInstance(owner,owner.user!.id,card);
    const visible=await getMemberTradeInventory(player,owner.user!.id);
    expect(visible).toHaveLength(1);
    expect(visible[0]).not.toHaveProperty('composition_json');
    expect(visible[0]).not.toHaveProperty('subject_asset_id');
    expect(visible[0]).not.toHaveProperty('favourite');
    expect(visible[0]).not.toHaveProperty('locked');
    await runtime.DB.prepare('UPDATE fb_card_instances SET locked=1 WHERE id=?').bind(instanceId).run();
    expect(await getMemberTradeInventory(player,owner.user!.id)).toEqual([]);
    await runtime.DB.prepare('UPDATE fb_card_instances SET locked=0 WHERE id=?').bind(instanceId).run();
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'").run();
    expect(await getMemberTradeInventory(player,owner.user!.id)).toEqual([]);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='public',public_approved_at=? WHERE id='col_test_public'").bind(new Date().toISOString()).run();
    await runtime.DB.prepare('UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?').bind(new Date().toISOString(),owner.tenant.id,owner.user!.id).run();
    expect(await getMemberTradeInventory(player,owner.user!.id)).toEqual([]);
  });
  it('withholds trade inventory if the requester is revoked at the result query', async () => {
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const player={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const card=await fixturePool(owner);await makeInstance(owner,owner.user!.id,card);
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=target.prepare(sql);if(!sql.includes('SELECT ci.id,cd.name AS card_name')) return statement;
        return new Proxy(statement,{get(stmt,member){
          if(member==='bind') return (...args:unknown[])=>{
            const bound=stmt.bind(...args);return new Proxy(bound,{get(inner,method){
              if(method==='all') return async()=>{
                await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();
                return inner.all();
              };
              const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(stmt,member,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect(await getMemberTradeInventory({...player,db},owner.user!.id)).toEqual([]);
  });
  it('excludes a revoked membership even if its status still reads active', async () => {
    await bootstrap();
    const base = await ctxFor('cabinet', 'owner@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const owner={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const player = await ctxFor('cabinet', 'player@foilbury.local');
    expect((await listTenantMembers(owner)).some(member => member.id === player.user!.id)).toBe(true);
    await runtime.DB.prepare('UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?')
      .bind(new Date().toISOString(), owner.tenant.id, player.user!.id).run();
    expect((await listTenantMembers(owner)).some(member => member.id === player.user!.id)).toBe(false);
  });
  it('does not return partners after the requester session is revoked at the result query', async () => {
    await bootstrap();
    const base=await ctxFor('cabinet','owner@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const owner={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare') return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.includes('SELECT u.id, u.display_name, m.role')) return statement;
        return new Proxy(statement,{get(stmt,member){
          if(member==='bind') return (...args:unknown[])=>{
            const bound=stmt.bind(...args);
            return new Proxy(bound,{get(inner,method){
              if(method==='all') return async()=>{
                await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),owner.sessionId).run();
                return inner.all();
              };
              const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(stmt,member,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect(await listTenantMembers({...owner,db})).toEqual([]);
  });
  it('requires the current exact agent token when reading partners', async () => {
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const player=await ctxFor('cabinet','player@foilbury.local');
    const grant=await createAgentGrant(owner,{agentName:'trade discovery',representedUserId:player.user!.id,scopes:['inventory:read'],expiresInDays:1});
    const principal=await resolveAgent(player.db,player.config,grant.token,player.tenant);
    const agent={...player,...principal,agentCredential:principal.credential};
    const card=await fixturePool(owner);await makeInstance(owner,owner.user!.id,card);
    expect((await listTenantMembers(agent)).length).toBeGreaterThan(0);
    expect((await getMemberTradeInventory(agent,owner.user!.id)).length).toBe(1);
    await runtime.DB.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated',principal.credential.tokenId).run();
    expect(await listTenantMembers(agent)).toEqual([]);
    expect(await getMemberTradeInventory(agent,owner.user!.id)).toEqual([]);
  });
});
