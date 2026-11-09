import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { backRenderResponse, derivativeResponse, renderResponse } from "../../src/server/modules/media";
import type { Ctx } from "../../src/server/context";
import { addMembership, createSession, createUser } from "../../src/server/modules/identity";
import { resolveSession } from '../../src/server/context';

describe("shared media audiences", () => {
  it('checks every collection use beyond sixteen without widening a private use',async()=>{
    await bootstrap();
    const owner=await ctxFor('cabinet','owner@foilbury.local');
    const base=await ctxFor('cabinet','player@foilbury.local');
    const session=await createSession(base.db,base.tenant,base.user!,{authMethod:'magic_link',assurance:'email'});
    const member={...base,sessionId:(await resolveSession(base.db,session.token))!.sessionId};
    const f=await fixturePool(owner),now=new Date().toISOString();
    await runtime.MEDIA.put('test/render.webp','render');
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<17)
      INSERT INTO fb_collections(id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,logo_asset_id,created_by,created_at,updated_at)
      SELECT 'reuse_col_'||i,'reuse-col-'||i,'Reuse '||i,'','global',?,'brass','published','members',?,'test',?,? FROM n`).bind(owner.tenant.id,f.renderAsset,now,now).run();
    const read=()=>renderResponse(member,runtime.MEDIA,f.renderAsset,{publicOnly:false,request:new Request('https://test.local/')});
    expect((await read()).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='reuse_col_17'").run();
    expect((await read()).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='members' WHERE id='reuse_col_17'").run();
    await runtime.DB.prepare("UPDATE fb_collections SET archived_at=? WHERE id='reuse_col_17'").bind(now).run();
    expect((await read()).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_collections SET archived_at=NULL WHERE id='reuse_col_17'").run();
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 18 UNION ALL SELECT i+1 FROM n WHERE i<256)
      INSERT INTO fb_collections(id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,logo_asset_id,created_by,created_at,updated_at)
      SELECT 'reuse_col_'||i,'reuse-col-'||i,'Reuse '||i,'','global',?,'brass','published','members',?,'test',?,? FROM n`).bind(owner.tenant.id,f.renderAsset,now,now).run();
    let statements=0;
    const countedDb=new Proxy(runtime.DB,{get(target,key){
      if(key==='prepare')return (...args:Parameters<D1Database['prepare']>)=>{statements++;return target.prepare(...args);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    expect((await renderResponse({...member,db:countedDb},runtime.MEDIA,f.renderAsset,{publicOnly:false,request:new Request('https://test.local/')})).status).toBe(200);
    expect(statements).toBeLessThanOrEqual(45);
    await runtime.DB.prepare("INSERT INTO fb_collections(id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,logo_asset_id,created_by,created_at,updated_at) VALUES ('reuse_col_257','reuse-col-257','Reuse 257','','global',?,'brass','published','members',?,'test',?,?)").bind(owner.tenant.id,f.renderAsset,now,now).run();
    expect((await read()).status).toBe(404);
  });
  it("requires access to every card using the same front, back and derivative", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(owner);
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,subtitle,description,status,created_at,updated_at,version) VALUES ('card_shared',?,'shared','shared','Shared','','','published',?,?,1)").bind(owner.tenant.id, now, now),
      runtime.DB.prepare("INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,recipe_id,status,created_at) VALUES ('edition_shared',?,'card_shared','Shared',?,?,'published',?)").bind(owner.tenant.id, f.subjectAsset, f.recipeId, now),
      runtime.DB.prepare("INSERT INTO fb_variants (id,tenant_id,card_id,edition_id,material_id,effect_id,name,status,created_at) SELECT 'variant_shared',tenant_id,'card_shared','edition_shared',material_id,effect_id,'Plain','published',? FROM fb_variants WHERE id = ?").bind(now, f.variantId),
      runtime.DB.prepare("INSERT INTO fb_collections (id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('members_shared','members-shared','Members','','global',?,'brass','published','members','test',?,?)").bind(owner.tenant.id, now, now),
      runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('members_shared','card_shared',?,0,'test',?)").bind(owner.tenant.id, now),
      runtime.DB.prepare("INSERT INTO fb_variant_renders (id,tenant_id,variant_id,recipe_id,asset_id,public_url,width,height,sha256,status,created_at,published_at) VALUES ('vr_shared',?,'variant_shared',?,?,'/media/render/shared',750,1050,'hash','published',?,?)").bind(owner.tenant.id, f.recipeId, f.renderAsset, now, now),
      runtime.DB.prepare("INSERT INTO fb_variant_back_renders (id,tenant_id,variant_id,recipe_id,asset_id,width,height,sha256,status,created_at,published_at) VALUES ('back_public',?,?,?, ?,750,1050,'hash','published',?,?)").bind(owner.tenant.id, f.variantId, f.recipeId, f.renderAsset, now, now),
      runtime.DB.prepare("INSERT INTO fb_variant_back_renders (id,tenant_id,variant_id,recipe_id,asset_id,width,height,sha256,status,created_at,published_at) VALUES ('back_shared',?,'variant_shared',?, ?,750,1050,'hash','published',?,?)").bind(owner.tenant.id, f.recipeId, f.renderAsset, now, now),
      runtime.DB.prepare("INSERT INTO fb_asset_derivatives (id,tenant_id,source_asset_id,size_key,r2_key,mime,width,height,bytes,sha256,status,created_at) VALUES ('derivative_shared',?,?,'thumb','test/thumb.webp','image/webp',1,1,4,'hash','ready',?)").bind(owner.tenant.id, f.renderAsset, now),
    ]);
    await runtime.MEDIA.put("test/render.webp", "front");
    await runtime.MEDIA.put("test/thumb.webp", "thumb");
    const anon: Ctx = { ...owner, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    const user = await createUser(runtime.DB, { email: "media-member@example.test", displayName: "Member", password: "a-long-test-password" });
    await addMembership(runtime.DB, owner.tenant.id, user.id, "player");
    const initialMember: Ctx = { ...owner, user: { ...owner.user!, id: user.id, email: user.email, role: "player", platformAdmin: false, capabilities: [] }, actor: { type: "user", id: user.id, representedUserId: user.id, label: "Member" }, sessionId: null };
    const memberSession=await createSession(runtime.DB,owner.tenant,initialMember.user!,{authMethod:'magic_link',assurance:'email'});
    const member: Ctx={...initialMember,sessionId:(await resolveSession(runtime.DB,memberSession.token))!.sessionId};
    const request = new Request("https://test.local/");
    expect((await renderResponse(anon, runtime.MEDIA, f.renderAsset, { publicOnly: false, request })).status).toBe(404);
    expect((await backRenderResponse(anon, f.renderAsset)).status).toBe(404);
    expect((await derivativeResponse(anon, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    for (const response of [
      await renderResponse(member, runtime.MEDIA, f.renderAsset, { publicOnly: false, request }),
      await backRenderResponse(member, f.renderAsset),
      await derivativeResponse(member, runtime.MEDIA, "derivative_shared", request),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect((await renderResponse(owner, runtime.MEDIA, f.renderAsset, { publicOnly: true, request })).status).toBe(404);
    // A saved derivative may inherit the same source audience without making
    // legitimate member thumbnails unavailable.
    await runtime.DB.prepare("INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,derivative_of_asset_id,created_at) VALUES ('pure_derivative',?,'render','Thumb','image/webp',1,1,4,'test/derived.webp','derived','private',?,?)").bind(owner.tenant.id, f.renderAsset, now).run();
    expect((await derivativeResponse(member, runtime.MEDIA, "derivative_shared", request)).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = 'malformed' WHERE id = 'pure_derivative'").run();
    expect((await derivativeResponse(member, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = '[]' WHERE id = 'pure_derivative'").run();
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = '[\"pure_derivative\"]' WHERE id = ?").bind(f.renderAsset).run();
    expect((await derivativeResponse(member, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = '[]' WHERE id = ?").bind(f.renderAsset).run();
    // Isolated local query-count measurement; no production or visual claim.
    let calls = 0;
    const countedDb = new Proxy(runtime.DB, { get(target, property) {
      if (property === "prepare") return (...args: Parameters<D1Database["prepare"]>) => { calls++; return target.prepare(...args); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const measured: Ctx = { ...member, db: countedDb };
    for (const total of [1, 10, 30]) {
      for (let i = total === 1 ? 1 : total === 10 ? 1 : 10; i < total; i++) {
        await runtime.DB.prepare("INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,derivative_of_asset_id,created_at) VALUES (?,?,'render','Thumb','image/webp',1,1,4,?,?,'private',?,?)")
          .bind(`bench_${i}`, owner.tenant.id, `test/bench_${i}.webp`, `hash_${i}`, f.renderAsset, now).run();
      }
      calls = 0;
      const start = performance.now();
      const measuredResponse = await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request);
      expect(measuredResponse.status).toBe(200);
      console.log(`MEDIA_GRAPH_LOCAL nodes=${total + 1} statements=${calls} elapsed_ms=${Math.round(performance.now() - start)}`);
    }
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 30 UNION ALL SELECT i + 1 FROM n WHERE i < 254)
      INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,derivative_of_asset_id,created_at)
      SELECT 'bench_limit_' || i, ?, 'render','Thumb','image/webp',1,1,4,'test/limit_' || i,'limit_' || i,'private',?,? FROM n`).bind(owner.tenant.id, f.renderAsset, now).run();
    calls = 0;
    const limitStart = performance.now();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(200);
    console.log(`MEDIA_GRAPH_LOCAL nodes=256 statements=${calls} elapsed_ms=${Math.round(performance.now() - limitStart)}`);
    await runtime.DB.prepare("INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,derivative_of_asset_id,created_at) VALUES ('bench_limit_255',?,'render','Thumb','image/webp',1,1,4,'test/limit_255','limit_255','private',?,?)").bind(owner.tenant.id, f.renderAsset, now).run();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    await runtime.DB.prepare("DELETE FROM fb_assets WHERE id LIKE 'bench_limit_%'").run();
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 32)
      INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,derivative_of_asset_id,created_at)
      SELECT 'bench_chain_' || i, ?, 'render','Thumb','image/webp',1,1,4,'test/chain_' || i,'chain_' || i,'private',CASE WHEN i = 1 THEN ? ELSE 'bench_chain_' || (i - 1) END,? FROM n`).bind(owner.tenant.id, f.renderAsset, now).run();
    calls = 0;
    const chainStart = performance.now();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    console.log(`MEDIA_GRAPH_LOCAL chain_edges=32 statements=${calls} elapsed_ms=${Math.round(performance.now() - chainStart)} verdict=blocked`);
    await runtime.DB.prepare("DELETE FROM fb_assets WHERE id LIKE 'bench_chain_%'").run();
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 14)
      INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,card_back_asset_id,created_at,updated_at)
      SELECT 'many_card_' || i, ?, 'many:' || i, 'many-' || i, 'Many ' || i, 'fixture', 'published', ?, ?, ? FROM n`).bind(owner.tenant.id, f.renderAsset, now, now).run();
    calls = 0;
    const reuseStart = performance.now();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(200);
    console.log(`MEDIA_GRAPH_LOCAL linked_cards=16 statements=${calls} elapsed_ms=${Math.round(performance.now() - reuseStart)} verdict=allowed`);
    await runtime.DB.prepare("INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,card_back_asset_id,created_at,updated_at) VALUES ('many_card_15',?,'many:15','many-15','Many 15','fixture','published',?,?,?)").bind(owner.tenant.id, f.renderAsset, now, now).run();
    calls = 0;
    const expandedStart = performance.now();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(200);
    console.log(`MEDIA_GRAPH_LOCAL linked_cards=17 statements=${calls} elapsed_ms=${Math.round(performance.now() - expandedStart)} verdict=allowed`);
    await runtime.DB.prepare("INSERT INTO fb_collections(id,slug,name,description,scope,owner_tenant_id,accent,status,view_audience,created_by,created_at,updated_at) VALUES ('many_private','many-private','Private','','global',?,'brass','published','private','test',?,?)").bind(owner.tenant.id,now,now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards(collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('many_private','many_card_15',?,0,'test',?)").bind(owner.tenant.id,now).run();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    await runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id='many_private'").run();
    await runtime.DB.prepare("DELETE FROM fb_collections WHERE id='many_private'").run();
    await runtime.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 16 UNION ALL SELECT i + 1 FROM n WHERE i < 254)
      INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,card_back_asset_id,created_at,updated_at)
      SELECT 'many_card_' || i, ?, 'many:' || i, 'many-' || i, 'Many ' || i, 'fixture', 'published', ?, ?, ? FROM n`).bind(owner.tenant.id, f.renderAsset, now, now).run();
    calls = 0;
    const manyStart = performance.now();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(200);
    console.log(`MEDIA_GRAPH_LOCAL linked_cards=256 statements=${calls} elapsed_ms=${Math.round(performance.now() - manyStart)} verdict=allowed`);
    await runtime.DB.prepare("INSERT INTO fb_card_definitions(id,tenant_id,logical_id,slug,name,description,status,card_back_asset_id,created_at,updated_at) VALUES ('many_card_255',?,'many:255','many-255','Many 255','fixture','published',?,?,?)").bind(owner.tenant.id,f.renderAsset,now,now).run();
    expect((await derivativeResponse(measured, runtime.MEDIA, "derivative_shared", request)).status).toBe(404);
    await runtime.DB.prepare("DELETE FROM fb_card_definitions WHERE id LIKE 'many_card_%'").run();
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'public', public_approved_at = ? WHERE id = 'members_shared'").bind(now).run();
    for (const response of [
      await renderResponse(anon, runtime.MEDIA, f.renderAsset, { publicOnly: true, request }),
      await backRenderResponse(anon, f.renderAsset),
      await derivativeResponse(anon, runtime.MEDIA, "derivative_shared", request),
    ]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toMatch(/^public/);
    }
    // The front now belongs only to the public card, but its recorded input
    // belongs to the member card. Its ancestry must keep the bytes private.
    await runtime.DB.prepare("INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,created_at) VALUES ('secret_input',?,'subject','Secret','image/png',1,1,4,'test/secret.png','secret','private',?)").bind(owner.tenant.id, now).run();
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET subject_asset_id = 'secret_input' WHERE id = 'edition_shared'").run();
    await runtime.DB.prepare("DELETE FROM fb_variant_renders WHERE id = 'vr_shared'").run();
    await runtime.DB.prepare("DELETE FROM fb_variant_back_renders WHERE id = 'back_shared'").run();
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'members' WHERE id = 'members_shared'").run();
    await runtime.DB.prepare("UPDATE fb_assets SET dependencies_json = '[\"secret_input\"]' WHERE id = ?").bind(f.renderAsset).run();
    expect((await renderResponse(anon, runtime.MEDIA, f.renderAsset, { publicOnly: false, request })).status).toBe(404);
    const memberFront = await renderResponse(member, runtime.MEDIA, f.renderAsset, { publicOnly: false, request });
    expect(memberFront.status).toBe(200);
    expect(memberFront.headers.get("cache-control")).toBe("private, no-store");
    const staleAdmin: Ctx = { ...anon, user: { ...member.user!, platformAdmin: true, role: "editor", globalCollectionScope: { all: true, collectionIds: [] } }, actor: member.actor };
    await runtime.DB.prepare("UPDATE fb_memberships SET status = 'revoked', revoked_at = ? WHERE tenant_id = ? AND user_id = ?").bind(now, owner.tenant.id, user.id).run();
    expect((await renderResponse(staleAdmin, runtime.MEDIA, f.renderAsset, { publicOnly: false, request })).status).toBe(404);
  });
});
