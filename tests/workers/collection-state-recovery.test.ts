import { describe,expect,it } from 'vitest';
import { bootstrap,ctxFor,fixturePool,makeInstance,runtime } from './helpers';
import { createCollection,listCollections,updateCollection } from '../../src/server/modules/collections';
import { nowIso } from '../../src/server/db';

async function ownerContext() {
  const ctx=await ctxFor('cabinet','owner@foilbury.local'),id=`collection-session-${crypto.randomUUID()}`,now=nowIso();
  await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)")
    .bind(id,id,ctx.user!.id,ctx.tenant.id,now,new Date(Date.now()+60000).toISOString(),now,now).run();
  return {...ctx,sessionId:id,sessionAssurance:'passkey',sessionAuthTime:now};
}

describe('collection transition recovery',()=>{
  it('rejects noncanonical local asset URLs on creation and update',async()=>{
    await bootstrap();const owner=await ownerContext();
    const created=await createCollection(owner,{scope:'bot',name:'URL guard fixture',slug:'url-guard-fixture'});
    for (const url of ['/media/asset/ast_fixture?v=1','https://foilbury.loftwah.com/media/asset/ast_fixture','/%6dedia/asset/ast_fixture','/media%2fasset%2fast_fixture','/%256dedia/asset/ast_fixture','/media/asset/ast%255Ffixture']) {
      await expect(createCollection(owner,{scope:'bot',name:'Invalid URL',slug:`invalid-url-${crypto.randomUUID()}`,logoUrl:url})).rejects.toMatchObject({code:'collection_asset_url_invalid'});
      await expect(updateCollection(owner,created.id,{bannerUrl:url})).rejects.toMatchObject({code:'collection_asset_url_invalid'});
    }
  });
  it('allows a strongly authenticated human Super Admin and rejects agent public approval',async()=>{
    await bootstrap();
    const owner=await ownerContext();
    const created=await createCollection(owner,{scope:'global',name:'Human public fixture',slug:'human-public-fixture',status:'published',viewAudience:'public'});
    expect(created.view_audience).toBe('public');
    const featured=await createCollection(owner,{scope:'global',name:'Human featured fixture',slug:'human-featured-fixture',featured:true});
    expect(featured.featured).toBe(1);
    const scoped={...owner,user:{...owner.user!,platformAdmin:false}};
    await expect(createCollection(scoped,{scope:'bot',name:'Scoped featured fixture',slug:'scoped-featured-fixture',featured:true})).rejects.toThrow();
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_collections WHERE slug='scoped-featured-fixture'").first<{n:number}>())?.n).toBe(0);
    const agent={...owner,actor:{type:'agent' as const,id:'agent-fixture',representedUserId:owner.user!.id,label:'Fixture agent'},scopes:['content:write'],user:{...owner.user!,agentPlatformContent:true}};
    await expect(createCollection(agent,{scope:'global',name:'Agent public fixture',slug:'agent-public-fixture',status:'published',viewAudience:'public'})).rejects.toMatchObject({code:'human_public_approval_required'});
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_collections WHERE slug='agent-public-fixture'").first<{n:number}>())?.n).toBe(0);
  });
  it('fails closed if the owner session is revoked immediately before creation or update',async()=>{
    await bootstrap();
    const owner=await ownerContext();
    const wrap=(ctx:typeof owner)=>new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{await target.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(nowIso(),ctx.sessionId).run();return target.batch(statements);};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    const input={scope:'bot' as const,name:'Revoked create',slug:'revoked-create',status:'draft' as const};
    await expect(createCollection({...owner,db:wrap(owner)},input,{key:'revoked-collection-create',digest:'revoked-collection-create'})).rejects.toThrow();
    expect((await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_collections WHERE slug='revoked-create'").first<{n:number}>())?.n).toBe(0);
    const renewed=await ownerContext();
    const existing=await createCollection(renewed,{scope:'global',name:'Revoked update',slug:'revoked-update',status:'draft'});
    await expect(updateCollection({...renewed,db:wrap(renewed)},existing.id,{status:'published'})).rejects.toMatchObject({code:'stale_write'});
    expect((await runtime.DB.prepare('SELECT status FROM fb_collections WHERE id=?').bind(existing.id).first<{status:string}>())?.status).toBe('draft');
  });
  it('rolls back collection creation with its Bot link, audit and request receipt, and retries safely',async()=>{
    await bootstrap();
    const owner=await ownerContext();
    const input={scope:'bot' as const,name:'Atomic creation',slug:'atomic-creation',status:'draft' as const};
    const key={key:'collection-creation-key',digest:'collection-creation-digest'};
    const db=new Proxy(runtime.DB,{get(target,property){
      if(property==='batch') return (statements:Parameters<typeof target.batch>[0])=>target.batch([...statements,target.prepare('SELECT * FROM missing_collection_create_fixture')]);
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(createCollection({...owner,db},input,key)).rejects.toThrow();
    const absent=await runtime.DB.prepare("SELECT (SELECT COUNT(*) FROM fb_collections WHERE slug='atomic-creation') AS collections,(SELECT COUNT(*) FROM fb_idempotency_keys WHERE operation='collection.create' AND idempotency_key=?) AS receipts").bind(key.key).first<{collections:number;receipts:number}>();
    expect(absent).toEqual({collections:0,receipts:0});
    const created=await createCollection(owner,input,key);
    const replay=await createCollection(owner,input,key);
    expect(replay.id).toBe(created.id);
    await expect(createCollection(owner,input,{...key,digest:'different'})).rejects.toMatchObject({code:'idempotency_conflict'});
    expect(await runtime.DB.prepare('SELECT collection_id FROM fb_bot_collections WHERE collection_id=?').bind(created.id).first()).toBeTruthy();
    const audit=await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='collection.created' AND object_id=?").bind(created.id).first<{n:number}>();
    expect(audit?.n).toBe(1);
  });
  it('restores an archived collection to a discoverable draft',async()=>{
    await bootstrap();
    const owner=await ownerContext();
    const created=await createCollection(owner,{scope:'global',name:'Recovery fixture',slug:'recovery-fixture',status:'draft'});
    const fixture=await fixturePool(owner);
    const instance=await makeInstance(owner,owner.user!.id,fixture);
    await runtime.DB.prepare('INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES (?,?,?,0,?,?)').bind(created.id,fixture.cardId,owner.tenant.id,owner.user!.id,nowIso()).run();
    await updateCollection(owner,created.id,{status:'published'});
    await updateCollection(owner,created.id,{viewAudience:'public'});
    await updateCollection(owner,created.id,{status:'archived'});
    const restored=await updateCollection(owner,created.id,{status:'draft'});
    expect(restored.status).toBe('draft');
    expect(restored.archived_at).toBeNull();
    expect(restored.view_audience).toBe('members');
    expect(restored.public_approved_at).toBeNull();
    expect((await listCollections(owner,{includeAll:true})).some((item)=>item.id===created.id)).toBe(true);
    expect(await runtime.DB.prepare('SELECT id FROM fb_card_instances WHERE id=?').bind(instance).first()).toBeTruthy();
    expect(await runtime.DB.prepare('SELECT card_id FROM fb_collection_cards WHERE collection_id=? AND card_id=?').bind(created.id,fixture.cardId).first()).toBeTruthy();
    // Existing records may already contain the old inconsistent draft state.
    await runtime.DB.prepare('UPDATE fb_collections SET archived_at=? WHERE id=?').bind(nowIso(),created.id).run();
    const repaired=await updateCollection(owner,created.id,{status:'draft'});
    expect(repaired.archived_at).toBeNull();
    const audits=await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='collection.updated' AND object_id=?").bind(created.id).first<{n:number}>();
    expect(audits?.n).toBe(5);
  });

  it('does not overwrite a newer archive using a stale draft transition',async()=>{
    await bootstrap();
    const owner=await ownerContext();
    const created=await createCollection(owner,{scope:'global',name:'Transition race',slug:'transition-race',status:'draft'});
    const auditBefore=await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='collection.updated' AND object_id=?").bind(created.id).first<{n:number}>();
    let injected=false;
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return async (statements:Parameters<typeof target.batch>[0])=>{
        if(!injected){injected=true;await target.prepare("UPDATE fb_collections SET status='archived',archived_at=?,release_version=release_version+1 WHERE id=?").bind(nowIso(),created.id).run();}
        return target.batch(statements);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(updateCollection({...owner,db},created.id,{status:'published',expectedVersion:created.release_version})).rejects.toMatchObject({code:'stale_write'});
    const actual=await runtime.DB.prepare('SELECT status,archived_at FROM fb_collections WHERE id=?').bind(created.id).first<{status:string;archived_at:string|null}>();
    expect(actual?.status).toBe('archived');expect(actual?.archived_at).toBeTruthy();
    const auditAfter=await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='collection.updated' AND object_id=?").bind(created.id).first<{n:number}>();
    expect(auditAfter?.n).toBe(auditBefore?.n);
  });

  it('rolls back the transition and its audit together if the batch fails',async()=>{
    await bootstrap();
    const owner=await ownerContext();
    const created=await createCollection(owner,{scope:'global',name:'Rollback fixture',slug:'rollback-fixture',status:'draft'});
    const db=new Proxy(runtime.DB,{get(target,key){
      if(key==='batch') return (statements:Parameters<typeof target.batch>[0])=>target.batch([...statements,target.prepare('SELECT * FROM missing_collection_audit_fixture')]);
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    await expect(updateCollection({...owner,db},created.id,{status:'published'})).rejects.toThrow();
    const actual=await runtime.DB.prepare('SELECT status,release_version FROM fb_collections WHERE id=?').bind(created.id).first<{status:string;release_version:number}>();
    expect(actual).toEqual({status:'draft',release_version:created.release_version});
    const audits=await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='collection.updated' AND object_id=?").bind(created.id).first<{n:number}>();
    expect(audits?.n).toBe(0);
  });
});
