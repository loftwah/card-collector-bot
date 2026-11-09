import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { serveAsset } from "../../src/pages/media/asset/[id]";
import type { Ctx } from "../../src/server/context";
import { addMembership, createSession, createUser } from "../../src/server/modules/identity";
import { backRenderResponse, derivativeResponse, legacyMediaPolicyFence, renderResponse } from "../../src/server/modules/media";
import { BOUND_LINEAGE_TRIGGER_DEFINITIONS } from '../../src/server/modules/bound-lineage-trigger-definitions';
import { resolveSession } from '../../src/server/context';

async function withSession(ctx:Ctx):Promise<Ctx> {
  const session=await createSession(runtime.DB,ctx.tenant,ctx.user!,{authMethod:'magic_link',assurance:'email'});
  return {...ctx,sessionId:(await resolveSession(runtime.DB,session.token))!.sessionId};
}

describe("generic asset audience", () => {
  it('does not expose an unfiled draft asset to an ordinary member',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const player=await withSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);
    await runtime.DB.batch([
      runtime.DB.prepare('DELETE FROM fb_collection_cards WHERE card_id=?').bind(fixture.cardId),
      runtime.DB.prepare("UPDATE fb_card_definitions SET status='draft' WHERE id=?").bind(fixture.cardId),
      runtime.DB.prepare("UPDATE fb_assets SET access_classification='public',visibility='public_export',processing_state='ready' WHERE id=?").bind(fixture.subjectAsset),
    ]);
    await runtime.MEDIA.put('test/subject.png','subject');
    await runtime.MEDIA.put('test/render.webp','render');
    expect((await serveAsset(player,fixture.subjectAsset)).status).toBe(404);
    expect((await renderResponse(player,runtime.MEDIA,fixture.renderAsset,{publicOnly:false,request:new Request('https://test.local/')})).status).toBe(404);
    const ownerSession=await withSession(owner);
    expect((await serveAsset(ownerSession,fixture.subjectAsset)).status).toBe(200);
    expect((await renderResponse(ownerSession,runtime.MEDIA,fixture.renderAsset,{publicOnly:false,request:new Request('https://test.local/')})).status).toBe(200);
  });
  it('fails closed when an installed media policy trigger is missing',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const [name,sql]=BOUND_LINEAGE_TRIGGER_DEFINITIONS[0];
    await runtime.DB.exec(`DROP TRIGGER "${name}";`);
    try { await expect(legacyMediaPolicyFence(owner)).rejects.toMatchObject({code:'media_policy_unavailable'}); }
    finally { await runtime.DB.exec(`${sql};`); }
  });
  it('fails closed if an installed lineage epoch table is missing',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    expect(await runtime.DB.prepare("SELECT 1 AS ok FROM d1_migrations WHERE name='0035_version_bound_renders.sql'").first()).toEqual({ok:1});
    const previous=await runtime.DB.prepare('SELECT revision FROM fb_bound_lineage_epoch WHERE id=1').first<{revision:number}>();
    await runtime.DB.exec('DROP TABLE fb_bound_lineage_epoch;');
    try { await expect(legacyMediaPolicyFence(owner)).rejects.toMatchObject({code:'media_policy_unavailable'}); }
    finally {
      await runtime.DB.exec('CREATE TABLE fb_bound_lineage_epoch (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);');
      await runtime.DB.prepare('INSERT INTO fb_bound_lineage_epoch(id,revision) VALUES (1,?)').bind(previous!.revision).run();
    }
  });
  it('keeps the documented compatibility path when migration 0035 is not installed',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const marker=await runtime.DB.prepare("SELECT * FROM d1_migrations WHERE name='0035_version_bound_renders.sql'").first<{id:number;name:string;applied_at:string}>();
    const previous=await runtime.DB.prepare('SELECT revision FROM fb_bound_lineage_epoch WHERE id=1').first<{revision:number}>();
    await runtime.DB.prepare('DELETE FROM d1_migrations WHERE id=?').bind(marker!.id).run();
    await runtime.DB.exec('DROP TABLE fb_bound_lineage_epoch;');
    try { expect(await legacyMediaPolicyFence(owner)).toBeNull(); }
    finally {
      await runtime.DB.exec('CREATE TABLE fb_bound_lineage_epoch (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);');
      await runtime.DB.prepare('INSERT INTO fb_bound_lineage_epoch(id,revision) VALUES (1,?)').bind(previous!.revision).run();
      await runtime.DB.prepare('INSERT INTO d1_migrations(id,name,applied_at) VALUES (?,?,?)').bind(marker!.id,marker!.name,marker!.applied_at).run();
    }
  });
  it('withholds a legacy render if its policy trigger disappears during the object read',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const fixture=await fixturePool(owner);
    await runtime.MEDIA.put('test/render.webp','render');
    const anonymous:Ctx={...owner,user:null,actor:{type:'system',id:'anon',representedUserId:null,label:'Anonymous'},sessionId:null,sessionAssurance:null,accessIdentity:null,accessStatus:null};
    const [name,sql]=BOUND_LINEAGE_TRIGGER_DEFINITIONS[0];let dropped=false;
    const media=new Proxy(runtime.MEDIA,{get(target,key){
      if(key==='get') return async (...args:Parameters<typeof target.get>)=>{
        if(!dropped){dropped=true;await runtime.DB.exec(`DROP TRIGGER "${name}";`);}
        return target.get(...args);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    try {
      expect((await renderResponse(anonymous,media,fixture.renderAsset,{publicOnly:true,request:new Request('https://test.local/')})).status).toBe(404);
      expect(dropped).toBe(true);
    } finally {await runtime.DB.exec(`${sql};`);}
  });
  it('does not serve or publicly cache an asset made members-only during the read',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const fixture=await fixturePool(owner);
    await runtime.MEDIA.put('test/render.webp','render');
    const anonymous:Ctx={...owner,user:null,actor:{type:'system',id:'anon',representedUserId:null,label:'Anonymous'},sessionId:null,sessionAssurance:null,accessIdentity:null,accessStatus:null};
    expect((await serveAsset(anonymous,fixture.renderAsset)).status).toBe(200);
    let changed=false;
    const media=new Proxy(runtime.MEDIA,{get(target,key){
      if(key==='get') return async (...args:Parameters<typeof target.get>)=>{
        if(!changed){changed=true;await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'").run();}
        return target.get(...args);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const result=await serveAsset({...anonymous,media},fixture.renderAsset);
    expect(result.status).toBe(404);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(changed).toBe(true);
  });
  it.each(['membership','session','audience'])('withholds a generic member asset if %s changes during the object read',async(change)=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const player={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const fixture=await fixturePool(owner);
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'"),
      runtime.DB.prepare("UPDATE fb_assets SET access_classification='member' WHERE id=?").bind(fixture.renderAsset),
    ]);
    await runtime.MEDIA.put('test/render.webp','render');
    expect((await serveAsset(player,fixture.renderAsset)).status).toBe(200);
    let revoked=false;
    const media=new Proxy(runtime.MEDIA,{get(target,key){
      if(key==='get') return async (...args:Parameters<typeof target.get>)=>{
        if(!revoked){revoked=true;
          if(change==='membership') await runtime.DB.prepare('UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?').bind(new Date().toISOString(),player.tenant.id,player.user!.id).run();
          else if(change==='session') await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();
          else await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();
        }
        return target.get(...args);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect((await serveAsset({...player,media},fixture.renderAsset)).status).toBe(404);
    expect(revoked).toBe(true);
  });
  it('withholds generic member bytes when the session is revoked at the final principal query',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const player=await withSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'"),
      runtime.DB.prepare("UPDATE fb_assets SET access_classification='member' WHERE id=?").bind(fixture.renderAsset),
    ]);
    await runtime.MEDIA.put('test/render.webp','render');
    let revoked=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.startsWith('SELECT 1 WHERE EXISTS (SELECT 1 FROM fb_memberships'))return statement;
        return new Proxy(statement,{get(stmt,member){
          if(member==='bind') return (...args:unknown[])=>{
            const bound=stmt.bind(...args);return new Proxy(bound,{get(inner,method){
              if(method==='first') return async()=>{
                if(!revoked){revoked=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),player.sessionId).run();}
                return inner.first();
              };
              const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(stmt,member,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect((await serveAsset({...player,db},fixture.renderAsset)).status).toBe(404);
    expect(revoked).toBe(true);
  });
  it('withholds generic member bytes when audience changes just before the final query',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const player=await withSession(await ctxFor('cabinet','player@foilbury.local'));
    const fixture=await fixturePool(owner);
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'"),
      runtime.DB.prepare("UPDATE fb_assets SET access_classification='member' WHERE id=?").bind(fixture.renderAsset),
    ]);
    await runtime.MEDIA.put('test/render.webp','render');
    let changed=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>{
        const statement=target.prepare(sql);
        if(!sql.startsWith('SELECT 1 WHERE EXISTS (SELECT 1 FROM fb_memberships'))return statement;
        return new Proxy(statement,{get(stmt,member){
          if(member==='bind') return (...args:unknown[])=>{
            const bound=stmt.bind(...args);return new Proxy(bound,{get(inner,method){
              if(method==='first') return async()=>{
                if(!changed){changed=true;await target.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();}
                return inner.first();
              };
              const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(stmt,member,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect((await serveAsset({...player,db},fixture.renderAsset)).status).toBe(404);
    expect(changed).toBe(true);
  });
  it.each(['front','back','derivative'])('withholds a legacy %s if membership is revoked during the object read', async(side)=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const player={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const fixture=await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'").run();
    await runtime.MEDIA.put('test/render.webp','render');
    const now=new Date().toISOString();
    if(side==='back') await runtime.DB.prepare(`INSERT INTO fb_variant_back_renders(id,tenant_id,variant_id,recipe_id,asset_id,width,height,sha256,status,created_at,published_at)
      VALUES ('back-test',?,?,?,?,750,1050,'test-hash','published',?,?)`).bind(owner.tenant.id,fixture.variantId,fixture.recipeId,fixture.renderAsset,now,now).run();
    if(side==='derivative') {
      await runtime.MEDIA.put('test/thumb.webp','thumb');
      await runtime.DB.prepare(`INSERT INTO fb_asset_derivatives(id,tenant_id,source_asset_id,size_key,r2_key,mime,width,height,bytes,sha256,status,created_at)
        VALUES ('thumb-test',?,?,'thumb','test/thumb.webp','image/webp',300,420,5,'test-hash','ready',?)`).bind(owner.tenant.id,fixture.renderAsset,now).run();
    }
    const read=(bucket:R2Bucket)=>side==='front' ? renderResponse(player,bucket,fixture.renderAsset,{publicOnly:false,request:new Request('https://test.local/')}) :
      side==='back' ? backRenderResponse({...player,media:bucket},fixture.renderAsset) : derivativeResponse(player,bucket,'thumb-test',new Request('https://test.local/'));
    expect((await read(runtime.MEDIA)).status).toBe(200);
    let audienceChanged=false;
    const changedDb=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>{
        const st=target.prepare(sql);
        if(!sql.startsWith('SELECT 1 FROM fb_') || !sql.includes('fb_bound_lineage_epoch WHERE id=1 AND revision='))return st;
        return new Proxy(st,{get(stmt,member){if(member==='bind')return (...args:unknown[])=>{
          const bound=stmt.bind(...args);return new Proxy(bound,{get(inner,method){if(method==='first')return async()=>{
            if(!audienceChanged){audienceChanged=true;await target.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run();}
            return inner.first();
          };const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;}});
        };const value=Reflect.get(stmt,member,stmt);return typeof value==='function'?value.bind(stmt):value;}});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const changedPlayer={...player,db:changedDb};
    const changedResult=side==='front' ? await renderResponse(changedPlayer,runtime.MEDIA,fixture.renderAsset,{publicOnly:false,request:new Request('https://test.local/')}) :
      side==='back' ? await backRenderResponse(changedPlayer,fixture.renderAsset) : await derivativeResponse(changedPlayer,runtime.MEDIA,'thumb-test',new Request('https://test.local/'));
    expect(changedResult.status).toBe(404);
    expect(audienceChanged).toBe(true);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'").run();
    let revoked=false;
    const media=new Proxy(runtime.MEDIA,{get(target,key){
      if(key==='get') return async (...args:Parameters<typeof target.get>)=>{
        if(!revoked){revoked=true;await runtime.DB.prepare('UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?').bind(new Date().toISOString(),player.tenant.id,player.user!.id).run();}
        return target.get(...args);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect((await read(media)).status).toBe(404);
    expect(revoked).toBe(true);
  });
  it("returns no-store 404 for missing objects without hiding storage failures", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const anonymous: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    await runtime.DB.prepare("UPDATE fb_assets SET access_classification='public', visibility='public_export', processing_state='ready' WHERE id=?").bind(fixture.renderAsset).run();
    const missingMedia = { ...owner.media, get: async () => null } as unknown as R2Bucket;
    const missing = await serveAsset({ ...anonymous, media: missingMedia }, fixture.renderAsset);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.text()).toBe("Not found");
    const unknown = await serveAsset(anonymous, "missing-asset");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("Not found");
    const unavailableMedia = { ...owner.media, get: async () => { throw new Error("storage unavailable"); } } as unknown as R2Bucket;
    await expect(serveAsset({ ...anonymous, media: unavailableMedia }, fixture.renderAsset)).rejects.toThrow("storage unavailable");
  });
  it("rechecks current card audience for public-labelled subject and saved render", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const anonymous: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    await runtime.DB.prepare("UPDATE fb_assets SET access_classification = 'public', visibility = 'public_export', processing_state = 'ready' WHERE id IN (?, ?)").bind(fixture.subjectAsset, fixture.renderAsset).run();
    await runtime.MEDIA.put("test/subject.png", "subject");
    await runtime.MEDIA.put("test/render.webp", "render");
    expect((await serveAsset(anonymous, fixture.subjectAsset)).status).toBe(200);
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'members' WHERE id = 'col_test_public'").run();
    expect((await serveAsset(anonymous, fixture.subjectAsset)).status).toBe(404);
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(404);
    const memberResponse = await serveAsset(await withSession(owner), fixture.renderAsset);
    expect(memberResponse.status).toBe(200);
    expect(memberResponse.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not publish an unlinked render merely because its asset label is public", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const anonymous: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    await runtime.DB.prepare("DELETE FROM fb_variant_renders WHERE asset_id = ?").bind(fixture.renderAsset).run();
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(404);
  });

  it("rechecks a card back linked directly from the card", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const anonymous: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    await runtime.DB.prepare("UPDATE fb_card_definitions SET card_back_asset_id = ? WHERE id = ?").bind(fixture.renderAsset, fixture.cardId).run();
    await runtime.DB.prepare("DELETE FROM fb_variant_renders WHERE asset_id = ?").bind(fixture.renderAsset).run();
    await runtime.MEDIA.put("test/render.webp", "render");
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'members' WHERE id = 'col_test_public'").run();
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(404);
  });

  it("fails closed for source assets with dependent renditions or unknown dependencies", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const anonymous: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    await runtime.DB.prepare("UPDATE fb_assets SET access_classification = 'public', visibility = 'public_export' WHERE id = ?").bind(fixture.subjectAsset).run();
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = ? WHERE id = ?").bind(JSON.stringify([fixture.subjectAsset]), fixture.renderAsset).run();
    expect((await serveAsset(anonymous, fixture.subjectAsset)).status).toBe(404);
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = 'invalid' WHERE id = ?").bind(fixture.renderAsset).run();
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(404);
  });

  it("does not expose draft proposal artwork through a public card", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const anonymous: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    const now = new Date().toISOString();
    await runtime.DB.prepare(`INSERT INTO fb_print_proposals
      (id, tenant_id, card_id, print_number, print_key, role, title, creative_direction, source_asset_id, status, created_by, created_at, updated_at)
      VALUES ('proposal_test', ?, ?, '1', 'test-proposal', 'portrait', 'Draft', 'Draft', ?, 'draft', ?, ?, ?)`)
      .bind(owner.tenant.id, fixture.cardId, fixture.renderAsset, owner.user!.id, now, now).run();
    expect((await serveAsset(anonymous, fixture.renderAsset)).status).toBe(404);
  });

  it("rechecks live content grants rather than trusting a cached editor role", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    await runtime.DB.prepare("DELETE FROM fb_variant_renders WHERE asset_id = ?").bind(fixture.renderAsset).run();
    await runtime.MEDIA.put("test/render.webp", "render");
    const user = await createUser(runtime.DB, { email: "editor-live@example.test", displayName: "Editor", password: "a-long-test-password" });
    await addMembership(runtime.DB, owner.tenant.id, user.id, "editor", { capabilities: ["content"] });
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at) VALUES ('admin_live_test', ?, ?, 'admin', '[\"content\"]', 'active', ?)").bind(bot!.id, user.id, new Date().toISOString()).run();
    const editor: Ctx = await withSession({ ...owner, user: { ...owner.user!, id: user.id, email: user.email, role: "editor", platformAdmin: false, capabilities: ["content"] }, actor: { type: "user", id: user.id, representedUserId: user.id, label: "Editor" }, sessionId: null });
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"economy\"]' WHERE id = 'admin_live_test'").run();
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"content\"]', status = 'revoked', revoked_at = ? WHERE id = 'admin_live_test'").bind(new Date().toISOString()).run();
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET status = 'active', revoked_at = NULL WHERE id = 'admin_live_test'").run();
    await runtime.DB.prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?").bind(new Date().toISOString(), owner.tenant.id, user.id).run();
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(404);
  });

  it("limits scoped collection admin previews to every linked global collection and revokes them live", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const user = await createUser(runtime.DB, { email: "scoped-preview@example.test", displayName: "Scoped", password: "a-long-test-password" });
    await addMembership(runtime.DB, owner.tenant.id, user.id, "player");
    const now = new Date().toISOString();
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'private' WHERE id = 'col_test_public'").run();
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id, user_id, role, scopes_json, status, granted_by, granted_at, reason) VALUES ('scoped_asset', ?, 'global_collection_admin', ?, 'active', ?, ?, 'test')")
      .bind(user.id, JSON.stringify({ all: false, collectionIds: ["col_test_public"] }), owner.user!.id, now).run();
    await runtime.MEDIA.put("test/subject.png", "subject");
    const scoped: Ctx = await withSession({ ...owner, user: { ...owner.user!, id: user.id, email: user.email, role: "player", platformAdmin: false, globalCollectionScope: { all: false, collectionIds: ["col_test_public"] } }, actor: { type: "user", id: user.id, representedUserId: user.id, label: "Scoped" }, sessionId: null });
    const response = await serveAsset(scoped, fixture.subjectAsset);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await runtime.DB.prepare("INSERT INTO fb_collections (id, slug, name, description, scope, owner_tenant_id, accent, status, view_audience, created_by, created_at, updated_at) VALUES ('other_scope', 'other-scope', 'Other', 'Other', 'global', ?, 'brass', 'published', 'private', 'test', ?, ?)").bind(owner.tenant.id, now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at) VALUES ('other_scope', ?, ?, 0, 'test', ?)").bind(fixture.cardId, owner.tenant.id, now).run();
    expect((await serveAsset(scoped, fixture.subjectAsset)).status).toBe(404);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id = 'other_scope'").run();
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET status = 'revoked', revoked_at = ? WHERE id = 'scoped_asset'").bind(now).run();
    expect((await serveAsset(scoped, fixture.subjectAsset)).status).toBe(404);
  });

  it("removes private-media admin access when content is revoked while membership remains active", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'private' WHERE id = 'col_test_public'").run();
    await runtime.MEDIA.put("test/render.webp", "render");
    const user = await createUser(runtime.DB, { email: "revoked-media@example.test", displayName: "Editor", password: "a-long-test-password" });
    await addMembership(runtime.DB, owner.tenant.id, user.id, "editor", { capabilities: ["content"] });
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{ id: string }>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('private_media_admin',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id, user.id, new Date().toISOString()).run();
    const initialEditor: Ctx = { ...owner, user: { ...owner.user!, id: user.id, email: user.email, role: "editor", platformAdmin: false, capabilities: ["content"] }, actor: { type: "user", id: user.id, representedUserId: user.id, label: "Editor" }, sessionId: null };
    const editorSession = await createSession(runtime.DB, owner.tenant, initialEditor.user!, {authMethod:'magic_link',assurance:'email'});
    const editor: Ctx = {...initialEditor, sessionId:(await resolveSession(runtime.DB,editorSession.token))!.sessionId};
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(200);
    const render = () => renderResponse(editor, runtime.MEDIA, fixture.renderAsset, { publicOnly: false, request: new Request("https://test.local/") });
    expect((await render()).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"economy\"]' WHERE id = 'private_media_admin'").run();
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(404);
    expect((await render()).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"content\"]', status = 'revoked', revoked_at = ? WHERE id = 'private_media_admin'").bind(new Date().toISOString()).run();
    expect((await serveAsset(editor, fixture.renderAsset)).status).toBe(404);
    expect((await render()).status).toBe(404);
  });
});
