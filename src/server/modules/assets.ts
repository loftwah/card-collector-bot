import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { imageSize } from "image-size";
import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { canonicalJson, newId, sha256Hex } from "../ids";
import { audit } from "../http";
import { collectionWriteGuard, legacyBrandUrlFence } from './collections';

export type AssetKind =
  "subject" | "background" | "frame" | "material" | "effect" | "brand" | "render";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 5000;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Read exactly the object version and bytes recorded by a future render manifest.
 * This does not attest that a renderer consumed these bytes or authorise publication.
 */
export async function readVerifiedRenderInput(
  media: R2Bucket,
  expected: { key: string; version: string; etag: string; sha256: string; bytes: number },
): Promise<Uint8Array> {
  const changed = () => new ApiError(409, "render_input_changed", "A render input is unavailable or no longer matches its recorded version.");
  if (!expected.key || expected.key.length > 1024 || !expected.version || !expected.etag ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 1 || expected.bytes > MAX_BYTES) throw changed();
  const object = await media.get(expected.key, { onlyIf: { etagMatches: expected.etag } });
  if (!object || !("body" in object) || object.version !== expected.version || object.size !== expected.bytes) throw changed();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== expected.bytes || await sha256Hex(bytes) !== expected.sha256) throw changed();
  return bytes;
}

export interface AssetRow {
  id: string;
  tenant_id: string;
  kind: AssetKind;
  name: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  r2_key: string;
  sha256: string;
  visibility: "private" | "public_export";
  access_classification: "public" | "member" | "private";
  role: string | null;
  processing_state: string;
  revision: number;
  derivative_of_asset_id: string | null;
  dependencies_json: string;
  provenance_json: string;
  official: number;
  review_status: string;
  source_repo: string | null;
  source_path: string | null;
  source_commit: string | null;
  source_logical_id: string | null;
  credit: string | null;
  archived_at: string | null;
  created_at: string;
}

export function detectMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return "image/webp";
  return null;
}

/** Idempotent collection-brand upload. Reservations track an isolated R2 key;
 * existing shared assets are never revised or deleted by this path. */
export async function uploadCollectionBrand(ctx: Ctx, input:{bytes:Uint8Array;declaredMime?:string;name:string;role:string;scope:'global'|'bot';access:'public'|'member'|'private';provenance:string}, key:string):Promise<AssetRow> {
  return uploadCollectionBrandCandidate(ctx,input,key);
}

// Uploading creates private staging only; public release requires separate review.
async function uploadCollectionBrandCandidate(ctx: Ctx, input:{bytes:Uint8Array;declaredMime?:string;name:string;role:string;scope:'global'|'bot';access:'public'|'member'|'private';provenance:string}, key:string):Promise<AssetRow> {
  const schema=await first<{n:number}>(ctx.db,"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('fb_collection_brand_uploads','fb_brand_url_dirty','fb_brand_url_refs')");
  if (Number(schema?.n ?? 0)!==3) throw new ApiError(503,'brand_upload_schema_unavailable','Collection image uploads are not ready yet.');
  if (key.length<8 || key.length>200) throw new ApiError(422,'idempotency_key_invalid','Provide an upload request key.');
  if (!['logo','cover'].includes(input.role) || !['global','bot'].includes(input.scope) || !['public','member','private'].includes(input.access) || (input.scope==='bot' && input.access==='public') || input.name.length>240 || input.provenance.length>2000)
    throw new ApiError(422,'brand_upload_invalid','The collection image details are invalid.');
  if (!input.bytes.length || input.bytes.length>MAX_BYTES) throw new ApiError(422,'asset_size_invalid','Choose an image no larger than 8 MB.');
  const mime=detectMime(input.bytes);
  if (!mime || !ALLOWED.has(mime) || (input.declaredMime && input.declaredMime!==mime)) throw new ApiError(422,'asset_type_invalid','Choose a valid PNG, JPEG or WebP image.');
  let dimensions:{width?:number;height?:number};
  try { dimensions=imageSize(input.bytes); } catch { throw new ApiError(422,'asset_corrupt','The image could not be read.'); }
  const width=dimensions.width ?? 0,height=dimensions.height ?? 0;
  if (!width || !height || width>MAX_DIMENSION || height>MAX_DIMENSION) throw new ApiError(422,'asset_dimensions_invalid','Image dimensions are invalid.');
  const hash=await sha256Hex(input.bytes);
  const normalized={hash,mime,name:input.name.trim() || 'Untitled asset',role:input.role,scope:input.scope,access:input.access,provenance:input.provenance};
  const digest=await sha256Hex(canonicalJson(normalized));
  const baseAuth=collectionWriteGuard(ctx,input.scope,null,input.access==='public');
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${baseAuth.sql}`,...baseAuth.args)) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  const baseRead=()=>first<{request_digest:string;asset_id:string;r2_key:string;status:string;object_version:string|null;object_etag:string|null;content_sha256:string|null}>(ctx.db,`SELECT request_digest,asset_id,r2_key,status,object_version,object_etag,content_sha256 FROM fb_collection_brand_uploads WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND ${baseAuth.sql}`,ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,...baseAuth.args);
  const existing=await baseRead();
  const assetId=existing?.asset_id ?? newId('ast'),r2Key=`collection-brand-v1/${hash}/${assetId}`;
  const makeAuth=async (target:string)=>{const fence=await legacyBrandUrlFence(ctx,target);return {sql:`(${baseAuth.sql}) AND (${fence.sql})`,args:[...baseAuth.args,...fence.args]};};
  let auth=await makeAuth(assetId);
  const now=nowIso();
  await ctx.db.prepare(`INSERT OR IGNORE INTO fb_collection_brand_uploads
    (tenant_id,actor_type,actor_id,idempotency_key,request_digest,upload_scope,asset_id,r2_key,status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,'pending',?,? WHERE ${auth.sql}`)
    .bind(ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,digest,input.scope,assetId,r2Key,now,now,...auth.args).run();
  const read=()=>first<{request_digest:string;asset_id:string;r2_key:string;status:string;object_version:string|null;object_etag:string|null;content_sha256:string|null}>(ctx.db,`SELECT request_digest,asset_id,r2_key,status,object_version,object_etag,content_sha256 FROM fb_collection_brand_uploads
    WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND ${auth.sql}`,ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,...auth.args);
  let reservation=await baseRead();
  if (!reservation) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  if (reservation.asset_id!==assetId) auth=await makeAuth(reservation.asset_id);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${auth.sql}`,...auth.args)) throw new ApiError(409,'brand_reference_changed','Collection image references changed. Retry the upload.');
  if (reservation.request_digest!==digest) throw new ApiError(409,'idempotency_conflict','This upload key belongs to different image data or details.');
  if (reservation.status==='abandoned') throw new ApiError(409,'brand_upload_abandoned','This upload was abandoned. Choose the image again to start a new upload.');
  const completed=async()=>{
    const row=await first<AssetRow>(ctx.db,`SELECT * FROM fb_assets WHERE id=? AND tenant_id=? AND archived_at IS NULL AND ${auth.sql}`,reservation!.asset_id,ctx.tenant.id,...auth.args);
    if (!row) throw new ApiError(409,'brand_upload_unavailable','The saved upload is unavailable.');
    if (!reservation!.object_version || !reservation!.object_etag || reservation!.content_sha256!==hash || row.sha256!==hash || row.r2_key!==reservation!.r2_key)
      throw new ApiError(409,'brand_upload_changed','The saved upload does not match this request.');
    await readVerifiedRenderInput(ctx.media,{key:row.r2_key,version:reservation!.object_version,etag:reservation!.object_etag,sha256:hash,bytes:row.bytes});
    const current=await first<AssetRow>(ctx.db,`SELECT a.* FROM fb_assets a WHERE a.id=? AND a.tenant_id=? AND a.archived_at IS NULL AND a.r2_key=? AND a.sha256=? AND a.revision=? AND a.bytes=? AND a.mime=?
      AND EXISTS (SELECT 1 FROM fb_collection_brand_uploads p WHERE p.tenant_id=a.tenant_id AND p.asset_id=a.id AND p.r2_key=a.r2_key AND p.status='completed' AND p.object_version=? AND p.object_etag=? AND p.content_sha256=?) AND ${auth.sql}`,
      row.id,ctx.tenant.id,row.r2_key,row.sha256,row.revision,row.bytes,row.mime,reservation!.object_version,reservation!.object_etag,hash,...auth.args);
    if (!current) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
    return current;
  };
  if (reservation.status==='completed') return completed();
  await ctx.media.put(reservation.r2_key,input.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:mime,contentDisposition:'inline'},customMetadata:{tenant:ctx.tenant.id,sha256:hash,kind:'brand'}});
  const object=await ctx.media.get(reservation.r2_key);
  if (!object || !('body' in object) || object.size!==input.bytes.length || await sha256Hex(new Uint8Array(await object.arrayBuffer()))!==hash)
    throw new ApiError(409,'brand_upload_changed','The staged upload does not match this request. It has been retained for review.');
  try {
    await ctx.db.batch([
      ctx.db.prepare(`SELECT CASE WHEN ${auth.sql} AND EXISTS (SELECT 1 FROM fb_collection_brand_uploads WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND request_digest=? AND asset_id=? AND r2_key=? AND status='pending') THEN 1 ELSE json('brand_upload_changed') END`)
        .bind(...auth.args,ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,digest,reservation.asset_id,reservation.r2_key),
      ctx.db.prepare(`INSERT INTO fb_assets (id,tenant_id,kind,name,mime,width,height,bytes,r2_key,sha256,visibility,access_classification,role,official,review_status,provenance_json,created_at)
        VALUES (?,?,'brand',?,?,?,?,?,?,?,?,?,?,0,'unreviewed',?,?)`)
        .bind(reservation.asset_id,ctx.tenant.id,normalized.name,mime,width,height,input.bytes.length,reservation.r2_key,hash,'private','private',input.role,JSON.stringify({note:input.provenance}),now),
      ctx.db.prepare("UPDATE fb_collection_brand_uploads SET status='completed',object_version=?,object_etag=?,content_sha256=?,updated_at=? WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND status='pending'")
        .bind(object.version,object.etag,hash,nowIso(),ctx.tenant.id,ctx.actor.type,ctx.actor.id,key),
      auditStatementSafe(ctx,'asset.uploaded',reservation.asset_id,{kind:'brand',sha256:hash,staged_receipt:true}),
    ]);
  } catch (error) {
    reservation=await read();
    if (reservation?.request_digest===digest && reservation.status==='completed') return completed();
    throw error;
  }
  reservation=await read();
  if (!reservation || reservation.status!=='completed') throw new ApiError(409,'brand_upload_unavailable','The saved upload is unavailable.');
  return completed();
}

export async function uploadAsset(
  ctx: Ctx,
  input: {
    kind: AssetKind;
    name: string;
    bytes: Uint8Array;
    declaredMime?: string;
    visibility?: "private" | "public_export";
    accessClassification?: "public" | "member" | "private";
    role?: string;
    official?: boolean;
    reviewStatus?: "unreviewed" | "reviewed" | "approved" | "rejected" | "placeholder";
    provenance?: Record<string, unknown>;
    source?: {
      repo?: string;
      path?: string;
      commit?: string;
      logicalId?: string;
      credit?: string;
    };
  },
): Promise<AssetRow> {
  if (input.bytes.length === 0)
    throw new ApiError(422, "asset_empty", "The uploaded file is empty.");
  if (input.bytes.length > MAX_BYTES)
    throw new ApiError(413, "asset_too_large", "Assets must be 8 MB or smaller.");
  const mime = detectMime(input.bytes);
  if (!mime || !ALLOWED.has(mime)) {
    throw new ApiError(422, "asset_type_invalid", "Only PNG, JPEG and WebP images are accepted.");
  }
  if (input.declaredMime && input.declaredMime !== mime) {
    throw new ApiError(
      422,
      "asset_mime_mismatch",
      "The file content does not match its declared image type.",
    );
  }
  let dimensions: { width?: number; height?: number };
  try {
    dimensions = imageSize(input.bytes);
  } catch {
    throw new ApiError(
      422,
      "asset_corrupt",
      "The image dimensions could not be read. The file may be corrupt.",
    );
  }
  const width = dimensions.width ?? 0;
  const height = dimensions.height ?? 0;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ApiError(
      422,
      "asset_dimensions_invalid",
      "Image dimensions must be between 1 and 5000 pixels.",
    );
  }
  const hash = await sha256Hex(input.bytes);
  const existing = await first<AssetRow>(
    ctx.db,
    "SELECT * FROM fb_assets WHERE tenant_id = ? AND sha256 = ? AND kind = ? AND archived_at IS NULL AND r2_key NOT LIKE 'collection-brand-v1/%' AND r2_key NOT LIKE 'bound-render-stage-v1/%'",
    ctx.tenant.id,
    hash,
    input.kind,
  );
  if (existing) {
    // The bytes are unchanged, but provenance, credit, review status and access
    // metadata may have been corrected. Keep the stable asset ID and R2 object,
    // and update the authoritative metadata instead of silently returning stale
    // values.
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE fb_assets SET
             name = ?, visibility = ?, access_classification = ?, role = ?, official = ?,
             review_status = ?, provenance_json = ?, source_repo = ?, source_path = ?,
             source_commit = ?, source_logical_id = ?, credit = ?
           WHERE id = ? AND tenant_id = ?`,
        )
        .bind(
          input.name.trim() || "Untitled asset",
          input.visibility ??
            (input.accessClassification === "public" ? "public_export" : "private"),
          input.accessClassification ?? "private",
          input.role ?? input.kind,
          input.official ? 1 : 0,
          input.reviewStatus ?? "unreviewed",
          JSON.stringify(input.provenance ?? {}),
          input.source?.repo ?? null,
          input.source?.path ?? null,
          input.source?.commit ?? null,
          input.source?.logicalId ?? null,
          input.source?.credit ?? null,
          existing.id,
          ctx.tenant.id,
        ),
      auditStatementSafe(ctx, "asset.metadata_revised", existing.id, {
        kind: input.kind,
        sha256: hash,
      }),
    ]);
    return (await first<AssetRow>(
      ctx.db,
      "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ?",
      existing.id,
      ctx.tenant.id,
    ))!;
  }
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
  // The storage key is kind-scoped. Identical bytes reused as a different
  // asset kind must not overwrite or share an object with the original asset;
  // existing keys are retained so published URLs and references stay valid.
  const key = `tenants/${ctx.tenant.id}/assets/${input.kind}/${hash}.${ext}`;
  await ctx.media.put(key, input.bytes, {
    httpMetadata: { contentType: mime, contentDisposition: "inline" },
    customMetadata: { tenant: ctx.tenant.id, sha256: hash, kind: input.kind },
  });
  const id = newId("ast");
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_assets
          (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility,
           access_classification, role, official, review_status, provenance_json,
           source_repo, source_path, source_commit, source_logical_id, credit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ctx.tenant.id,
        input.kind,
        input.name.trim() || "Untitled asset",
        mime,
        width,
        height,
        input.bytes.length,
        key,
        hash,
        input.visibility ?? (input.accessClassification === "public" ? "public_export" : "private"),
        input.accessClassification ?? "private",
        input.role ?? input.kind,
        input.official ? 1 : 0,
        input.reviewStatus ?? "unreviewed",
        JSON.stringify(input.provenance ?? {}),
        input.source?.repo ?? null,
        input.source?.path ?? null,
        input.source?.commit ?? null,
        input.source?.logicalId ?? null,
        input.source?.credit ?? null,
        nowIso(),
      ),
    auditStatementSafe(ctx, "asset.uploaded", id, {
      kind: input.kind,
      sha256: hash,
      bytes: input.bytes.length,
    }),
  ]);
  return (await first<AssetRow>(ctx.db, "SELECT * FROM fb_assets WHERE id = ?", id))!;
}

function auditStatementSafe(
  ctx: Ctx,
  action: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  return ctx.db
    .prepare(
      `INSERT INTO fb_audit_events
        (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id,
         metadata_json, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'asset', ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      ctx.tenant.id,
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.representedUserId,
      action,
      objectId,
      JSON.stringify(metadata),
      ctx.requestId,
      nowIso(),
    );
}

export async function listAssets(ctx: Ctx, kind?: AssetKind) {
  return all<AssetRow>(
    ctx.db,
    `SELECT * FROM fb_assets WHERE tenant_id = ? AND archived_at IS NULL AND r2_key NOT LIKE 'collection-brand-v1/%' AND r2_key NOT LIKE 'bound-render-stage-v1/%' ${kind ? "AND kind = ?" : ""} ORDER BY created_at DESC LIMIT 500`,
    ...(kind ? [ctx.tenant.id, kind] : [ctx.tenant.id]),
  );
}

export async function getAsset(ctx: Ctx, id: string): Promise<AssetRow> {
  const asset = await first<AssetRow>(
    ctx.db,
    "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ?",
    id,
    ctx.tenant.id,
  );
  if (!asset) throw new ApiError(404, "asset_not_found", "Asset not found.");
  return asset;
}

export async function readAsset(media: R2Bucket, asset: AssetRow, db?: D1Database): Promise<ArrayBuffer> {
  if (asset.r2_key.startsWith('bound-render-stage-v1/')) {
    if (!db) throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    const pin=await first<{object_version:string;object_etag:string;content_sha256:string;bytes:number;mime:string}>(db,`SELECT p.object_version,p.object_etag,p.content_sha256,p.bytes,p.mime FROM fb_bound_render_outputs p
      JOIN fb_bound_render_jobs j ON j.id=p.job_id AND j.tenant_id=p.tenant_id AND j.status='succeeded'
      WHERE p.tenant_id=? AND p.asset_id=? AND p.r2_key=?`,asset.tenant_id,asset.id,asset.r2_key);
    if (!pin || pin.content_sha256!==asset.sha256 || pin.bytes!==asset.bytes || pin.mime!==asset.mime)
      throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    const bytes=await readVerifiedRenderInput(media,{key:asset.r2_key,version:pin.object_version,etag:pin.object_etag,sha256:pin.content_sha256,bytes:pin.bytes});
    const current=await first(db,`SELECT 1 FROM fb_bound_render_outputs p JOIN fb_bound_render_jobs j ON j.id=p.job_id AND j.tenant_id=p.tenant_id AND j.status='succeeded'
      JOIN fb_assets a ON a.id=p.asset_id AND a.tenant_id=p.tenant_id AND a.archived_at IS NULL AND a.processing_state='ready'
      WHERE p.tenant_id=? AND p.asset_id=? AND p.r2_key=? AND p.object_version=? AND p.object_etag=? AND p.content_sha256=? AND p.bytes=? AND p.mime=?
        AND a.r2_key=p.r2_key AND a.sha256=p.content_sha256 AND a.bytes=p.bytes AND a.mime=p.mime`,asset.tenant_id,asset.id,asset.r2_key,pin.object_version,pin.object_etag,pin.content_sha256,pin.bytes,pin.mime);
    if (!current) throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    return bytes.slice().buffer;
  }
  if (asset.r2_key.startsWith('collection-brand-v1/')) {
    if (!db) throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    const pin=await first<{object_version:string;object_etag:string;content_sha256:string}>(db,`SELECT object_version,object_etag,content_sha256 FROM fb_collection_brand_uploads WHERE tenant_id=? AND asset_id=? AND r2_key=? AND status='completed'`,asset.tenant_id,asset.id,asset.r2_key);
    if (!pin || pin.content_sha256!==asset.sha256 || !pin.object_version || !pin.object_etag)
      throw new ApiError(410,'asset_missing','The stored asset is unavailable.');
    const bytes=await readVerifiedRenderInput(media,{key:asset.r2_key,version:pin.object_version,etag:pin.object_etag,sha256:pin.content_sha256,bytes:asset.bytes});
    return bytes.slice().buffer;
  }
  const object = await media.get(asset.r2_key);
  if (!object)
    throw new ApiError(
      410,
      "asset_missing",
      "The stored asset is missing. A render job can rebuild a card from its source.",
    );
  return object.arrayBuffer();
}

/** Explicit human review of an already linked, version-pinned collection image. */
export async function previewCollectionBrandRelease(ctx: Ctx, collectionId: string, assetId: string) {
  const auth=collectionWriteGuard(ctx,'global',collectionId,true);
  const legacy=await legacyBrandUrlFence(ctx,assetId);
  const load=()=>first<{collection_id:string;collection_name:string;collection_version:number;asset_id:string;asset_revision:number;object_version:string;sha256:string;slot:'logo'|'cover';mime:string;bytes:number}>(ctx.db,`SELECT c.id AS collection_id,c.name AS collection_name,c.release_version AS collection_version,a.id AS asset_id,a.revision AS asset_revision,p.object_version,a.sha256,a.role AS slot,a.mime,a.bytes
    FROM fb_collections c JOIN fb_assets a ON a.id=? AND a.tenant_id=? AND a.archived_at IS NULL AND a.processing_state='ready'
    JOIN fb_collection_brand_uploads p ON p.asset_id=a.id AND p.tenant_id=a.tenant_id AND p.r2_key=a.r2_key AND p.status='completed' AND p.content_sha256=a.sha256
    WHERE c.id=? AND c.scope='global' AND c.status='published' AND c.archived_at IS NULL AND c.view_audience='public' AND c.public_approved_at IS NOT NULL
      AND ((a.role='logo' AND c.logo_asset_id=a.id) OR (a.role='cover' AND c.banner_asset_id=a.id)) AND ${auth.sql} AND ${legacy.sql}`,assetId,ctx.tenant.id,collectionId,...auth.args,...legacy.args);
  const before=await load();
  if (!before) throw new ApiError(404,'brand_review_unavailable','This image is not available for public review.');
  const asset=await getAsset(ctx,assetId);
  await readAsset(ctx.media,asset,ctx.db);
  const after=await load();
  if (!after || JSON.stringify(after)!==JSON.stringify(before)) throw new ApiError(409,'brand_release_changed','The collection image changed. Reload it before reviewing.');
  return {...after,preview_url:`/media/asset/${assetId}`};
}

export async function approveCollectionBrandRelease(ctx: Ctx, collectionId: string, assetId: string, collectionVersion: number, expectedSha256: string, assetRevision: number, objectVersion: string): Promise<void> {
  if (!Number.isSafeInteger(collectionVersion) || collectionVersion<1 || !Number.isSafeInteger(assetRevision) || assetRevision<1 || !objectVersion || objectVersion.length>200 || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new ApiError(422,'brand_release_invalid','Reload the collection image before reviewing it.');
  const auth=collectionWriteGuard(ctx,'global',collectionId,true);
  if (!await first<{ok:number}>(ctx.db,`SELECT 1 AS ok WHERE ${auth.sql}`,...auth.args))
    throw new ApiError(403,'collection_authority_changed','Your collection authority changed.');
  const legacy=await legacyBrandUrlFence(ctx,assetId);
  const asset=await getAsset(ctx,assetId);
  if (!asset.r2_key.startsWith('collection-brand-v1/') || asset.sha256!==expectedSha256 || asset.revision!==assetRevision || asset.archived_at || asset.processing_state!=='ready' || !['logo','cover'].includes(asset.role ?? '') || !ALLOWED.has(asset.mime))
    throw new ApiError(409,'brand_release_changed','The collection image changed. Reload it before reviewing.');
  await readAsset(ctx.media,asset,ctx.db);
  const id=newId('cbr'),now=nowIso();
  const pin=await first<{object_version:string;content_sha256:string}>(ctx.db,`SELECT object_version,content_sha256 FROM fb_collection_brand_uploads WHERE tenant_id=? AND asset_id=? AND r2_key=? AND status='completed'`,ctx.tenant.id,asset.id,asset.r2_key);
  if (!pin?.object_version || pin.object_version!==objectVersion || pin.content_sha256!==expectedSha256) throw new ApiError(409,'brand_release_changed','The collection image changed. Reload it before reviewing.');
  await ctx.db.batch([
    ctx.db.prepare(`SELECT CASE WHEN ${auth.sql} AND EXISTS (SELECT 1 FROM fb_collections c JOIN fb_assets a ON a.id=? AND a.tenant_id=? AND a.archived_at IS NULL
      JOIN fb_collection_brand_uploads p ON p.asset_id=a.id AND p.tenant_id=a.tenant_id AND p.r2_key=a.r2_key AND p.status='completed'
      WHERE c.id=? AND c.scope='global' AND c.status='published' AND c.archived_at IS NULL AND c.view_audience='public' AND c.public_approved_at IS NOT NULL
      AND c.release_version=? AND ((a.role='logo' AND c.logo_asset_id=a.id) OR (a.role='cover' AND c.banner_asset_id=a.id)) AND a.sha256=? AND p.content_sha256=? AND p.object_version=?
      AND a.revision=? AND a.mime=? AND a.bytes=? AND a.role=? AND a.processing_state='ready') AND ${legacy.sql}
      THEN 1 ELSE json('brand_release_changed') END`).bind(...auth.args,assetId,ctx.tenant.id,collectionId,collectionVersion,expectedSha256,expectedSha256,pin.object_version,asset.revision,asset.mime,asset.bytes,asset.role,...legacy.args),
    ctx.db.prepare(`INSERT INTO fb_collection_brand_releases (id,tenant_id,collection_id,collection_version,asset_id,object_version,content_sha256,asset_revision,mime,bytes,role,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id,ctx.tenant.id,collectionId,collectionVersion,assetId,pin.object_version,expectedSha256,asset.revision,asset.mime,asset.bytes,asset.role,ctx.user!.id,now),
    auditStatementSafe(ctx,'collection.brand_approved',assetId,{collection_id:collectionId,collection_version:collectionVersion,sha256:expectedSha256}),
  ]);
}

/** Abandon only this actor's unreferenced upload. Objects and asset records remain intact. */
export async function abandonCollectionBrandUpload(ctx: Ctx, key: string, scope: 'global'|'bot'): Promise<void> {
  if (key.length<8 || key.length>200 || !['global','bot'].includes(scope)) throw new ApiError(422,'brand_upload_invalid','The upload details are invalid.');
  const auth=collectionWriteGuard(ctx,scope,null,false);
  const receipt=await first<{asset_id:string;status:string}>(ctx.db,`SELECT asset_id,status FROM fb_collection_brand_uploads WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND upload_scope=? AND ${auth.sql}`,ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,scope,...auth.args);
  if (!receipt) throw new ApiError(403,'collection_authority_changed','Your collection access or recent sign-in changed.');
  if (receipt.status==='abandoned') return;
  const legacy=await legacyBrandUrlFence(ctx,receipt.asset_id);
  try { await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_collection_brand_uploads SET status='abandoned',updated_at=?
      WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND upload_scope=? AND status IN ('pending','completed') AND ${auth.sql}
      AND NOT EXISTS (SELECT 1 FROM fb_collections c WHERE c.logo_asset_id=fb_collection_brand_uploads.asset_id OR c.banner_asset_id=fb_collection_brand_uploads.asset_id)
      AND ${legacy.sql}
      AND NOT EXISTS (SELECT 1 FROM fb_artwork_editions e WHERE e.subject_asset_id=fb_collection_brand_uploads.asset_id OR e.background_asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_card_definitions c WHERE c.card_back_asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_print_proposals p WHERE p.source_asset_id=fb_collection_brand_uploads.asset_id OR p.artwork_asset_id=fb_collection_brand_uploads.asset_id OR p.background_asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_variant_renders v WHERE v.asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_variant_back_renders v WHERE v.asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_asset_derivatives d WHERE d.source_asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_collection_art_reviews r WHERE r.mark_asset_id=fb_collection_brand_uploads.asset_id OR r.cover_asset_id=fb_collection_brand_uploads.asset_id OR r.back_asset_id=fb_collection_brand_uploads.asset_id OR r.evidence_asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_collection_brand_releases r WHERE r.asset_id=fb_collection_brand_uploads.asset_id)
      AND NOT EXISTS (SELECT 1 FROM fb_assets a WHERE a.derivative_of_asset_id=fb_collection_brand_uploads.asset_id OR EXISTS
        (SELECT 1 FROM json_each(CASE WHEN json_valid(a.dependencies_json) THEN a.dependencies_json ELSE '[]' END) d WHERE d.value=fb_collection_brand_uploads.asset_id))`)
      .bind(nowIso(),ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,scope,...auth.args,...legacy.args),
    ctx.db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('brand_upload_not_abandoned') END"),
    auditStatementSafe(ctx,'asset.upload_abandoned',key,{scope}),
  ]); } catch (error) {
    const previous=await first<{status:string}>(ctx.db,`SELECT status FROM fb_collection_brand_uploads WHERE tenant_id=? AND actor_type=? AND actor_id=? AND idempotency_key=? AND upload_scope=? AND ${auth.sql}`,
      ctx.tenant.id,ctx.actor.type,ctx.actor.id,key,scope,...auth.args);
    if (previous?.status==='abandoned') return;
    throw error;
  }
}

export async function assetUrl(asset: AssetRow): Promise<string> {
  return asset.visibility === "public_export"
    ? `/media/public/${asset.id}`
    : `/media/asset/${asset.id}`;
}

export async function createRenderAsset(
  ctx: Ctx,
  input: { variantId: string; recipeId: string; bytes: Uint8Array; mime?: string },
) {
  const mime = detectMime(input.bytes);
  if (!mime || !["image/png", "image/webp"].includes(mime)) {
    throw new ApiError(422, "render_type_invalid", "Rendered cards must be PNG or WebP.");
  }
  const dimensions = imageSize(input.bytes);
  if (!dimensions.width || !dimensions.height)
    throw new ApiError(422, "render_dimensions_invalid", "Rendered image has no dimensions.");
  const hash = await sha256Hex(input.bytes);
  const ext = mime === "image/png" ? "png" : "webp";
  const key = `tenants/${ctx.tenant.id}/renders/${hash}.${ext}`;
  await ctx.media.put(key, input.bytes, {
    httpMetadata: { contentType: mime, contentDisposition: "inline" },
    customMetadata: { tenant: ctx.tenant.id, variant: input.variantId, recipe: input.recipeId },
  });
  const existingAsset = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_assets WHERE tenant_id = ? AND r2_key = ?",
    ctx.tenant.id,
    key,
  );
  const assetId = existingAsset?.id ?? newId("rnd");
  const now = nowIso();
  const publicUrl = `/media/render/${assetId}`;
  const variant = await first<{ card_id: string; source_hash: string | null }>(
    ctx.db,
    `SELECT v.card_id, e.source_hash FROM fb_variants v
       JOIN fb_artwork_editions e ON e.id = v.edition_id AND e.tenant_id = v.tenant_id
      WHERE v.id = ? AND v.tenant_id = ?`,
    input.variantId,
    ctx.tenant.id,
  );
  const sourceHash = variant?.source_hash ?? null;
  const { effectiveCardAudience } = await import("./visibility");
  const audience = variant ? await effectiveCardAudience(ctx, variant.card_id) : "members";
  const access = audience === "public" ? "public" : audience === "members" ? "member" : "private";
  const statements = [
    ...(existingAsset
      ? []
      : [
          ctx.db
            .prepare(
              `INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility,
                                      access_classification, role, processing_state, review_status, created_at)
               VALUES (?, ?, 'render', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'render', 'ready', 'approved', ?)`,
            )
            .bind(
              assetId,
              ctx.tenant.id,
              `Card render ${input.variantId}`,
              mime,
              dimensions.width,
              dimensions.height,
              input.bytes.length,
              key,
              hash,
              access === "public" ? "public_export" : "private",
              access,
              now,
            ),
        ]),
    ctx.db
      .prepare(
        `INSERT INTO fb_variant_renders
          (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, source_hash, status, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
         ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET
           asset_id = excluded.asset_id, public_url = excluded.public_url, width = excluded.width,
           height = excluded.height, sha256 = excluded.sha256, source_hash = excluded.source_hash,
           status = 'published', published_at = excluded.published_at`,
      )
      .bind(
        newId("vr"),
        ctx.tenant.id,
        input.variantId,
        input.recipeId,
        assetId,
        publicUrl,
        dimensions.width,
        dimensions.height,
        hash,
        sourceHash,
        now,
        now,
      ),
    auditStatementSafe(ctx, "render.published", assetId, {
      variant_id: input.variantId,
      recipe_id: input.recipeId,
      sha256: hash,
      source_hash: sourceHash,
      access,
    }),
  ];
  await ctx.db.batch(statements);
  return { assetId, publicUrl, width: dimensions.width, height: dimensions.height, sha256: hash };
}

export async function createBackRenderAsset(
  ctx: Ctx,
  input: { variantId: string; recipeId: string; bytes: Uint8Array },
) {
  const mime = detectMime(input.bytes);
  if (!mime || !["image/png", "image/webp"].includes(mime)) {
    throw new ApiError(422, "render_type_invalid", "Rendered card backs must be PNG or WebP.");
  }
  const dimensions = imageSize(input.bytes);
  if (!dimensions.width || !dimensions.height)
    throw new ApiError(422, "render_dimensions_invalid", "Rendered back has no dimensions.");
  const hash = await sha256Hex(input.bytes);
  const ext = mime === "image/png" ? "png" : "webp";
  const key = `tenants/${ctx.tenant.id}/backs/${hash}.${ext}`;
  await ctx.media.put(key, input.bytes, {
    httpMetadata: { contentType: mime, contentDisposition: "inline" },
    customMetadata: {
      tenant: ctx.tenant.id,
      variant: input.variantId,
      recipe: input.recipeId,
      side: "back",
    },
  });
  const existingAsset = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_assets WHERE tenant_id = ? AND r2_key = ?",
    ctx.tenant.id,
    key,
  );
  const assetId = existingAsset?.id ?? newId("rnd");
  const now = nowIso();
  const variant = await first<{ card_id: string }>(
    ctx.db,
    "SELECT card_id FROM fb_variants WHERE id = ? AND tenant_id = ?",
    input.variantId,
    ctx.tenant.id,
  );
  const { effectiveCardAudience } = await import("./visibility");
  const audience = variant ? await effectiveCardAudience(ctx, variant.card_id) : "members";
  const access = audience === "public" ? "public" : audience === "members" ? "member" : "private";
  const statements = [
    ...(existingAsset
      ? []
      : [
          ctx.db
            .prepare(
              `INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility,
                                      access_classification, role, processing_state, review_status, created_at)
               VALUES (?, ?, 'render', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'render_back', 'ready', 'approved', ?)`,
            )
            .bind(
              assetId,
              ctx.tenant.id,
              `Card back ${input.variantId}`,
              mime,
              dimensions.width,
              dimensions.height,
              input.bytes.length,
              key,
              hash,
              access === "public" ? "public_export" : "private",
              access,
              now,
            ),
        ]),
    ctx.db
      .prepare(
        `INSERT INTO fb_variant_back_renders
          (id, tenant_id, variant_id, recipe_id, asset_id, width, height, sha256, status, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
         ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET
           asset_id = excluded.asset_id, width = excluded.width, height = excluded.height,
           sha256 = excluded.sha256, status = 'published', published_at = excluded.published_at`,
      )
      .bind(
        newId("vbr"),
        ctx.tenant.id,
        input.variantId,
        input.recipeId,
        assetId,
        dimensions.width,
        dimensions.height,
        hash,
        now,
        now,
      ),
    auditStatementSafe(ctx, "render.back.published", assetId, {
      variant_id: input.variantId,
      sha256: hash,
      access,
    }),
  ];
  await ctx.db.batch(statements);
  return { assetId, width: dimensions.width, height: dimensions.height, sha256: hash };
}

export async function createDerivative(
  ctx: Ctx,
  input: { sourceAssetId: string; sizeKey: "thumb" | "preview" | "detail"; bytes: Uint8Array },
) {
  const mime = detectMime(input.bytes);
  if (!mime || mime !== "image/webp")
    throw new ApiError(422, "derivative_type_invalid", "Derivatives must be WebP.");
  const dimensions = imageSize(input.bytes);
  if (!dimensions.width || !dimensions.height)
    throw new ApiError(422, "derivative_dimensions_invalid", "Derivative has no dimensions.");
  const source = await first<AssetRow & { card_id: string }>(
    ctx.db,
    `SELECT a.*, v.card_id FROM fb_assets a
       JOIN fb_variant_renders vr ON vr.asset_id = a.id AND vr.tenant_id = a.tenant_id
       JOIN fb_variants v ON v.id = vr.variant_id AND v.tenant_id = vr.tenant_id
      WHERE a.tenant_id = ? AND a.id = ?`,
    ctx.tenant.id,
    input.sourceAssetId,
  );
  if (!source)
    throw new ApiError(404, "source_render_not_found", "The source render was not found.");
  if (source.r2_key.startsWith('collection-brand-v1/'))
    throw new ApiError(409, 'brand_derivative_unavailable', 'Collection images cannot be used as render derivatives.');
  if (source.r2_key.startsWith('bound-render-stage-v1/'))
    throw new ApiError(409, 'bound_derivative_unavailable', 'Version-bound render derivatives are not available yet.');
  const hash = await sha256Hex(input.bytes);
  const key = `tenants/${ctx.tenant.id}/derivatives/${hash}.webp`;
  const existing = await first<{ id: string }>(
    ctx.db,
    "SELECT id FROM fb_asset_derivatives WHERE tenant_id = ? AND source_asset_id = ? AND size_key = ? AND sha256 = ?",
    ctx.tenant.id,
    source.id,
    input.sizeKey,
    hash,
  );
  if (existing)
    return {
      id: existing.id,
      width: dimensions.width,
      height: dimensions.height,
      bytes: input.bytes.length,
    };
  await ctx.media.put(key, input.bytes, {
    httpMetadata: { contentType: mime, contentDisposition: "inline" },
    customMetadata: { tenant: ctx.tenant.id, derivative: input.sizeKey, sha256: hash },
  });
  const assetId = newId("rnd");
  const derivativeId = newId("drv");
  const now = nowIso();
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility,
                                access_classification, role, processing_state, review_status, derivative_of_asset_id, created_at)
         VALUES (?, ?, 'render', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'approved', ?, ?)`,
      )
      .bind(
        assetId,
        ctx.tenant.id,
        `${source.name} · ${input.sizeKey}`,
        mime,
        dimensions.width,
        dimensions.height,
        input.bytes.length,
        key,
        hash,
        source.visibility,
        source.access_classification,
        `render_${input.sizeKey}`,
        source.id,
        now,
      ),
    ctx.db
      .prepare(
        `INSERT INTO fb_asset_derivatives
          (id, tenant_id, source_asset_id, size_key, r2_key, mime, width, height, bytes, sha256, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
      )
      .bind(
        derivativeId,
        ctx.tenant.id,
        source.id,
        input.sizeKey,
        key,
        mime,
        dimensions.width,
        dimensions.height,
        input.bytes.length,
        hash,
        now,
      ),
    auditStatementSafe(ctx, "derivative.created", derivativeId, {
      source: source.id,
      size: input.sizeKey,
      bytes: input.bytes.length,
    }),
  ]);
  return {
    id: derivativeId,
    width: dimensions.width,
    height: dimensions.height,
    bytes: input.bytes.length,
  };
}

export async function getRenderAsset(ctx: Ctx, assetId: string) {
  const row = await first<{
    id: string;
    variant_id: string;
    public_url: string;
    mime: string;
    r2_key: string;
    width: number;
    height: number;
  }>(
    ctx.db,
    `SELECT a.id, r.variant_id, r.public_url, a.mime, a.r2_key, a.width, a.height
       FROM fb_variant_renders r JOIN fb_assets a ON a.id = r.asset_id
      WHERE r.tenant_id = ? AND a.id = ? AND r.status = 'published'`,
    ctx.tenant.id,
    assetId,
  );
  if (!row) throw new ApiError(404, "render_not_found", "Render not found.");
  return row;
}
