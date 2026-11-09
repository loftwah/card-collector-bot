import { describe,it,expect } from 'vitest';
import { bootstrap,ctxFor,fixturePool,runtime } from './helpers';
import { legacyBrandUrlFence,reconcileBrandUrlIndex,startBrandUrlRebuild,listBrandUrlIssues,clearBrandUrlIssue,createCollection,updateCollection } from '../../src/server/modules/collections';
import { routeApi } from '../../src/server/api/router';
import { nowIso } from '../../src/server/db';

async function owner(){const ctx=await ctxFor('cabinet','owner@foilbury.local'),id=`index-session-${crypto.randomUUID()}`,now=nowIso();await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};}

describe('collection brand URL index',()=>{
  it('keeps pre-0034 collection creation working and rolls back a partial index schema',async()=>{
    await bootstrap();let ctx=await owner();
    await runtime.DB.exec('DROP TRIGGER fb_brand_urls_insert; DROP TRIGGER fb_brand_urls_update; DROP TRIGGER fb_brand_urls_delete; DROP TABLE fb_brand_url_refs; DROP TABLE fb_brand_url_dirty;');
    const legacy=await createCollection(ctx,{scope:'bot',name:'Legacy schema',slug:'legacy-index-schema'});expect(legacy.slug).toBe('legacy-index-schema');
    await bootstrap();ctx=await owner();await runtime.DB.exec('DROP TABLE fb_brand_url_refs;');
    await expect(createCollection(ctx,{scope:'bot',name:'Partial schema',slug:'partial-index-schema'})).rejects.toThrow();
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_collections WHERE slug='partial-index-schema'").first<{n:number}>())?.n).toBe(0);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='collection.created' AND json_extract(metadata_json,'$.slug')='partial-index-schema'").first<{n:number}>())?.n).toBe(0);
  });
  it('indexes ordinary application writes atomically and leaves external races dirty',async()=>{
    await bootstrap();const ctx=await owner();await reconcileBrandUrlIndex(ctx);
    const collection=await createCollection(ctx,{scope:'bot',name:'Inline index',slug:'inline-index',logoUrl:'/brand/logo.svg'});
    expect(await runtime.DB.prepare('SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id=?').bind(collection.id).first()).toBeNull();
    await updateCollection(ctx,collection.id,{bannerUrl:'/brand/cover.svg'});
    expect(await runtime.DB.prepare('SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id=?').bind(collection.id).first()).toBeNull();
    let injected=false;const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;await target.prepare("UPDATE fb_collections SET banner_url='/external/new.svg' WHERE id=?").bind(collection.id).run();}return target.batch(statements);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await updateCollection({...ctx,db},collection.id,{description:'Updated after an external URL change'});
    expect((await runtime.DB.prepare('SELECT banner_url FROM fb_collections WHERE id=?').bind(collection.id).first<{banner_url:string}>())?.banner_url).toBe('/external/new.svg');
    expect(await runtime.DB.prepare('SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id=?').bind(collection.id).first()).toBeTruthy();
  });
  it('indexes the correct final tuple when an external URL changes and returns before the batch',async()=>{
    await bootstrap();const ctx=await owner();await reconcileBrandUrlIndex(ctx);
    const collection=await createCollection(ctx,{scope:'bot',name:'ABA index',slug:'aba-index',logoUrl:'/brand/original.svg'});let injected=false;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;await target.prepare("UPDATE fb_collections SET logo_url='/brand/temporary.svg' WHERE id=?").bind(collection.id).run();await target.prepare("UPDATE fb_collections SET logo_url='/brand/original.svg' WHERE id=?").bind(collection.id).run();}return target.batch(statements);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await updateCollection({...ctx,db},collection.id,{description:'Final tuple is unchanged'});
    expect((await runtime.DB.prepare('SELECT logo_url FROM fb_collections WHERE id=?').bind(collection.id).first<{logo_url:string}>())?.logo_url).toBe('/brand/original.svg');
    expect(await runtime.DB.prepare('SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id=?').bind(collection.id).first()).toBeNull();
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_brand_url_refs WHERE collection_id=?').bind(collection.id).first<{n:number}>())?.n).toBe(0);
  });
  it('batches issue-identity checks for one and sixty-four collections',async()=>{
    await bootstrap();const ctx=await owner(),fixture=await fixturePool(ctx),now=nowIso();
    await runtime.DB.prepare("UPDATE fb_assets SET r2_key='collection-brand-v1/fixture' WHERE id=?").bind(fixture.renderAsset).run();
    const insert=(i:number)=>runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,logo_url,banner_url,back_url,created_by,created_at,updated_at) VALUES(?,?,?,'bot',?,?,?,?,?,?,?)`)
      .bind(`aaa-measure-${String(i).padStart(3,'0')}`,`measure-${i}`,`Measure ${i}`,ctx.tenant.id,`/media/asset/${fixture.renderAsset}`,`/media/asset/${fixture.renderAsset}`,`/media/asset/${fixture.renderAsset}`,ctx.user!.id,now,now);
    await insert(0).run();
    let queries=0;const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='prepare')return (sql:string)=>{queries++;return target.prepare(sql);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    const one=await listBrandUrlIssues({...ctx,db});expect(one.items.filter(x=>x.collectionId==='aaa-measure-000')).toHaveLength(3);expect(queries).toBe(4);
    await runtime.DB.batch(Array.from({length:63},(_,i)=>insert(i+1)));
    queries=0;const many=await listBrandUrlIssues({...ctx,db});expect(many.items.filter(x=>x.collectionId.startsWith('aaa-measure-'))).toHaveLength(192);expect(queries).toBe(4);
  });
  it('requires a current human Super Admin and retains dirty work on session revocation',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,created_by,created_at,updated_at) VALUES('index-auth','index-auth','Auth','bot',?,?,?,?)`).bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    const agent={...ctx,actor:{type:'agent' as const,id:'agent',representedUserId:ctx.user!.id,label:'Agent'}};
    await expect(reconcileBrandUrlIndex(agent)).rejects.toMatchObject({code:'human_public_approval_required'});
    let revoked=false;const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{if(!revoked){revoked=true;await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),ctx.sessionId).run();}return target.batch(statements);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(reconcileBrandUrlIndex({...ctx,db})).rejects.toThrow();
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='index-auth'").first()).toBeTruthy();
  });
  it('reconciles more than 1,024 unrelated and malformed URLs in bounded passes without rewriting them',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();
    for(let start=0;start<1050;start+=50){const statements=[];for(let i=start;i<Math.min(start+50,1050);i++)statements.push(runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,logo_url,created_by,created_at,updated_at) VALUES(?,?,?,'bot',?,?,?,?,?)`).bind(`index-${i}`,`index-${i}`,`Index ${i}`,ctx.tenant.id,i===0?'/unrelated%ZZ':`https://example.test/unrelated%20${i}`,ctx.user!.id,now,now));await runtime.DB.batch(statements);}
    const before=(await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_brand_url_dirty').first<{n:number}>())!.n;
    await expect(legacyBrandUrlFence(ctx,'ast_target')).rejects.toMatchObject({code:'brand_reference_reconciling'});
    expect((await runtime.DB.prepare('SELECT COUNT(*) n FROM fb_brand_url_dirty').first<{n:number}>())!.n).toBe(before);
    let complete=false,passes=0;
    while(!complete && passes<25){passes++;const result=await reconcileBrandUrlIndex(ctx);expect(result.processed).toBeLessThanOrEqual(64);complete=result.remaining===0;}
    expect(complete).toBe(true);expect(passes).toBeGreaterThan(1);
    const clean=await legacyBrandUrlFence(ctx,'ast_target');expect((await runtime.DB.prepare(`SELECT CASE WHEN ${clean.sql} THEN 1 ELSE 0 END AS ok`).bind(...clean.args).first<{ok:number}>())?.ok).toBe(1);
    expect((await runtime.DB.prepare("SELECT logo_url FROM fb_collections WHERE id='index-0'").first<{logo_url:string}>())?.logo_url).toBe('/unrelated%ZZ');
    await runtime.DB.prepare("UPDATE fb_collections SET back_url='/%6dedia/asset/ast_target?x=1' WHERE id='index-0'").run();
    await reconcileBrandUrlIndex(ctx);
    const blocked=await legacyBrandUrlFence(ctx,'ast_target');
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${blocked.sql} THEN 1 ELSE 0 END AS ok`).bind(...blocked.args).first<{ok:number}>())?.ok).toBe(0);
  });
  it('rejects a URL changed between reading and index commit, then safely reconciles it',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,logo_url,created_by,created_at,updated_at) VALUES('index-race','index-race','Race','bot',?,'/old',?,?,?)`).bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    let injected=false;const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{if(!injected){injected=true;await target.prepare("UPDATE fb_collections SET logo_url='/%6dedia/asset/ast_target' WHERE id='index-race'").run();}return target.batch(statements);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(reconcileBrandUrlIndex({...ctx,db})).rejects.toThrow();
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='index-race'").first()).toBeTruthy();
    await reconcileBrandUrlIndex(ctx);const fence=await legacyBrandUrlFence(ctx,'ast_target');
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS ok`).bind(...fence.args).first<{ok:number}>())?.ok).toBe(0);
  });
  it('does not block an unrelated asset for a bounded dirty row, but detects a relevant alias and stays read-only',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();await reconcileBrandUrlIndex(ctx);
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,logo_url,created_by,created_at,updated_at) VALUES('dirty-unrelated','dirty-unrelated','Unrelated','bot',?,'/unrelated%20image',?,?,?)`).bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    const fence=await legacyBrandUrlFence(ctx,'ast_target');
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS ok`).bind(...fence.args).first<{ok:number}>())?.ok).toBe(1);
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='dirty-unrelated'").first()).toBeTruthy();
    await runtime.DB.prepare("UPDATE fb_collections SET logo_url='/another-unrelated' WHERE id='dirty-unrelated'").run();
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS ok`).bind(...fence.args).first<{ok:number}>())?.ok).toBe(0);
    await runtime.DB.prepare("UPDATE fb_collections SET logo_url='/%256dedia/asset/ast_target' WHERE id='dirty-unrelated'").run();
    await expect(legacyBrandUrlFence(ctx,'ast_target')).rejects.toMatchObject({code:'brand_reference_ambiguous'});
  });
  it('fails closed if a required index trigger or table is missing',async()=>{
    await bootstrap();const ctx=await owner();await reconcileBrandUrlIndex(ctx);
    const fence=await legacyBrandUrlFence(ctx,'ast_target');
    await runtime.DB.exec('DROP TRIGGER fb_brand_urls_update;');
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS ok`).bind(...fence.args).first<{ok:number}>())?.ok).toBe(0);
    await expect(legacyBrandUrlFence(ctx,'ast_target')).rejects.toMatchObject({code:'brand_index_unavailable'});
    await bootstrap();const again=await owner();await runtime.DB.exec('DROP TABLE fb_brand_url_corrections;');
    await expect(legacyBrandUrlFence(again,'ast_target')).rejects.toMatchObject({code:'brand_index_unavailable'});
  });
  it('explicitly starts and audits a full reindex after writes during a repaired trigger gap',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,back_url,created_by,created_at,updated_at) VALUES('trigger-gap','trigger-gap','Gap','bot',?,'/ordinary',?,?,?)`).bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    await reconcileBrandUrlIndex(ctx);
    const trigger=await runtime.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='fb_brand_urls_update'").first<{sql:string}>();
    await runtime.DB.exec('DROP TRIGGER fb_brand_urls_update;');
    const alias='/%256dedia/asset/ast_target';
    await runtime.DB.prepare("UPDATE fb_collections SET back_url=? WHERE id='trigger-gap'").bind(alias).run();
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='trigger-gap'").first()).toBeNull();
    await runtime.DB.prepare(trigger!.sql).run();
    await startBrandUrlRebuild(ctx);
    const pending=await legacyBrandUrlFence(ctx,'ast_other');
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${pending.sql} THEN 1 ELSE 0 END AS ok`).bind(...pending.args).first<{ok:number}>())?.ok).toBe(0);
    const updatedAlias='/%6dedia/asset/ast_target?during=rebuild';
    await runtime.DB.prepare("UPDATE fb_collections SET back_url=? WHERE id='trigger-gap'").bind(updatedAlias).run();
    const result=await reconcileBrandUrlIndex(ctx);expect(result.remaining).toBe(0);expect(result.rebuilding).toBe(false);
    const fence=await legacyBrandUrlFence(ctx,'ast_target');
    expect((await runtime.DB.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS ok`).bind(...fence.args).first<{ok:number}>())?.ok).toBe(0);
    expect((await runtime.DB.prepare("SELECT back_url FROM fb_collections WHERE id='trigger-gap'").first<{back_url:string}>())?.back_url).toBe(updatedAlias);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='collection.brand_index_rebuild_started'").first<{n:number}>())?.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='collection.brand_index_rebuild_completed'").first<{n:number}>())?.n).toBe(1);
  });
  it('does not mark a rebuild complete if a URL changes at the completion boundary',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,back_url,created_by,created_at,updated_at) VALUES('rebuild-race','rebuild-race','Race','bot',?,'/ordinary',?,?,?)`).bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    await startBrandUrlRebuild(ctx);let batches=0;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{batches++;if(batches===2)await target.prepare("UPDATE fb_collections SET back_url='/media/asset/ast_target' WHERE id='rebuild-race'").run();return target.batch(statements);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    const firstPass=await reconcileBrandUrlIndex({...ctx,db});expect(firstPass.remaining).toBeGreaterThan(0);expect(firstPass.rebuilding).toBe(true);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='collection.brand_index_rebuild_completed'").first<{n:number}>())?.n).toBe(0);
    const final=await reconcileBrandUrlIndex(ctx);expect(final.remaining).toBe(0);expect(final.rebuilding).toBe(false);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_audit_events WHERE action='collection.brand_index_rebuild_completed'").first<{n:number}>())?.n).toBe(1);
  });
  it('indexes nested encodings and normalized paths while ignoring malformed paths, not malformed queries',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso();
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,back_url,created_by,created_at,updated_at) VALUES('index-parser','index-parser','Parser','bot',?,'/none',?,?,?)`).bind(ctx.tenant.id,ctx.user!.id,now,now).run();
    const nested=(levels:number)=>'/media/asset/ast'+('%25'.repeat(0))+('%'+'25'.repeat(levels-1)+'5F')+'test';
    for (const url of [nested(1),nested(3),nested(10),'/%256dedia/asset/ast_test','/media/x/../asset/ast_test','/media/asset/ast_test?bad=%ZZ']) {
      await runtime.DB.prepare("UPDATE fb_collections SET back_url=? WHERE id='index-parser'").bind(url).run();await reconcileBrandUrlIndex(ctx);
      const fence=await legacyBrandUrlFence(ctx,'ast_test');
      expect((await runtime.DB.prepare(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS ok`).bind(...fence.args).first<{ok:number}>())?.ok,url).toBe(0);
    }
    await runtime.DB.prepare("UPDATE fb_collections SET back_url='/unrelated%ZZ' WHERE id='index-parser'").run();await reconcileBrandUrlIndex(ctx);
    const safe=await legacyBrandUrlFence(ctx,'ast_test');expect((await runtime.DB.prepare(`SELECT CASE WHEN ${safe.sql} THEN 1 ELSE 0 END AS ok`).bind(...safe.args).first<{ok:number}>())?.ok).toBe(1);
    await runtime.DB.prepare("UPDATE fb_collections SET back_url=? WHERE id='index-parser'").bind(nested(258)).run();
    await expect(reconcileBrandUrlIndex(ctx)).rejects.toMatchObject({code:'brand_reference_ambiguous'});
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='index-parser'").first()).toBeTruthy();
  });
  it('reports only scoped collection and slot, and rechecks a corrected item without clearing others',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso(),fixture=await fixturePool(ctx),bad=`/media/asset/${fixture.renderAsset}?legacy=1`,ambiguous='/media/asset/ast'+'%'+'25'.repeat(257)+'5Ftest';
    await runtime.DB.prepare("UPDATE fb_assets SET r2_key='collection-brand-v1/test/fixture' WHERE id=?").bind(fixture.renderAsset).run();
    const other=await ctxFor('harbour','harbour.owner@foilbury.test');
    for (const id of ['issue-a','issue-b']) await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,logo_url,created_by,created_at,updated_at) VALUES(?,?,?,'bot',?,?,?, ?,?)`).bind(id,id,id,id==='issue-a'?other.tenant.id:ctx.tenant.id,id==='issue-a'?bad:ambiguous,ctx.user!.id,now,now).run();
    const before=await listBrandUrlIssues(ctx);expect(before.items.filter(x=>x.collectionId.startsWith('issue-'))).toHaveLength(2);expect(JSON.stringify(before)).not.toContain(bad);
    const issueResponse=await routeApi(new Request('http://localhost/api/v1/admin/collections/brand-reference-index/issues'),ctx,'admin/collections/brand-reference-index/issues');
    expect(issueResponse.status).toBe(200);expect(await issueResponse.text()).not.toContain(bad);
    expect(before.items.find(x=>x.collectionId==='issue-a')?.currentTenant).toBe(false);
    expect(before.items.find(x=>x.collectionId==='issue-b')?.canClear).toBe(false);
    await expect(listBrandUrlIssues(other)).rejects.toThrow();
    const issue=before.items.find(x=>x.collectionId==='issue-a')!;
    const req=new Request('http://localhost/api/v1/admin/collections/brand-reference-index/clear',{method:'POST',headers:{'content-type':'application/json','x-foilbury-csrf':ctx.csrfToken!},body:JSON.stringify({collectionId:issue.collectionId,slot:issue.slot,collectionVersion:issue.collectionVersion})});
    expect((await routeApi(req,ctx,'admin/collections/brand-reference-index/clear')).status).toBe(200);
    expect((await runtime.DB.prepare("SELECT logo_url FROM fb_collections WHERE id='issue-a'").first<{logo_url:string|null}>())?.logo_url).toBeNull();
    expect((await runtime.DB.prepare("SELECT previous_url FROM fb_brand_url_corrections WHERE collection_id='issue-a'").first<{previous_url:string}>())?.previous_url).toBe(bad);
    expect((await runtime.DB.prepare("SELECT tenant_id FROM fb_audit_events WHERE action='collection.brand_reference_cleared' AND object_id='issue-a'").first<{tenant_id:string}>())?.tenant_id).toBe(other.tenant.id);
    const result=await reconcileBrandUrlIndex(ctx,'issue-a');expect(result.processed).toBe(1);
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='issue-a'").first()).toBeNull();
    expect(await runtime.DB.prepare("SELECT collection_id FROM fb_brand_url_dirty WHERE collection_id='issue-b'").first()).toBeTruthy();
    const after=await listBrandUrlIssues(ctx);expect(after.items.some(x=>x.collectionId==='issue-a')).toBe(false);expect(after.items.some(x=>x.collectionId==='issue-b')).toBe(true);
  });
  it('rolls back explicit correction if root authority is revoked before commit',async()=>{
    await bootstrap();const ctx=await owner(),now=nowIso(),fixture=await fixturePool(ctx),bad=`/media/asset/${fixture.renderAsset}?legacy=1`;
    await runtime.DB.prepare("UPDATE fb_assets SET r2_key='collection-brand-v1/test/race' WHERE id=?").bind(fixture.renderAsset).run();
    await runtime.DB.prepare(`INSERT INTO fb_collections(id,slug,name,scope,owner_tenant_id,logo_url,created_by,created_at,updated_at) VALUES('issue-race','issue-race','Race','bot',?,?,?, ?,?)`).bind(ctx.tenant.id,bad,ctx.user!.id,now,now).run();
    const issue=(await listBrandUrlIssues(ctx)).items.find(x=>x.collectionId==='issue-race')!;
    const db=new Proxy(runtime.DB,{get(target,prop){if(prop==='batch')return async (statements:Parameters<typeof target.batch>[0])=>{await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),ctx.sessionId).run();return target.batch(statements);};const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
    await expect(clearBrandUrlIssue({...ctx,db},issue.collectionId,'logo',issue.collectionVersion)).rejects.toThrow();
    expect((await runtime.DB.prepare("SELECT logo_url FROM fb_collections WHERE id='issue-race'").first<{logo_url:string}>())?.logo_url).toBe(bad);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_brand_url_corrections WHERE collection_id='issue-race'").first<{n:number}>())?.n).toBe(0);
  });
  it('does not propose or clear an ordinary historical back image',async()=>{
    await bootstrap();const ctx=await owner(),fixture=await fixturePool(ctx),url=`/media/asset/${fixture.renderAsset}`;
    await runtime.DB.prepare("UPDATE fb_collections SET back_url=? WHERE id='col_test_public'").bind(url).run();
    const collection=await runtime.DB.prepare("SELECT release_version FROM fb_collections WHERE id='col_test_public'").first<{release_version:number}>();
    expect((await listBrandUrlIssues(ctx)).items.some(x=>x.collectionId==='col_test_public' && x.slot==='back')).toBe(false);
    await expect(clearBrandUrlIssue(ctx,'col_test_public','back',collection!.release_version)).rejects.toMatchObject({code:'brand_reference_changed'});
    expect((await runtime.DB.prepare("SELECT back_url FROM fb_collections WHERE id='col_test_public'").first<{back_url:string}>())?.back_url).toBe(url);
    expect((await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_brand_url_corrections WHERE collection_id='col_test_public'").first<{n:number}>())?.n).toBe(0);
  });
});
