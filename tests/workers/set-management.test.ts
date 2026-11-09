import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { createSet, replaceSetMembership, publishSet } from "../../src/server/modules/catalogue";
import { listManagedSets } from "../../src/server/modules/set-management";
import { nowIso } from "../../src/server/db";

describe("Bot-scoped set management", () => {
  it("does not expose inaccessible sets through the overload limit", async () => {
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local'), player=await ctxFor('cabinet','player@foilbury.local');
    const foreign=await ctxFor('harbour','harbour.owner@foilbury.test'), fixture=await fixturePool(owner), now=nowIso();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('set_limit_session','set_limit_token',?,?,'test',?,?,?,'mfa',?)").bind(player.user!.id,player.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const editor={...player,user:{...player.user!,role:'editor' as const,capabilities:['content']},sessionId:'set_limit_session',sessionAssurance:'mfa',sessionAuthTime:now};
    const baseline=(await listManagedSets(editor)).map(set=>set.id).sort();
    await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('limit_private','limit-private','Private','fixture','global',?,'brass','published','private','test',?,?)").bind(foreign.tenant.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,added_by,added_at) VALUES ('limit_private',?,?,?,?)").bind(fixture.cardId,owner.tenant.id,owner.user!.id,now).run();
    const statements=[];
    for(let i=0;i<101;i++) {
      statements.push(runtime.DB.prepare("INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) VALUES(?,?,?,?,?,'draft',1,?)").bind(`hidden_set_${i}`,owner.tenant.id,`hidden-set-${i}`,'Hidden','',now));
      statements.push(runtime.DB.prepare("INSERT INTO fb_set_memberships(id,tenant_id,set_id,set_version,card_id,created_at) VALUES(?,?,?,1,?,?)").bind(`hidden_item_${i}`,owner.tenant.id,`hidden_set_${i}`,fixture.cardId,now));
    }
    await runtime.DB.batch(statements);
    expect((await listManagedSets(editor)).map(set=>set.id).sort()).toEqual(baseline);
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2001)
      INSERT INTO fb_card_definitions(id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at)
      SELECT 'limit_card_'||i,?,'limit_'||i,'limit-card-'||i,'Hidden','','published',?,? FROM n`).bind(owner.tenant.id,now,now).run();
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2001)
      INSERT INTO fb_collection_cards(collection_id,card_id,tenant_id,added_by,added_at) SELECT 'limit_private','limit_card_'||i,?,?,? FROM n`).bind(owner.tenant.id,owner.user!.id,now).run();
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<2001)
      INSERT INTO fb_set_memberships(id,tenant_id,set_id,set_version,card_id,created_at) SELECT 'limit_item_'||i,?,'hidden_set_0',1,'limit_card_'||i,? FROM n`).bind(owner.tenant.id,now).run();
    expect((await listManagedSets(editor)).map(set=>set.id).sort()).toEqual(baseline);
    await runtime.DB.prepare("INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) VALUES('visible_empty',?,'visible-empty','Visible','','draft',1,?)").bind(owner.tenant.id,now).run();
    expect((await listManagedSets(editor)).map(set=>set.id).sort()).toEqual([...baseline,'visible_empty'].sort());
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100)
      INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) SELECT 'open_set_'||i,?,'open-set-'||i,'Visible','','draft',1,? FROM n`).bind(owner.tenant.id,now).run();
    await expect(listManagedSets(editor)).rejects.toMatchObject({code:'set_list_overloaded'});
  });
  it("lets a live editor manage a set without authorizing a public release, and fences revocation", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local"), player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner), now = nowIso(), expires = new Date(Date.now() + 3600000).toISOString();
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id=?").bind(owner.tenant.id).first<{id:string}>();
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('set_editor',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id,player.user!.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('set_editor_session','set_editor_token',?,?,'test',?,?,?,'mfa',?)").bind(player.user!.id,player.tenant.id,now,expires,now,now).run();
    const editor = { ...player, user: {...player.user!,role:'editor' as const,capabilities:['content']}, sessionId:'set_editor_session',sessionAssurance:'mfa',sessionAuthTime:now };
    await runtime.DB.prepare("UPDATE fb_memberships SET role='economy_admin',capabilities_json='[\"economy\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("DELETE FROM fb_bot_admins WHERE id='set_editor'").run();
    await expect(createSet(editor,{slug:'economy-only',name:'No content',description:'fixture',rewardAmount:0})).rejects.toMatchObject({code:'set_management_forbidden'});
    await runtime.DB.prepare("UPDATE fb_memberships SET role='editor',capabilities_json='[\"content\"]' WHERE tenant_id=? AND user_id=?").bind(owner.tenant.id,player.user!.id).run();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('set_editor',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id,player.user!.id,now).run();
    await runtime.DB.prepare("UPDATE fb_bot_admins SET role='owner' WHERE id='set_editor'").run();
    await expect(createSet(editor,{slug:'stale-owner',name:'Stale owner',description:'fixture',rewardAmount:0})).rejects.toMatchObject({code:'set_management_forbidden'});
    await runtime.DB.prepare("UPDATE fb_bot_admins SET role='admin' WHERE id='set_editor'").run();
    const created = await createSet(editor,{slug:'editor-set',name:'Editor set',description:'Private working metadata',rewardAmount:5});
    expect(created.status).toBe('draft');
    const populated = await replaceSetMembership(editor,created.id,[fixture.cardId]);
    expect(populated.cards).toHaveLength(1);
    const accessEditor = {...editor,sessionAssurance:'access',accessStatus:'linked' as const,accessIdentity:{subject:'fixture',email:player.user!.email,audience:'fixture',payload:{exp:Math.floor(Date.now()/1000)+3600}}};
    await expect(publishSet(accessEditor,created.id)).rejects.toMatchObject({code:'strong_auth_required'});
    let expired=false;
    const staleDb=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{if(!expired){expired=true;await target.prepare("UPDATE fb_sessions SET auth_time='2000-01-01T00:00:00.000Z' WHERE id='set_editor_session'").run();}return target.batch(stmts);};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    await expect(publishSet({...editor,db:staleDb},created.id)).rejects.toMatchObject({code:'set_changed'});
    expect((await runtime.DB.prepare("SELECT status FROM fb_sets WHERE id=?").bind(created.id).first<{status:string}>())?.status).toBe('draft');
    await runtime.DB.prepare("UPDATE fb_sessions SET auth_time=? WHERE id='set_editor_session'").bind(now).run();
    const published = await publishSet(editor,created.id);
    expect(published.status).toBe('published');
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_public_set_releases WHERE set_id=?").bind(created.id).first<{n:number}>())?.n).toBe(0);
    const foreign = await ctxFor('harbour','harbour.owner@foilbury.test');
    await expect(replaceSetMembership({...editor,tenant:foreign.tenant},created.id,[])).rejects.toMatchObject({code:'set_management_forbidden'});
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{if(!injected){injected=true;await target.prepare("UPDATE fb_bot_admins SET status='revoked',revoked_at=? WHERE id='set_editor'").bind(now).run();}return target.batch(stmts);};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    await expect(replaceSetMembership({...editor,db},created.id,[])).rejects.toMatchObject({code:'set_changed'});
    const persisted=await runtime.DB.prepare("SELECT version,status FROM fb_sets WHERE id=?").bind(created.id).first();
    expect(persisted).toEqual({version:1,status:'published'});
    await expect(listManagedSets(editor)).rejects.toMatchObject({code:'set_management_forbidden'});
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status='active',revoked_at=NULL WHERE id='set_editor'").run();
    await expect(createSet({ ...editor, sessionId: null },{slug:'no-session',name:'No session',description:'fixture',rewardAmount:0})).rejects.toMatchObject({code:'set_management_forbidden'});
    const raceDb=(mutation:()=>Promise<unknown>)=>{let fired=false;return new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{if(!fired){fired=true;await mutation();}return target.batch(stmts);};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});};
    const rosterRace=raceDb(()=>runtime.DB.prepare("UPDATE fb_set_memberships SET sort=99 WHERE tenant_id=? AND set_id=? AND set_version=1").bind(owner.tenant.id,created.id).run());
    await expect(replaceSetMembership({...editor,db:rosterRace},created.id,[])).rejects.toMatchObject({code:'set_changed'});
    expect((await runtime.DB.prepare("SELECT sort FROM fb_set_memberships WHERE tenant_id=? AND set_id=? AND set_version=1").bind(owner.tenant.id,created.id).first<{sort:number}>())?.sort).toBe(99);
    await runtime.DB.prepare("UPDATE fb_set_memberships SET sort=0 WHERE tenant_id=? AND set_id=? AND set_version=1").bind(owner.tenant.id,created.id).run();
    const harbour=await ctxFor('harbour','harbour.owner@foilbury.test');
    await runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('set_private','set-private','Private','fixture','global',?,'brass','published','private','fixture',?,?)").bind(harbour.tenant.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,added_by,added_at) VALUES ('set_private',?,?,?,?)").bind(fixture.cardId,owner.tenant.id,owner.user!.id,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('set_private',?,?,?)").bind(player.user!.id,owner.user!.id,now).run();
    const accessRace=raceDb(()=>runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id='set_private' AND user_id=?").bind(player.user!.id).run());
    await expect(replaceSetMembership({...editor,db:accessRace},created.id,[])).rejects.toMatchObject({code:'set_changed'});
    expect((await runtime.DB.prepare("SELECT version,status FROM fb_sets WHERE id=?").bind(created.id).first())).toEqual({version:1,status:'published'});
    expect((await listManagedSets(editor)).some(set=>set.id===created.id)).toBe(false);
    const withTransientGrant = (needle: string) => new Proxy(runtime.DB, { get(target,key) {
      if (key === "prepare") return (sql:string) => {
        const statement=target.prepare(sql);
        if (!sql.includes(needle)) return statement;
        const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{get(inner,method){
          if (method === "bind") return (...values:unknown[])=>wrap(inner.bind(...values));
          if (method === "all") return async()=>{
            await target.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('set_private',?,?,?)").bind(player.user!.id,owner.user!.id,now).run();
            const result=await inner.all();
            await target.prepare("DELETE FROM fb_collection_viewers WHERE collection_id='set_private' AND user_id=?").bind(player.user!.id).run();
            return result;
          };
          const v=Reflect.get(inner,method,inner);return typeof v==='function'?v.bind(inner):v;
        }});
        return wrap(statement);
      };
      const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;
    }});
    await expect(replaceSetMembership({...editor,db:withTransientGrant("SELECT cd.id FROM fb_card_definitions cd WHERE cd.tenant_id")},created.id,[])).rejects.toMatchObject({code:'set_changed'});
    expect((await listManagedSets({...editor,db:withTransientGrant("SELECT sm.set_id,cd.id,cd.slug,cd.name,sm.sort")})).some(set=>set.id===created.id)).toBe(false);
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers (collection_id,user_id,granted_by,created_at) VALUES ('set_private',?,?,?)").bind(player.user!.id,owner.user!.id,now).run();
    const rollbackDb=new Proxy(runtime.DB,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>target.batch([...stmts,target.prepare("INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,sort,created_at) VALUES ('bad',?,?,1,?,0,?)").bind(owner.tenant.id,created.id,fixture.cardId,now)]);const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
    await expect(replaceSetMembership({...editor,db:rollbackDb},created.id,[])).rejects.toThrow();
    expect((await runtime.DB.prepare("SELECT version,status FROM fb_sets WHERE id=?").bind(created.id).first())).toEqual({version:1,status:'published'});
  });
});
