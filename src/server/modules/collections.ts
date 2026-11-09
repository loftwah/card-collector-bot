import type { D1Database } from "@cloudflare/workers-types";
import {
  ApiError,
  canManageGlobalCollection,
  hasCapability,
  requireGlobalCollectionManager,
  requireSuperAdminContent,
  requireScope,
  requireUser,
  type Ctx,
} from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { botForTenant, botAllowsAiArt } from "./bots";
import {
  audienceLabel,
  canViewAudience,
  cardVisibilitySql,
  collectionVisibilitySql,
  currentViewerAccess,
  publicCollectionSql,
  viewerAccess,
} from "./visibility";
import { assertTransition } from "../state";
import { idempotencyStatement, type IdempotencyInput } from '../http';

// Resolve authority again in the same D1 transaction as the mutation. A
// request-time role/scope snapshot cannot authorize a later write by itself.
export function collectionWriteGuard(ctx: Ctx, scope: 'global'|'bot', collectionId: string | null, publicApproval: boolean, options?: { denyAgentPlatform?: boolean }) {
  if (!ctx.user || ctx.actor.representedUserId !== ctx.user.id || (ctx.actor.type === 'user' && ctx.actor.id !== ctx.user.id))
    throw new ApiError(403,'collection_authority_changed','Your collection authority changed.');
  if (publicApproval && ctx.actor.type !== 'user')
    throw new ApiError(403,'human_public_approval_required','Public showcase approval requires the signed-in Super Admin.');
  const p=JSON.stringify({tenant:ctx.tenant.id,user:ctx.user.id,actor:ctx.actor.type,actorId:ctx.actor.id,session:ctx.sessionId,
    assurance:ctx.sessionAssurance,token:ctx.agentCredential?.tokenId ?? '',grant:ctx.agentCredential?.grantId ?? '',scope,collectionId,publicApproval});
  return {sql:`EXISTS (SELECT 1 FROM (SELECT json(?) AS p) x
    JOIN fb_users u ON u.id=json_extract(x.p,'$.user') AND u.disabled_at IS NULL
    JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=json_extract(x.p,'$.tenant') AND m.status='active' AND m.revoked_at IS NULL
    LEFT JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
    LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=u.id
    WHERE ((json_extract(x.p,'$.actor')='user' AND EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=json_extract(x.p,'$.session')
      AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND s.assurance=json_extract(x.p,'$.assurance') AND s.assurance IN ('passkey','mfa')
      AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    OR (json_extract(x.p,'$.actor')='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id
      WHERE t.id=json_extract(x.p,'$.token') AND g.id=json_extract(x.p,'$.grant') AND t.revoked_at IS NULL
      AND g.agent_id=json_extract(x.p,'$.actorId') AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND g.status='active' AND g.revoked_at IS NULL
      AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='content:write'))))
    AND ((${options?.denyAgentPlatform ? "json_extract(x.p,'$.actor')='user' AND " : ""}u.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))
      OR (json_extract(x.p,'$.publicApproval')=0 AND json_extract(x.p,'$.scope')='global' AND EXISTS (SELECT 1 FROM fb_platform_role_assignments pr
        WHERE pr.user_id=u.id AND pr.role='global_collection_admin' AND pr.status='active' AND pr.revoked_at IS NULL AND json_valid(pr.scopes_json)
        AND (json_type(pr.scopes_json,'$.all')='true' OR (json_extract(x.p,'$.collectionId') IS NOT NULL
          AND json_type(pr.scopes_json,'$.all')='false' AND json_type(pr.scopes_json,'$.collectionIds')='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(pr.scopes_json,'$.collectionIds') WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(pr.scopes_json,'$.collectionIds') WHERE value=json_extract(x.p,'$.collectionId'))))))
      OR (json_extract(x.p,'$.publicApproval')=0 AND json_extract(x.p,'$.scope')='bot' AND b.id IS NOT NULL AND
        ((m.role='owner' AND b.owner_user_id=u.id) OR (m.role<>'owner'
          AND json_type(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE 'null' END)='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE type<>'text')
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content')
          AND (ba.id IS NULL OR (ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL
            AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
            AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')
            AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='content'))))))))`,args:[p]};
}

async function brandLinkGuard(ctx:Ctx,logo:string|null,banner:string|null,back:string|null) {
  const installed=await first<{present:number}>(ctx.db,"SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='fb_collection_brand_uploads'");
  const completed=installed ? "AND NOT EXISTS (SELECT 1 FROM fb_collection_brand_uploads p WHERE p.asset_id=a.id AND p.tenant_id=a.tenant_id AND p.r2_key=a.r2_key AND p.status='completed' AND p.object_version IS NOT NULL AND p.object_etag IS NOT NULL AND p.content_sha256=a.sha256 AND a.processing_state='ready' AND a.archived_at IS NULL)" : '';
  return {sql:`NOT EXISTS (SELECT 1 FROM fb_assets a WHERE a.id IN (?,?) AND a.r2_key LIKE 'collection-brand-v1/%' ${completed}) AND NOT EXISTS (SELECT 1 FROM fb_assets a WHERE a.id=? AND a.r2_key LIKE 'collection-brand-v1/%')`,args:[logo,banner,back]};
}

function parseCollectionAssetUrl(url:string|null):string|null {
    if (!url) return null;
    let path:string;
    try { path=new URL(url,'https://foilbury.invalid').pathname; } catch { return null; }
    if (path.length>2048) throw new ApiError(503,'brand_reference_ambiguous','An oversized image reference needs inspection before it can be indexed.');
    for (let depth=0;depth<256;depth++) {
      const match=path.match(/^\/media\/asset\/([A-Za-z0-9_-]+)$/);
      if (match) return match[1]!;
      if (!path.includes('%')) return null;
      try {
        const next=decodeURIComponent(path);
        if (next===path) return null;
        const normalized=new URL(next,'https://foilbury.invalid').pathname;
        if (normalized===path) return null;
        path=normalized;
      } catch { return null; } // Local Astro rejects malformed path encodings.
    }
    throw new ApiError(503,'brand_reference_ambiguous','An encoded image reference needs inspection before it can be indexed.');
}

/** Trusted operator action after index-trigger repair; does not edit source URLs. */
export async function startBrandUrlRebuild(ctx:Ctx) {
  const authority=collectionWriteGuard(ctx,'global',null,true),id=newId('bri'),now=nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`SELECT CASE WHEN ${authority.sql} AND (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('fb_brand_urls_insert','fb_brand_urls_update','fb_brand_urls_delete'))=3 THEN 1 ELSE json('brand_index_unavailable') END`).bind(...authority.args),
    ctx.db.prepare("INSERT OR IGNORE INTO fb_brand_index_rebuilds(id,status,started_by,started_at) VALUES (?,'pending',?,?)").bind(id,ctx.user!.id,now),
    ctx.db.prepare("INSERT OR IGNORE INTO fb_brand_url_dirty(collection_id) SELECT id FROM fb_collections WHERE EXISTS (SELECT 1 FROM fb_brand_index_rebuilds WHERE id=? AND status='pending')").bind(id),
    ctx.db.prepare("DELETE FROM fb_brand_url_refs WHERE NOT EXISTS (SELECT 1 FROM fb_collections c WHERE c.id=fb_brand_url_refs.collection_id) AND EXISTS (SELECT 1 FROM fb_brand_index_rebuilds WHERE id=? AND status='pending')").bind(id),
    ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?,'collection.brand_index_rebuild_started','brand_index',?,'{}',?,? WHERE EXISTS (SELECT 1 FROM fb_brand_index_rebuilds WHERE id=? AND status='pending')`)
      .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,id,ctx.requestId,now,id),
  ]);
  const pending=await first<{id:string}>(ctx.db,`SELECT id FROM fb_brand_index_rebuilds WHERE status='pending' AND ${authority.sql}`,...authority.args);
  if (!pending) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  return {rebuildId:pending.id};
}

async function inlineBrandIndex(ctx:Ctx,id:string,auditId:string,logo:string|null,banner:string|null,back:string|null,logoId:string|null,bannerId:string|null) {
  if (!await first(ctx.db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='fb_brand_url_dirty'")) return [];
  let refs:Array<{slot:string;asset:string;tracked:number}>;
  try {
    refs=[{slot:'logo',asset:parseCollectionAssetUrl(logo),tracked:logoId},{slot:'banner',asset:parseCollectionAssetUrl(banner),tracked:bannerId},{slot:'back',asset:parseCollectionAssetUrl(back),tracked:null}].filter(r=>r.asset).map(r=>({slot:r.slot,asset:r.asset!,tracked:r.tracked===r.asset ? 1 : 0}));
  } catch { return []; } // Leave an ambiguous legacy row dirty for explicit review.
  const current=`EXISTS (SELECT 1 FROM fb_audit_events WHERE id=?) AND EXISTS (SELECT 1 FROM fb_collections c WHERE c.id=? AND c.logo_url IS ? AND c.banner_url IS ? AND c.back_url IS ? AND c.logo_asset_id IS ? AND c.banner_asset_id IS ?)`;
  const values=[auditId,id,logo,banner,back,logoId,bannerId];
  return [
    ctx.db.prepare(`DELETE FROM fb_brand_url_refs WHERE collection_id=? AND ${current}`).bind(id,...values),
    ctx.db.prepare(`INSERT INTO fb_brand_url_refs(collection_id,slot,asset_id,tracked) SELECT ?,json_extract(value,'$.slot'),json_extract(value,'$.asset'),json_extract(value,'$.tracked') FROM json_each(?) WHERE ${current}`).bind(id,JSON.stringify(refs),...values),
    ctx.db.prepare(`DELETE FROM fb_brand_url_dirty WHERE collection_id=? AND ${current}`).bind(id,...values),
  ];
}

/** Reconcile a bounded dirty queue. Each replacement checks the exact source
 * row in the same transaction; final consumers require the queue empty. */
export async function reconcileBrandUrlIndex(ctx:Ctx,collectionId?:string) {
  const authority=collectionWriteGuard(ctx,'global',null,true);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args))
    throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  const required=await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('fb_brand_urls_insert','fb_brand_urls_update','fb_brand_urls_delete'))=3 AND (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('fb_collection_brand_uploads','fb_collection_brand_releases','fb_brand_url_dirty','fb_brand_url_refs','fb_brand_url_corrections','fb_brand_index_rebuilds'))=6`);
  if (!required) throw new ApiError(503,'brand_index_unavailable','Collection image reference checks are unavailable.');
  type Row={id:string;present:string|null;logo_url:string|null;banner_url:string|null;back_url:string|null;logo_asset_id:string|null;banner_asset_id:string|null};
  let processed=0;
  for (let pass=0;pass<4;pass++) {
    const rows=await all<Row>(ctx.db,`SELECT q.collection_id AS id,c.id AS present,c.logo_url,c.banner_url,c.back_url,c.logo_asset_id,c.banner_asset_id
      FROM fb_brand_url_dirty q LEFT JOIN fb_collections c ON c.id=q.collection_id WHERE (? IS NULL OR q.collection_id=?) ORDER BY q.collection_id LIMIT 16`,collectionId ?? null,collectionId ?? null);
    if (!rows.length) break;
    const statements:D1PreparedStatement[]=[ctx.db.prepare(`SELECT CASE WHEN ${authority.sql} THEN 1 ELSE json('collection_authority_changed') END`).bind(...authority.args)];
    for (const row of rows) {
      const refs=[{slot:'logo',asset:parseCollectionAssetUrl(row.logo_url),tracked:row.logo_asset_id},{slot:'banner',asset:parseCollectionAssetUrl(row.banner_url),tracked:row.banner_asset_id},{slot:'back',asset:parseCollectionAssetUrl(row.back_url),tracked:null}].filter(r=>r.asset).map(r=>({slot:r.slot,asset:r.asset,tracked:r.tracked===r.asset ? 1 : 0}));
      statements.push(ctx.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_brand_url_dirty WHERE collection_id=?) AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM fb_collections WHERE id=?)) OR EXISTS (SELECT 1 FROM fb_collections WHERE id=? AND logo_url IS ? AND banner_url IS ? AND back_url IS ? AND logo_asset_id IS ? AND banner_asset_id IS ?)) THEN 1 ELSE json('brand_reference_changed') END`).bind(row.id,row.present,row.id,row.id,row.logo_url,row.banner_url,row.back_url,row.logo_asset_id,row.banner_asset_id));
      statements.push(ctx.db.prepare('DELETE FROM fb_brand_url_refs WHERE collection_id=?').bind(row.id));
      statements.push(ctx.db.prepare(`INSERT INTO fb_brand_url_refs(collection_id,slot,asset_id,tracked) SELECT ?,json_extract(value,'$.slot'),json_extract(value,'$.asset'),json_extract(value,'$.tracked') FROM json_each(?)`).bind(row.id,JSON.stringify(refs)));
      statements.push(ctx.db.prepare('DELETE FROM fb_brand_url_dirty WHERE collection_id=?').bind(row.id));
    }
    await ctx.db.batch(statements);
    processed+=rows.length;
  }
  const remaining=await first<{n:number}>(ctx.db,'SELECT COUNT(*) AS n FROM fb_brand_url_dirty');
  if (Number(remaining?.n ?? 0)===0) {
    const now=nowIso();
    const pending=await first<{id:string}>(ctx.db,"SELECT id FROM fb_brand_index_rebuilds WHERE status='pending'");
    if (pending) {
    await ctx.db.batch([
      ctx.db.prepare(`UPDATE fb_brand_index_rebuilds SET status='completed',completed_at=? WHERE id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM fb_brand_url_dirty) AND ${authority.sql}
        AND (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('fb_brand_urls_insert','fb_brand_urls_update','fb_brand_urls_delete'))=3`).bind(now,pending.id,...authority.args),
      ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        SELECT ?,?,?,?,?,'collection.brand_index_rebuild_completed','brand_index',id,'{}',?,? FROM fb_brand_index_rebuilds WHERE id=? AND status='completed' AND changes()=1`)
        .bind(newId('aud'),ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,ctx.requestId,now,pending.id),
    ]);
    }
  }
  const final=await first<{remaining:number;rebuilding:number}>(ctx.db,`SELECT (SELECT COUNT(*) FROM fb_brand_url_dirty) AS remaining,EXISTS(SELECT 1 FROM fb_brand_index_rebuilds WHERE status='pending') AS rebuilding WHERE ${authority.sql}`,...authority.args);
  if (!final) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  return {processed,remaining:Number(final.remaining),rebuilding:Boolean(final.rebuilding)};
}

/** Show only collection/slot and a safe reason; raw legacy URLs stay private. */
export async function listBrandUrlIssues(ctx:Ctx) {
  const authority=collectionWriteGuard(ctx,'global',null,true);
  const allowed=await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args);
  if (!allowed) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  const rows=await all<{id:string;name:string;owner_tenant_id:string|null;tenant_name:string|null;release_version:number;logo_url:string|null;banner_url:string|null;back_url:string|null;logo_asset_id:string|null;banner_asset_id:string|null}>(ctx.db,`SELECT c.id,c.name,c.owner_tenant_id,t.name AS tenant_name,c.release_version,c.logo_url,c.banner_url,c.back_url,c.logo_asset_id,c.banner_asset_id FROM fb_collections c LEFT JOIN fb_tenants t ON t.id=c.owner_tenant_id
    WHERE EXISTS (SELECT 1 FROM fb_brand_url_dirty d WHERE d.collection_id=c.id) OR EXISTS (SELECT 1 FROM fb_brand_url_refs r WHERE r.collection_id=c.id AND r.tracked=0) ORDER BY c.id LIMIT 65`);
  const items:Array<{collectionId:string;collectionName:string;tenantName:string;currentTenant:boolean;collectionVersion:number;slot:string;reason:string;canClear:boolean}>=[];
  const candidates:Array<{id:string;item:{collectionId:string;collectionName:string;tenantName:string;currentTenant:boolean;collectionVersion:number;slot:string}}>=[];
  for (const row of rows.slice(0,64)) for (const [slot,value,tracked] of [['logo',row.logo_url,row.logo_asset_id],['banner',row.banner_url,row.banner_asset_id],['back',row.back_url,null]] as const) {
    const item={collectionId:row.id,collectionName:row.name,tenantName:row.tenant_name ?? 'Shared catalogue',currentTenant:row.owner_tenant_id===ctx.tenant.id,collectionVersion:row.release_version,slot};
    let id:string|null=null,ambiguous=false;
    try {id=parseCollectionAssetUrl(value);} catch {ambiguous=true;}
    if (ambiguous) items.push({...item,canClear:false,reason:'This URL has too many encoding layers to identify safely. Ask the collection owner to review it; no automatic correction is available.'});
    else if (id && id!==tracked) candidates.push({id,item});
  }
  if (candidates.length) {
    const existing=await all<{id:string}>(ctx.db,"SELECT id FROM fb_assets WHERE r2_key LIKE 'collection-brand-v1/%' AND id IN (SELECT value FROM json_each(?))",JSON.stringify([...new Set(candidates.map(c=>c.id))]));
    const ids=new Set(existing.map(x=>x.id));
    for (const candidate of candidates) if (ids.has(candidate.id)) items.push({...candidate.item,canClear:true,reason:'This new image has an untracked collection link. Clear it or replace it with an exact local image URL.'});
  }
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args)) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  return {items,more:rows.length>64};
}

/** Explicit, recoverable root-only correction of a specific unsafe reference. */
export async function clearBrandUrlIssue(ctx:Ctx,collectionId:string,slot:'logo'|'banner'|'back',expectedVersion:number) {
  if (!['logo','banner','back'].includes(slot) || !Number.isSafeInteger(expectedVersion) || expectedVersion<1) throw new ApiError(422,'brand_reference_invalid','Choose a current reference issue.');
  const authority=collectionWriteGuard(ctx,'global',collectionId,true);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${authority.sql}`,...authority.args)) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  const row=await first<{release_version:number;owner_tenant_id:string|null;logo_url:string|null;banner_url:string|null;back_url:string|null;logo_asset_id:string|null;banner_asset_id:string|null}>(ctx.db,'SELECT release_version,owner_tenant_id,logo_url,banner_url,back_url,logo_asset_id,banner_asset_id FROM fb_collections WHERE id=?',collectionId);
  if (!row || row.release_version!==expectedVersion) throw new ApiError(409,'brand_reference_changed','The collection changed. Refresh the issues before correcting it.');
  const value=slot==='logo'?row.logo_url:slot==='banner'?row.banner_url:row.back_url;
  const previousAsset=slot==='logo'?row.logo_asset_id:slot==='banner'?row.banner_asset_id:null;
  if (!value) throw new ApiError(409,'brand_reference_changed','The collection reference was already corrected.');
  let issue=false,parsedAsset:string|null=null,ambiguous=false;
  try {parsedAsset=parseCollectionAssetUrl(value);} catch {ambiguous=true;}
  issue=!ambiguous && Boolean(parsedAsset && parsedAsset!==previousAsset && await first(ctx.db,"SELECT 1 FROM fb_assets WHERE id=? AND r2_key LIKE 'collection-brand-v1/%'",parsedAsset));
  if (!issue) throw new ApiError(409,'brand_reference_changed','This reference is no longer an issue. Refresh the list.');
  const urlColumn=slot==='logo'?'logo_url':slot==='banner'?'banner_url':'back_url';
  const assetColumn=slot==='logo'?'logo_asset_id':slot==='banner'?'banner_asset_id':null;
  const now=nowIso();
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_collections SET ${urlColumn}=NULL${assetColumn ? `,${assetColumn}=NULL` : ''},view_audience=CASE WHEN view_audience='public' THEN 'members' ELSE view_audience END,public_approved_at=CASE WHEN view_audience='public' THEN NULL ELSE public_approved_at END,public_approved_by=CASE WHEN view_audience='public' THEN NULL ELSE public_approved_by END,release_version=release_version+1,updated_at=?
      WHERE id=? AND release_version=? AND owner_tenant_id IS ? AND ${urlColumn} IS ? ${assetColumn ? `AND ${assetColumn} IS ?` : ''} AND EXISTS (SELECT 1 FROM fb_assets a WHERE a.id=? AND a.r2_key LIKE 'collection-brand-v1/%') AND ${authority.sql}`)
      .bind(now,collectionId,expectedVersion,row.owner_tenant_id,value,...(assetColumn?[previousAsset]:[]),parsedAsset,...authority.args),
    ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('brand_reference_changed') END"),
    ctx.db.prepare('INSERT INTO fb_brand_url_corrections(id,collection_id,slot,previous_url,previous_asset_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?)').bind(newId('buc'),collectionId,slot,value,previousAsset,ctx.user!.id,now),
    ctx.db.prepare(`INSERT INTO fb_audit_events(id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at) VALUES (?,?,?,?,?,'collection.brand_reference_cleared','collection',?,?,?,?)`)
      .bind(newId('aud'),row.owner_tenant_id ?? ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,collectionId,JSON.stringify({slot}),ctx.requestId,now),
  ]);
}

export async function legacyBrandUrlFence(ctx:Ctx,assetId:string) {
  const triggerCheck="(SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('fb_brand_urls_insert','fb_brand_urls_update','fb_brand_urls_delete'))=3";
  const tableCheck="(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('fb_collection_brand_uploads','fb_collection_brand_releases','fb_brand_url_dirty','fb_brand_url_refs','fb_brand_url_corrections','fb_brand_index_rebuilds'))=6";
  if (!(await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${triggerCheck} AND ${tableCheck}`))) throw new ApiError(503,'brand_index_unavailable','Collection image reference checks are unavailable.');
  const select=`SELECT q.collection_id AS id,c.id AS present,c.logo_url,c.banner_url,c.back_url,c.logo_asset_id,c.banner_asset_id FROM fb_brand_url_dirty q LEFT JOIN fb_collections c ON c.id=q.collection_id ORDER BY q.collection_id LIMIT 65`;
  const aggregate=`SELECT coalesce(json_group_array(json_array(id,present,logo_url,banner_url,back_url,logo_asset_id,banner_asset_id)),'[]') AS snapshot FROM (${select})`;
  const row=await first<{snapshot:string}>(ctx.db,aggregate);
  const snapshot=row?.snapshot ?? '[]';
  const dirty=JSON.parse(snapshot) as Array<[string,string|null,string|null,string|null,string|null,string|null,string|null]>;
  if (dirty.length>64) throw new ApiError(503,'brand_reference_reconciling','Collection image references need another check.');
  for (const [,present,logo,banner,back,logoId,bannerId] of dirty) {
    if (!present) continue;
    const logoAsset=parseCollectionAssetUrl(logo),bannerAsset=parseCollectionAssetUrl(banner),backAsset=parseCollectionAssetUrl(back);
    if ((logoAsset===assetId && logoId!==assetId) || (bannerAsset===assetId && bannerId!==assetId) || backAsset===assetId)
      throw new ApiError(409,'brand_reference_ambiguous','This image has an untracked collection reference.');
  }
  return {sql:`${triggerCheck} AND ${tableCheck} AND NOT EXISTS (SELECT 1 FROM fb_brand_index_rebuilds WHERE status='pending') AND NOT EXISTS (SELECT 1 FROM fb_brand_url_refs r WHERE r.asset_id=? AND r.tracked=0 AND NOT EXISTS (SELECT 1 FROM fb_brand_url_dirty d WHERE d.collection_id=r.collection_id)) AND (${aggregate})=?`,args:[assetId,snapshot]};
}

export interface CollectionRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: "global" | "bot";
  owner_tenant_id: string | null;
  logo_asset_id: string | null;
  banner_asset_id: string | null;
  logo_url: string | null;
  banner_url: string | null;
  back_url: string | null;
  accent: string;
  status: "draft" | "published" | "archived";
  archived_at: string | null;
  view_audience: "public" | "members" | "private";
  public_approved_at: string | null;
  public_approved_by: string | null;
  source_work: string | null;
  source_context: string | null;
  content_advisory: string | null;
  release_version: number;
  released_at: string | null;
  provenance_json: string;
  featured: number;
  sort: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CollectionSummary extends CollectionRow {
  card_count: number;
  enabled: boolean;
  manageable: boolean;
  owner_name: string;
  audience_label: string;
  cover_url: string | null;
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function platformCatalogueTenantId(ctx: Ctx): Promise<string> {
  if (ctx.tenant.slug === ctx.config.tenantSlug) return ctx.tenant.id;
  const main = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_tenants WHERE slug = ?",
    ctx.config.tenantSlug,
  );
  return main?.id ?? ctx.tenant.id;
}

function collectionManagementScope(access: Awaited<ReturnType<typeof currentViewerAccess>>, tenantId: string, includeAll: boolean, includeVisible = false) {
  const visible = collectionVisibilitySql(access);
  if (!includeAll) return visible;
  if (access.platformAdmin) return { sql: "(c.scope = 'global' OR c.owner_tenant_id = ?)", params: [tenantId] };
  const clauses = includeVisible ? [`(${visible.sql})`] : [];
  const params: unknown[] = includeVisible ? [...visible.params] : [];
  if (access.globalCollectionAdmin) {
    const scope = access.globalCollectionIds;
    if (scope === null) clauses.push("c.scope = 'global'");
    else if (scope.size) { const ids = [...scope]; clauses.push(`(c.scope = 'global' AND c.id IN (${ids.map(() => "?").join(",")}))`); params.push(...ids); }
  }
  if (access.adminTenantIds.has(tenantId)) { clauses.push("(c.scope = 'bot' AND c.owner_tenant_id = ?)"); params.push(tenantId); }
  return { sql: clauses.length ? `(${clauses.join(" OR ")})` : "0", params };
}

export async function listCollections(
  ctx: Ctx,
  options?: { includeArchived?: boolean; includeAll?: boolean; includeVisible?: boolean },
): Promise<CollectionSummary[]> {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  const access = await currentViewerAccess(ctx);
  const countVisibility = cardVisibilitySql(access, "cd_count");
  const coverVisibility = cardVisibilitySql(access, "cd_cover");
  const includeAll = Boolean(options?.includeAll && ctx.actor.type !== "agent");
  const scope = collectionManagementScope(access, ctx.tenant.id, includeAll, options?.includeVisible);
  const scopeClause = scope.sql;
  const params: unknown[] = [...countVisibility.params, ...coverVisibility.params, bot?.id ?? "", options?.includeArchived ? 1 : 0];
  params.push(...scope.params);
  const rows = await all<CollectionSummary & { owner_name: string | null }>(
    ctx.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fb_collection_cards cc JOIN fb_card_definitions cd_count ON cd_count.id = cc.card_id AND cd_count.status = 'published' AND cd_count.archived_at IS NULL WHERE cc.collection_id = c.id AND (${countVisibility.sql})) AS card_count,
            COALESCE(bc.enabled, 0) AS enabled,
            COALESCE(t.name, 'Foilbury global') AS owner_name,
            (SELECT vr.public_url
               FROM fb_collection_cards cc2
               JOIN fb_card_definitions cd_cover ON cd_cover.id = cc2.card_id AND cd_cover.status = 'published' AND cd_cover.archived_at IS NULL
               JOIN fb_variants v2 ON v2.card_id = cc2.card_id AND v2.status = 'published' AND v2.archived_at IS NULL
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE cc2.collection_id = c.id AND (${coverVisibility.sql})
              ORDER BY cc2.sort, v2.name
              LIMIT 1) AS cover_url
       FROM fb_collections c
       LEFT JOIN fb_tenants t ON t.id = c.owner_tenant_id
       LEFT JOIN fb_bot_collections bc ON bc.collection_id = c.id AND bc.bot_id = ?
      WHERE c.archived_at IS NULL
        AND (? = 1 OR c.status <> 'archived')
        AND ${scopeClause}
      ORDER BY CASE c.scope WHEN 'global' THEN 0 ELSE 1 END, c.sort, c.name`,
    ...params,
  );
  return rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    manageable:
      row.scope === "global"
        ? Boolean(access.platformAdmin || (access.globalCollectionAdmin && (!access.globalCollectionIds || access.globalCollectionIds.has(row.id))))
        : Boolean(row.owner_tenant_id && access.adminTenantIds.has(row.owner_tenant_id)),
    owner_name: row.owner_name ?? "Foilbury global",
    audience_label: audienceLabel(row.view_audience),
  }));
}

export async function listPublicCollections(ctx: Ctx): Promise<CollectionSummary[]> {
  const access = await viewerAccess({ ...ctx, user: null });
  const countVisibility = cardVisibilitySql(access, "cd_count");
  const coverVisibility = cardVisibilitySql(access, "cd_cover");
  const rows = await all<CollectionSummary & { owner_name: string | null }>(
    ctx.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fb_collection_cards cc JOIN fb_card_definitions cd_count ON cd_count.id = cc.card_id AND cd_count.status = 'published' AND cd_count.archived_at IS NULL WHERE cc.collection_id = c.id AND (${countVisibility.sql})) AS card_count,
            0 AS enabled,
            COALESCE(t.name, 'Foilbury global') AS owner_name,
            (SELECT vr.public_url
               FROM fb_collection_cards cc2
               JOIN fb_card_definitions cd_cover ON cd_cover.id = cc2.card_id AND cd_cover.status = 'published' AND cd_cover.archived_at IS NULL
               JOIN fb_variants v2 ON v2.card_id = cc2.card_id AND v2.status = 'published' AND v2.archived_at IS NULL
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE cc2.collection_id = c.id AND (${coverVisibility.sql})
              ORDER BY cc2.sort, v2.name
              LIMIT 1) AS cover_url
       FROM fb_collections c
       LEFT JOIN fb_tenants t ON t.id = c.owner_tenant_id
      WHERE ${publicCollectionSql("c")}
      ORDER BY c.featured DESC, c.sort, c.name`,
    ...countVisibility.params, ...coverVisibility.params,
  );
  return rows.map((row) => ({
    ...row,
    enabled: false,
    manageable: false,
    owner_name: row.owner_name ?? "Foilbury global",
    audience_label: audienceLabel(row.view_audience),
  }));
}

export async function getCollection(
  ctx: Ctx,
  id: string,
  options?: { includeAll?: boolean },
): Promise<CollectionSummary> {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  const access = await currentViewerAccess(ctx);
  const countVisibility = cardVisibilitySql(access, "cd_count");
  const coverVisibility = cardVisibilitySql(access, "cd_cover");
  const scope = collectionManagementScope(access, ctx.tenant.id, Boolean(options?.includeAll && ctx.actor.type !== "agent"));
  const identityClause = scope.sql;
  const params: unknown[] = [...countVisibility.params, ...coverVisibility.params, bot?.id ?? "", id];
  params.push(...scope.params);
  const row = await first<CollectionSummary & { owner_name: string | null }>(
    ctx.db,
    `SELECT c.*,
            (SELECT COUNT(*) FROM fb_collection_cards cc JOIN fb_card_definitions cd_count ON cd_count.id = cc.card_id AND cd_count.status = 'published' AND cd_count.archived_at IS NULL WHERE cc.collection_id = c.id AND (${countVisibility.sql})) AS card_count,
            COALESCE(bc.enabled, 0) AS enabled,
            COALESCE(t.name, 'Foilbury global') AS owner_name,
            (SELECT vr.public_url
               FROM fb_collection_cards cc2
               JOIN fb_card_definitions cd_cover ON cd_cover.id = cc2.card_id AND cd_cover.status = 'published' AND cd_cover.archived_at IS NULL
               JOIN fb_variants v2 ON v2.card_id = cc2.card_id AND v2.status = 'published' AND v2.archived_at IS NULL
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE cc2.collection_id = c.id AND (${coverVisibility.sql})
              ORDER BY cc2.sort, v2.name
              LIMIT 1) AS cover_url
       FROM fb_collections c
       LEFT JOIN fb_tenants t ON t.id = c.owner_tenant_id
       LEFT JOIN fb_bot_collections bc ON bc.collection_id = c.id AND bc.bot_id = ?
      WHERE c.id = ? AND ${identityClause}`,
    ...params,
  );
  if (!row)
    throw new ApiError(
      404,
      "collection_not_found",
      "That collection is not available to this account.",
    );
  return {
    ...row,
    enabled: Boolean(row.enabled),
    manageable:
      row.scope === "global"
        ? Boolean(access.platformAdmin || (access.globalCollectionAdmin && (!access.globalCollectionIds || access.globalCollectionIds.has(row.id))))
        : Boolean(row.owner_tenant_id && access.adminTenantIds.has(row.owner_tenant_id)),
    owner_name: row.owner_name ?? "Foilbury global",
    audience_label: audienceLabel(row.view_audience),
  };
}

export async function listCollectionCards(
  ctx: Ctx,
  id: string,
  options?: { includeDrafts?: boolean; includeAi?: boolean },
) {
  const collection = await getCollection(ctx, id, { includeAll: options?.includeDrafts });
  const statusClause = options?.includeDrafts ? "" : "AND cd.status = 'published'";
  const visibility = cardVisibilitySql(await currentViewerAccess(ctx));
  const includeAi = options?.includeAi ?? (await botAllowsAiArt(ctx.db, ctx.tenant.id));
  return all<{
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    description: string;
    bio: string | null;
    bio_safe: string | null;
    quote: string | null;
    status: string;
    visibility: string;
    spoiler_level: number;
    attributes_json: string;
    render_url: string | null;
    card_back_url: string | null;
    category_name: string | null;
    tags_json: string | null;
  }>(
    ctx.db,
    `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.description, cd.bio, cd.bio_safe, cd.quote,
            cd.status, cd.visibility, cd.spoiler_level, cd.attributes_json,
            (SELECT ('/media/render/' || vr.asset_id) FROM fb_variants v
              JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
              JOIN fb_artwork_editions e ON e.id = v.edition_id
              JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.tenant_id = e.tenant_id
             WHERE v.card_id = cd.id AND (? = 1 OR sa.origin NOT IN ('ai_assisted','ai_generated'))
             ORDER BY vr.created_at DESC LIMIT 1) AS render_url,
            COALESCE((SELECT a.r2_key FROM fb_assets a WHERE a.id = cd.card_back_asset_id), '/brand/card-back.webp') AS card_back_url,
            cat.name AS category_name,
            (SELECT json_group_array(t.slug) FROM fb_card_tags ct JOIN fb_tags t ON t.id = ct.tag_id WHERE ct.card_id = cd.id) AS tags_json
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id
       LEFT JOIN fb_categories cat ON cat.id = cd.category_id
      WHERE cc.collection_id = ? AND cd.archived_at IS NULL ${statusClause} AND (${visibility.sql})
        AND EXISTS (
          SELECT 1 FROM fb_artwork_editions ae
          JOIN fb_assets asa ON asa.id = ae.subject_asset_id AND asa.tenant_id = ae.tenant_id
          WHERE ae.card_id = cd.id AND ae.status = 'published' AND ae.archived_at IS NULL
            AND (? = 1 OR asa.origin NOT IN ('ai_assisted','ai_generated'))
        )
      ORDER BY cc.sort, cd.name`,
    includeAi ? 1 : 0,
    collection.id,
    ...visibility.params,
    includeAi ? 1 : 0,
  );
}

export async function createCollection(
  ctx: Ctx,
  input: {
    name: string;
    slug?: string;
    description?: string;
    scope: "global" | "bot";
    logoUrl?: string;
    bannerUrl?: string;
    backUrl?: string;
    accent?: string;
    status?: "draft" | "published";
    viewAudience?: "public" | "members" | "private";
    sourceWork?: string;
    sourceContext?: string;
    contentAdvisory?: string;
    featured?: boolean;
  },
  idempotency?: IdempotencyInput,
): Promise<CollectionRow> {
  const user = requireUser(ctx);
  let targetBot: Awaited<ReturnType<typeof botForTenant>> = null;
  if (input.scope === "global") {
    requireGlobalCollectionManager(ctx);
  } else {
    targetBot = await botForTenant(ctx.db, ctx.tenant.id);
    if (!targetBot)
      throw new ApiError(
        403,
        "bot_required",
        "Create or select a Bot before making a Bot collection.",
      );
    if (user.role !== "owner" && !hasCapability(user, "content")) {
      throw new ApiError(
        403,
        "content_capability_required",
        "Your Bot role cannot create collections.",
      );
    }
  }
  const name = input.name.trim().slice(0, 120);
  if (name.length < 2)
    throw new ApiError(422, "collection_name_invalid", "Give the collection a name.");
  const slug = normalizeSlug(input.slug || name);
  if (slug.length < 2)
    throw new ApiError(422, "collection_slug_invalid", "Choose a URL-friendly collection slug.");
  const id = newId("col");
  const now = nowIso();
  // New collections are never public by default. Approval is an explicit
  // Super Admin action, even when a creator asks for a public collection.
  let audience = input.viewAudience ?? "members";
  if (input.featured) requireSuperAdminContent(ctx);
  if (audience === "public") {
    requireSuperAdminContent(ctx);
    if ((input.status ?? "draft") !== "published") {
      throw new ApiError(
        422,
        "public_requires_publish",
        "Publish the collection before approving it for the public showcase.",
      );
    }
  }
  if (input.scope === "bot" && audience === "public") {
    throw new ApiError(
      422,
      "bot_collection_not_public",
      "Bot collections are members-only; public showcase content is curated by the Super Admin.",
    );
  }
  const recover = async (collectionId:string) => {
    try { return (await getCollection(ctx,collectionId,{includeAll:true})) as CollectionRow; }
    catch { throw new ApiError(503,'collection_created_reload','The collection was created, but it could not be loaded. Use the same request key or inspect the collection before retrying.',{collection_id:collectionId}); }
  };
  const auth=collectionWriteGuard(ctx,input.scope,null,audience==='public' || input.featured===true);
  const readPrevious=async () => {
    if (!idempotency) return null;
    const row=await first<{request_digest:string;response_json:string}>(ctx.db,`SELECT request_digest,response_json FROM fb_idempotency_keys WHERE tenant_id=? AND actor_type=? AND actor_id=? AND operation='collection.create' AND idempotency_key=? AND ${auth.sql}`,
      ctx.tenant.id,ctx.actor.type,ctx.actor.id,idempotency.key,...auth.args);
    if (!row) return null;
    if (row.request_digest!==idempotency.digest) throw new ApiError(409,'idempotency_conflict','This key was already used for another collection.');
    return JSON.parse(row.response_json) as {id:string};
  };
  if (idempotency) {
    const previous=await readPrevious();
    if (previous) return recover(previous.id);
  }
  const ownerTenantId =
    input.scope === "global" ? await platformCatalogueTenantId(ctx) : ctx.tenant.id;
  const insert = ctx.db.prepare(
      `INSERT INTO fb_collections
        (id, slug, name, description, scope, owner_tenant_id, logo_url, banner_url, back_url,
         logo_asset_id, banner_asset_id, accent, status,
         view_audience, public_approved_at, public_approved_by, source_work, source_context, content_advisory,
         featured, sort, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      id,
      slug,
      name,
      input.description?.slice(0, 2000) ?? "",
      input.scope,
      ownerTenantId,
      safeUrl(input.logoUrl),
      safeUrl(input.bannerUrl),
      safeUrl(input.backUrl),
      assetIdFromUrl(input.logoUrl),
      assetIdFromUrl(input.bannerUrl),
      input.accent?.slice(0, 30) ?? "brass",
      input.status ?? (input.scope === "global" ? "published" : "draft"),
      audience,
      audience === "public" ? now : null,
      audience === "public" ? user.id : null,
      input.sourceWork?.slice(0, 500) ?? null,
      input.sourceContext?.slice(0, 4000) ?? null,
      input.contentAdvisory?.slice(0, 1000) ?? null,
      input.featured ? 1 : 0,
      user.id,
      now,
      now,
    );
  const brandGuard=await brandLinkGuard(ctx,assetIdFromUrl(input.logoUrl),assetIdFromUrl(input.bannerUrl),assetIdFromUrl(input.backUrl));
  const auditId=newId('aud');
  const brandIndex=await inlineBrandIndex(ctx,id,auditId,safeUrl(input.logoUrl),safeUrl(input.bannerUrl),safeUrl(input.backUrl),assetIdFromUrl(input.logoUrl),assetIdFromUrl(input.bannerUrl));
  try {
    await ctx.db.batch([
      ctx.db.prepare(`SELECT CASE WHEN ${auth.sql} THEN 1 ELSE json('collection_authority_changed') END`).bind(...auth.args),
      ctx.db.prepare(`SELECT CASE WHEN ${brandGuard.sql} THEN 1 ELSE json('brand_upload_changed') END`).bind(...brandGuard.args),
      ...(targetBot ? [ctx.db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_bots WHERE id=? AND tenant_id=? AND status='active') THEN 1 ELSE json('collection_bot_changed') END").bind(targetBot.id,ctx.tenant.id)] : []),
      ...(idempotency ? [idempotencyStatement(ctx,'collection.create',idempotency,{id})] : []),
      insert,
      ...(targetBot ? [ctx.db.prepare("INSERT INTO fb_bot_collections (bot_id,collection_id,enabled,updated_by,updated_at) VALUES (?,?,1,?,?)").bind(targetBot.id,id,user.id,now)] : []),
      ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
        VALUES (?,?,?,?,?,'collection.created','collection',?,?,?,?)`).bind(auditId,ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,id,JSON.stringify({name,slug,scope:input.scope}),ctx.requestId,now),
      ...brandIndex,
    ]);
  } catch (error) {
    if (idempotency) {
      const previous=await readPrevious();
      if (previous) return recover(previous.id);
    }
    const current=await first<{ok:number}>(ctx.db,`SELECT ${auth.sql} AS ok`,...auth.args);
    if (!current?.ok) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed. Reload before retrying.');
    throw error;
  }
  return recover(id);
}

export async function recoverCollectionCreation(ctx: Ctx, key: string) {
  if (!ctx.user || key.length<8 || key.length>200) throw new ApiError(400,'idempotency_key_invalid','Invalid collection request key.');
  const candidate=await first<{id:string;scope:'global'|'bot';view_audience:string;owner_tenant_id:string|null}>(ctx.db,`SELECT c.id,c.scope,c.view_audience,c.owner_tenant_id FROM fb_idempotency_keys k JOIN fb_collections c ON c.id=json_extract(k.response_json,'$.id')
    WHERE k.tenant_id=? AND k.actor_type=? AND k.actor_id=? AND k.operation='collection.create' AND k.idempotency_key=?
      AND (c.scope='global' OR c.owner_tenant_id=?)`,ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,ctx.tenant.id);
  if (!candidate) return {found:false as const};
  const auth=collectionWriteGuard(ctx,candidate.scope,candidate.id,false);
  const allowed=await first<{ok:number}>(ctx.db,`SELECT ${auth.sql} AS ok`,...auth.args);
  if (!allowed?.ok) return {found:false as const};
  return {found:true as const,collection:await getCollection(ctx,candidate.id,{includeAll:true})};
}

export async function updateCollection(
  ctx: Ctx,
  id: string,
  input: {
    name?: string;
    description?: string;
    logoUrl?: string | null;
    bannerUrl?: string | null;
    backUrl?: string | null;
    accent?: string;
    status?: "draft" | "published" | "archived";
    sort?: number;
    viewAudience?: "public" | "members" | "private";
    sourceWork?: string | null;
    sourceContext?: string | null;
    contentAdvisory?: string | null;
    featured?: boolean;
    expectedVersion?: number;
  },
): Promise<CollectionRow> {
  const collection = await getCollection(ctx, id, { includeAll: true });
  assertManage(ctx, collection);
  if (input.expectedVersion !== undefined && input.expectedVersion !== collection.release_version) {
    throw new ApiError(
      409,
      "stale_write",
      "This collection changed since you opened it. Reload before saving.",
      {
        current_version: collection.release_version,
      },
    );
  }
  const publicContentChanged =
    (input.name !== undefined && input.name.trim().slice(0,120) !== collection.name) ||
    (input.description !== undefined && input.description.slice(0,2000) !== collection.description) ||
    (input.logoUrl !== undefined && safeUrl(input.logoUrl) !== collection.logo_url) ||
    (input.bannerUrl !== undefined && safeUrl(input.bannerUrl) !== collection.banner_url) ||
    (input.backUrl !== undefined && safeUrl(input.backUrl) !== collection.back_url) ||
    (input.accent !== undefined && input.accent.slice(0,30) !== collection.accent) ||
    (input.sourceWork !== undefined && (input.sourceWork?.slice(0,500) ?? null) !== collection.source_work) ||
    (input.sourceContext !== undefined && (input.sourceContext?.slice(0,4000) ?? null) !== collection.source_context) ||
    (input.contentAdvisory !== undefined && (input.contentAdvisory?.slice(0,1000) ?? null) !== collection.content_advisory);
  if (publicContentChanged && input.viewAudience === 'public')
    throw new ApiError(409,'public_approval_separate','Save content changes first, then explicitly approve the updated collection for the public showcase.');
  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim().slice(0, 120);
    if (name.length < 2)
      throw new ApiError(422, "collection_name_invalid", "Give the collection a name.");
    updates.push("name = ?");
    values.push(name);
  }
  if (input.description !== undefined) {
    updates.push("description = ?");
    values.push(input.description.slice(0, 2000));
  }
  if (input.logoUrl !== undefined) {
    updates.push("logo_url = ?", "logo_asset_id = ?");
    values.push(safeUrl(input.logoUrl), assetIdFromUrl(input.logoUrl));
  }
  if (input.bannerUrl !== undefined) {
    updates.push("banner_url = ?", "banner_asset_id = ?");
    values.push(safeUrl(input.bannerUrl), assetIdFromUrl(input.bannerUrl));
  }
  if (input.backUrl !== undefined) {
    updates.push("back_url = ?");
    values.push(safeUrl(input.backUrl));
  }
  if (input.accent !== undefined) {
    updates.push("accent = ?");
    values.push(input.accent.slice(0, 30));
  }
  if (input.sourceWork !== undefined) {
    updates.push("source_work = ?");
    values.push(input.sourceWork?.slice(0, 500) ?? null);
  }
  if (input.sourceContext !== undefined) {
    updates.push("source_context = ?");
    values.push(input.sourceContext?.slice(0, 4000) ?? null);
  }
  if (input.contentAdvisory !== undefined) {
    updates.push("content_advisory = ?");
    values.push(input.contentAdvisory?.slice(0, 1000) ?? null);
  }
  if (input.featured !== undefined) {
    if (input.featured) requireSuperAdminContent(ctx);
    updates.push("featured = ?");
    values.push(input.featured ? 1 : 0);
  }
  if (input.viewAudience !== undefined) {
    if (input.viewAudience === "public") {
      requireSuperAdminContent(ctx);
      if ((input.status ?? collection.status) !== "published") {
        throw new ApiError(
          422,
          "public_requires_publish",
          "Publish the collection before approving it for the public showcase.",
        );
      }
      if (collection.scope === "bot") {
        throw new ApiError(
          422,
          "bot_collection_not_public",
          "Bot collections cannot be promoted to the public showcase.",
        );
      }
      updates.push(
        "public_approved_at = COALESCE(public_approved_at, ?)",
        "public_approved_by = COALESCE(public_approved_by, ?)",
      );
      values.push(nowIso(), ctx.user?.id ?? "system");
    } else if (collection.view_audience === "public") {
      // Removing public approval is a deliberate visibility change. The caller
      // must purge the public cache; media reads switch to member-only at once.
      updates.push("public_approved_at = NULL", "public_approved_by = NULL");
    }
    updates.push("view_audience = ?");
    values.push(input.viewAudience);
  } else if (publicContentChanged && collection.view_audience === 'public') {
    updates.push("view_audience = 'members'", 'public_approved_at = NULL', 'public_approved_by = NULL');
  }
  if (input.status !== undefined) {
    if (collection.scope === "global") requireGlobalCollectionManager(ctx, collection.id);
    if (input.status !== collection.status)
      assertTransition("collection", collection.status, input.status);
    if (input.status !== "published" && collection.view_audience === "public") {
      updates.push(
        "view_audience = 'members'",
        "public_approved_at = NULL",
        "public_approved_by = NULL",
      );
    }
    updates.push("status = ?");
    values.push(input.status);
    if (input.status === "archived") {
      updates.push("archived_at = ?");
      values.push(nowIso());
    } else if (collection.archived_at) {
      updates.push("archived_at = NULL");
    }
    if (input.status === "published" && !collection.released_at) {
      updates.push("released_at = ?");
      values.push(nowIso());
    }
  }
  if (input.sort !== undefined) {
    updates.push("sort = ?");
    values.push(Math.trunc(input.sort));
  }
  if (!updates.length) return collection;
  updates.push("updated_at = ?", "release_version = release_version + 1");
  const auth=collectionWriteGuard(ctx,collection.scope,id,input.viewAudience==='public' || input.featured===true);
  const brandGuard=await brandLinkGuard(ctx,input.logoUrl===undefined ? collection.logo_asset_id : assetIdFromUrl(input.logoUrl),input.bannerUrl===undefined ? collection.banner_asset_id : assetIdFromUrl(input.bannerUrl),assetIdFromUrl(input.backUrl===undefined ? collection.back_url : input.backUrl));
  const auditId=newId('aud');
  const brandIndex=await inlineBrandIndex(ctx,id,auditId,input.logoUrl===undefined ? collection.logo_url : safeUrl(input.logoUrl),input.bannerUrl===undefined ? collection.banner_url : safeUrl(input.bannerUrl),input.backUrl===undefined ? collection.back_url : safeUrl(input.backUrl),input.logoUrl===undefined ? collection.logo_asset_id : assetIdFromUrl(input.logoUrl),input.bannerUrl===undefined ? collection.banner_asset_id : assetIdFromUrl(input.bannerUrl));
  values.push(nowIso(), id, collection.release_version, collection.status, collection.archived_at,collection.scope,collection.owner_tenant_id,...auth.args,...brandGuard.args);
  const [, changed] = await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_collections SET ${updates.join(", ")} WHERE id = ? AND release_version = ? AND status = ? AND archived_at IS ? AND scope = ? AND owner_tenant_id IS ? AND ${auth.sql} AND ${brandGuard.sql}`).bind(...values),
    ctx.db.prepare('SELECT changes() AS applied'),
    ctx.db.prepare(`INSERT INTO fb_audit_events
      (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,?,?,?,'collection.updated','collection',?,?,?,? WHERE changes()=1`)
      .bind(auditId,ctx.tenant.id,ctx.actor.type,ctx.actor.id,ctx.actor.representedUserId,id,
        JSON.stringify({fields:Object.keys(input),view_audience:((input.status && input.status !== 'published' && collection.view_audience==='public') || (publicContentChanged && input.viewAudience===undefined && collection.view_audience==='public')) ? 'members' : input.viewAudience ?? collection.view_audience}),ctx.requestId,nowIso()),
    ...brandIndex,
  ]);
  if (Number((changed?.results?.[0] as {applied?:number} | undefined)?.applied) !== 1) throw new ApiError(409,'stale_write','This collection changed since you opened it. Reload before saving.');
  return (await getCollection(ctx, id, { includeAll: true })) as CollectionRow;
}

export async function addCollectionCards(
  ctx: Ctx,
  id: string,
  cardIds: string[],
): Promise<{ added: number }> {
  const collection = await getCollection(ctx, id);
  assertManage(ctx, collection);
  const unique = [...new Set(cardIds)].slice(0, 300);
  if (!unique.length) throw new ApiError(422, "cards_required", "Choose at least one card.");
  const placeholders = unique.map(() => "?").join(",");
  const cards = await all<{ id: string; tenant_id: string }>(
    ctx.db,
    `SELECT id, tenant_id FROM fb_card_definitions WHERE id IN (${placeholders}) AND archived_at IS NULL`,
    ...unique,
  );
  const allowed = cards.filter((card) =>
    collection.scope === "global"
      ? card.tenant_id === collection.owner_tenant_id
      : card.tenant_id === ctx.tenant.id,
  );
  if (allowed.length !== unique.length) {
    throw new ApiError(
      403,
      "card_scope_invalid",
      "One or more cards are outside this collection's catalogue scope.",
    );
  }
  const now = nowIso();
  for (const card of allowed) {
    await ctx.db
      .prepare(
        `INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(collection_id, card_id) DO NOTHING`,
      )
      .bind(collection.id, card.id, card.tenant_id, ctx.user?.id ?? "system", now)
      .run();
  }
  await auditCollection(ctx, "collection.cards.added", id, { count: allowed.length });
  return { added: allowed.length };
}

export async function removeCollectionCard(ctx: Ctx, id: string, cardId: string): Promise<void> {
  const collection = await getCollection(ctx, id);
  assertManage(ctx, collection);
  await ctx.db
    .prepare("DELETE FROM fb_collection_cards WHERE collection_id = ? AND card_id = ?")
    .bind(collection.id, cardId)
    .run();
  await auditCollection(ctx, "collection.card.removed", id, { card_id: cardId });
}

export async function enableCollection(
  ctx: Ctx,
  collectionId: string,
  enabled: boolean,
): Promise<void> {
  const user = requireUser(ctx);
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  if (!bot)
    throw new ApiError(403, "bot_required", "No Bot is attached to this administration area.");
  if (user.role !== "owner" && !hasCapability(user, "content")) {
    throw new ApiError(
      403,
      "content_capability_required",
      "Your Bot role cannot change collection availability.",
    );
  }
  const collection = await getCollection(ctx, collectionId);
  await ctx.db
    .prepare(
      `INSERT INTO fb_bot_collections (bot_id, collection_id, enabled, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, collection_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(bot.id, collection.id, enabled ? 1 : 0, user.id, nowIso())
    .run();
  await auditCollection(
    ctx,
    enabled ? "collection.enabled" : "collection.disabled",
    collection.id,
    { bot_id: bot.id },
  );
}

/**
 * A card in any collection must have at least one enabled collection for the
 * Bot before it can drop. Cards outside collections keep the legacy behaviour.
 */
export async function assertCardEnabledForTenant(
  db: D1Database,
  tenantId: string,
  cardId: string,
): Promise<void> {
  const state = await first<{ collections: number; enabled: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM fb_collection_cards cc WHERE cc.card_id = ?) AS collections,
       (SELECT COUNT(*) FROM fb_collection_cards cc
          JOIN fb_bot_collections bc ON bc.collection_id = cc.collection_id AND bc.enabled = 1
          JOIN fb_bots b ON b.id = bc.bot_id AND b.tenant_id = ?
         WHERE cc.card_id = ?) AS enabled`,
    cardId,
    tenantId,
    cardId,
  );
  if (state && state.collections > 0 && state.enabled === 0) {
    throw new ApiError(
      409,
      "collection_disabled",
      "That card's collection is turned off for this Bot. Nothing was charged.",
    );
  }
}

function assertManage(ctx: Ctx, collection: CollectionRow): void {
  if (collection.scope === "global") {
    requireGlobalCollectionManager(ctx, collection.id);
    return;
  }
  const user = requireUser(ctx);
  if (collection.owner_tenant_id !== ctx.tenant.id)
    throw new ApiError(403, "collection_scope_invalid", "That collection belongs to another Bot.");
  if (user.role !== "owner" && !hasCapability(user, "content")) {
    throw new ApiError(
      403,
      "content_capability_required",
      "Your Bot role cannot manage collections.",
    );
  }
}

export async function setCollectionViewers(
  ctx: Ctx,
  collectionId: string,
  userIds: string[],
): Promise<{ count: number }> {
  const collection = await getCollection(ctx, collectionId, { includeAll: true });
  assertManage(ctx, collection);
  if (collection.view_audience !== "private") {
    throw new ApiError(
      422,
      "collection_not_private",
      "Explicit viewers apply to private collections only.",
    );
  }
  const unique = [...new Set(userIds)].slice(0, 500);
  if (unique.length) {
    const found = await all<{ id: string }>(
      ctx.db,
      `SELECT id FROM fb_users WHERE id IN (${unique.map(() => "?").join(",")}) AND disabled_at IS NULL`,
      ...unique,
    );
    if (found.length !== unique.length)
      throw new ApiError(422, "viewer_unknown", "One or more viewers do not exist.");
  }
  const now = nowIso();
  await ctx.db
    .prepare(
      "UPDATE fb_collection_viewers SET revoked_at = ? WHERE collection_id = ? AND revoked_at IS NULL",
    )
    .bind(now, collection.id)
    .run();
  for (const userId of unique) {
    await ctx.db
      .prepare(
        `INSERT INTO fb_collection_viewers (collection_id, user_id, granted_by, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(collection_id, user_id) DO UPDATE SET revoked_at = NULL, granted_by = excluded.granted_by, created_at = excluded.created_at`,
      )
      .bind(collection.id, userId, ctx.user?.id ?? "system", now)
      .run();
  }
  await auditCollection(ctx, "collection.viewers.updated", collection.id, { count: unique.length });
  return { count: unique.length };
}

export async function listCollectionViewers(ctx: Ctx, collectionId: string) {
  const collection = await getCollection(ctx, collectionId, { includeAll: true });
  assertManage(ctx, collection);
  return all<{ user_id: string; email: string; display_name: string; granted_at: string }>(
    ctx.db,
    `SELECT v.user_id, u.email, u.display_name, v.created_at AS granted_at
       FROM fb_collection_viewers v JOIN fb_users u ON u.id = v.user_id
      WHERE v.collection_id = ? AND v.revoked_at IS NULL ORDER BY u.display_name`,
    collection.id,
  );
}

export async function collectionProgress(ctx: Ctx, collectionId: string) {
  if (ctx.actor.type === "agent") requireScope(ctx, "inventory:read");
  const user = ctx.user;
  const collection = await getCollection(ctx, collectionId);
  const access = await currentViewerAccess(ctx);
  if (user && !access.signedIn) throw new ApiError(403, "membership_required", "Your access to this Bot has changed.");
  const visibility = cardVisibilitySql(access);
  const totals = await first<{ cards: number; variants: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT cd.id) AS cards,
            COUNT(DISTINCT v.id) AS variants
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       LEFT JOIN fb_variants v ON v.card_id = cd.id AND v.status = 'published' AND v.archived_at IS NULL
      WHERE cc.collection_id = ? AND (${visibility.sql})`,
    collection.id,
    ...visibility.params,
  );
  const finishTotals = await all<{
    card_id: string;
    material_key: string;
    effect_key: string | null;
  }>(
    ctx.db,
    `SELECT DISTINCT cd.id AS card_id, m.key AS material_key, fx.key AS effect_key
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       JOIN fb_variants v ON v.card_id = cd.id AND v.status = 'published' AND v.archived_at IS NULL
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE cc.collection_id = ? AND (${visibility.sql})`,
    collection.id,
    ...visibility.params,
  );
  if (!user) {
    return {
      collection: collection.slug,
      audience: collection.view_audience,
      total_cards: totals?.cards ?? 0,
      total_variants: totals?.variants ?? 0,
      owned_cards: 0,
      owned_variants: 0,
      owned_copies: 0,
      duplicates: 0,
      finishes: emptyFinishProgress(finishTotals),
      progress_scope: "visible" as const,
      complete: null,
      variant_complete: null,
    };
  }
  const owned = await first<{ cards: number; variants: number; copies: number }>(
    ctx.db,
    `SELECT COUNT(DISTINCT ci.card_id) AS cards, COUNT(DISTINCT ci.variant_id) AS variants, COUNT(*) AS copies
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
        AND cc.collection_id = ? AND (${visibility.sql})`,
    ctx.tenant.id,
    user.id,
    collection.id,
    ...visibility.params,
  );
  const ownedFinishRows = await all<{
    card_id: string;
    material_key: string;
    effect_key: string | null;
  }>(
    ctx.db,
    `SELECT ci.card_id, m.key AS material_key, fx.key AS effect_key
       FROM fb_card_instances ci
       JOIN fb_card_definitions cd ON cd.id = ci.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
       JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
        AND cc.collection_id = ? AND (${visibility.sql})`,
    ctx.tenant.id,
    user.id,
    collection.id,
    ...visibility.params,
  );
  const totalCards = totals?.cards ?? 0;
  const ownedCards = owned?.cards ?? 0;
  const totalVariants = totals?.variants ?? 0;
  const ownedVariants = owned?.variants ?? 0;
  return {
    collection: collection.slug,
    audience: collection.view_audience,
    total_cards: totalCards,
    total_variants: totalVariants,
    owned_cards: ownedCards,
    owned_variants: ownedVariants,
    owned_copies: owned?.copies ?? 0,
    duplicates: Math.max(0, (owned?.copies ?? 0) - ownedCards),
    finishes: finishProgress(finishTotals, ownedFinishRows),
    progress_scope: "visible" as const,
    complete: access.platformAdmin ? totalCards > 0 && ownedCards >= totalCards : null,
    variant_complete: access.platformAdmin ? totalVariants > 0 && ownedVariants >= totalVariants : null,
  };
}

export async function collectionBinder(ctx: Ctx, collectionId: string) {
  if (ctx.actor.type === "agent") requireScope(ctx, "inventory:read");
  const collection = await getCollection(ctx, collectionId);
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to open the album.");
  const access = await currentViewerAccess(ctx);
  if (!access.signedIn) throw new ApiError(403, "membership_required", "Your access to this Bot has changed.");
  const visibility = cardVisibilitySql(access);
  const rows = await all<{
    id: string;
    slug: string;
    name: string;
    subtitle: string | null;
    status: string;
    render_url: string | null;
    thumbnail_url: string | null;
  }>(
    ctx.db,
    `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.status,
            (SELECT vr.public_url FROM fb_variants v2
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE v2.card_id = cd.id AND v2.status = 'published' AND v2.archived_at IS NULL
              ORDER BY v2.name LIMIT 1) AS render_url,
            (SELECT vr.public_url FROM fb_variants v2
               JOIN fb_variant_renders vr ON vr.variant_id = v2.id AND vr.status = 'published'
              WHERE v2.card_id = cd.id AND v2.status = 'published' AND v2.archived_at IS NULL
              ORDER BY v2.name LIMIT 1) AS thumbnail_url
       FROM fb_collection_cards cc
       JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
      WHERE cc.collection_id = ? AND (${visibility.sql})
      ORDER BY cc.sort, cd.name`,
    collection.id,
    ...visibility.params,
  ).catch(async () => {
    // Older local schemas may not have the ordered material join; the base
    // fields are still useful and the page stays honest about missing media.
    return all<{
      id: string;
      slug: string;
      name: string;
      subtitle: string | null;
      status: string;
      render_url: string | null;
      thumbnail_url: string | null;
    }>(
      ctx.db,
      `SELECT cd.id, cd.slug, cd.name, cd.subtitle, cd.status, NULL AS render_url, NULL AS thumbnail_url
         FROM fb_collection_cards cc
         JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
        WHERE cc.collection_id = ? AND (${visibility.sql}) ORDER BY cc.sort, cd.name`,
      collection.id,
      ...visibility.params,
    );
  });
  const ownedRows = await all<{
    card_id: string;
    instance_id: string;
    material_key: string;
    effect_key: string | null;
    render_url: string | null;
  }>(
    ctx.db,
    `SELECT ci.card_id, ci.id AS instance_id, m.key AS material_key, fx.key AS effect_key,
            (SELECT vr.public_url FROM fb_variant_renders vr WHERE vr.variant_id = ci.variant_id AND vr.status = 'published' LIMIT 1) AS render_url
       FROM fb_card_instances ci
       JOIN fb_collection_cards cc ON cc.card_id = ci.card_id
       JOIN fb_variants v ON v.id = ci.variant_id
       JOIN fb_materials m ON m.id = v.material_id
       LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved') AND cc.collection_id = ?`,
    ctx.tenant.id,
    user.id,
    collection.id,
  );
  const byCard = new Map<
    string,
    { finishes: Set<string>; render_url: string | null; copies: number; instance_id: string }
  >();
  for (const row of ownedRows) {
    const current = byCard.get(row.card_id) ?? {
      finishes: new Set<string>(),
      render_url: null,
      copies: 0,
      instance_id: row.instance_id,
    };
    current.finishes.add(finishKeyOf(row.material_key, row.effect_key));
    current.copies += 1;
    if (!current.render_url) current.render_url = row.render_url;
    byCard.set(row.card_id, current);
  }
  return {
    collection: collection.slug,
    name: collection.name,
    total: rows.length,
    cards: rows.map((row) => {
      const owned = byCard.get(row.id);
      return {
        ...row,
        owned: Boolean(owned),
        copies: owned?.copies ?? 0,
        finishes: owned
          ? [...owned.finishes].filter((finish) =>
              (CORE_FINISHES as readonly string[]).includes(finish),
            )
          : [],
        render_url: owned?.render_url ?? null,
        instance_id: owned?.instance_id ?? null,
      };
    }),
  };
}

const CORE_FINISHES = ["plain", "silver", "gold", "holographic"] as const;

function finishKeyOf(material: string, effect: string | null): string {
  if (effect === "holographic" || material === "diamond") return "holographic";
  if (material === "silver") return "silver";
  if (material === "gold") return "gold";
  if (material === "plain") return "plain";
  return "other";
}

function emptyFinishProgress(
  rows: Array<{ card_id: string; material_key: string; effect_key: string | null }>,
) {
  const out: Record<string, { owned: number; total: number }> = {};
  for (const finish of CORE_FINISHES) out[finish] = { owned: 0, total: 0 };
  const totals = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = finishKeyOf(row.material_key, row.effect_key);
    if (!totals.has(key)) totals.set(key, new Set());
    totals.get(key)!.add(row.card_id);
  }
  for (const finish of CORE_FINISHES) out[finish]!.total = totals.get(finish)?.size ?? 0;
  return out;
}

function finishProgress(
  totalsRows: Array<{ card_id: string; material_key: string; effect_key: string | null }>,
  ownedRows: Array<{ card_id: string; material_key: string; effect_key: string | null }>,
) {
  const out = emptyFinishProgress(totalsRows);
  const owned = new Map<string, Set<string>>();
  for (const row of ownedRows) {
    const key = finishKeyOf(row.material_key, row.effect_key);
    if (!owned.has(key)) owned.set(key, new Set());
    owned.get(key)!.add(row.card_id);
  }
  for (const finish of CORE_FINISHES) out[finish]!.owned = owned.get(finish)?.size ?? 0;
  return out;
}

function assetIdFromUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  const match = value.trim().match(/^\/media\/asset\/([A-Za-z0-9_-]+)$/);
  return match ? match[1]! : null;
}

function safeUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (parseCollectionAssetUrl(trimmed) && !/^\/media\/asset\/[A-Za-z0-9_-]+$/.test(trimmed))
    throw new ApiError(422,'collection_asset_url_invalid','Use the exact local image URL without a host, query or fragment.');
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed.slice(0, 500);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") return url.toString().slice(0, 500);
  } catch {
    return null;
  }
  return null;
}

async function auditCollection(
  ctx: Ctx,
  action: string,
  collectionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'collection', ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.representedUserId,
      action,
      collectionId,
      JSON.stringify(metadata),
      ctx.requestId,
      nowIso(),
    )
    .run()
    .catch(() => undefined);
}
