import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { imageSize } from "image-size";
import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { audit } from "../http";

export type AssetKind = "subject" | "background" | "frame" | "material" | "effect" | "brand" | "render";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 5000;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

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
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export async function uploadAsset(
  ctx: Ctx,
  input: {
    kind: AssetKind;
    name: string;
    bytes: Uint8Array;
    declaredMime?: string;
    visibility?: "private" | "public_export";
    source?: {
      repo?: string;
      path?: string;
      commit?: string;
      logicalId?: string;
      credit?: string;
    };
  },
): Promise<AssetRow> {
  if (input.bytes.length === 0) throw new ApiError(422, "asset_empty", "The uploaded file is empty.");
  if (input.bytes.length > MAX_BYTES) throw new ApiError(413, "asset_too_large", "Assets must be 8 MB or smaller.");
  const mime = detectMime(input.bytes);
  if (!mime || !ALLOWED.has(mime)) {
    throw new ApiError(422, "asset_type_invalid", "Only PNG, JPEG and WebP images are accepted.");
  }
  if (input.declaredMime && input.declaredMime !== mime) {
    throw new ApiError(422, "asset_mime_mismatch", "The file content does not match its declared image type.");
  }
  let dimensions: { width?: number; height?: number };
  try {
    dimensions = imageSize(input.bytes);
  } catch {
    throw new ApiError(422, "asset_corrupt", "The image dimensions could not be read. The file may be corrupt.");
  }
  const width = dimensions.width ?? 0;
  const height = dimensions.height ?? 0;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ApiError(422, "asset_dimensions_invalid", "Image dimensions must be between 1 and 5000 pixels.");
  }
  const hash = await sha256Hex(input.bytes);
  const existing = await first<AssetRow>(
    ctx.db,
    "SELECT * FROM fb_assets WHERE tenant_id = ? AND sha256 = ? AND kind = ? AND archived_at IS NULL",
    ctx.tenant.id,
    hash,
    input.kind,
  );
  if (existing) return existing;
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp";
  const key = `tenants/${ctx.tenant.id}/assets/${hash}.${ext}`;
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
           source_repo, source_path, source_commit, source_logical_id, credit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.visibility ?? "private",
        input.source?.repo ?? null,
        input.source?.path ?? null,
        input.source?.commit ?? null,
        input.source?.logicalId ?? null,
        input.source?.credit ?? null,
        nowIso(),
      ),
    auditStatementSafe(ctx, "asset.uploaded", id, { kind: input.kind, sha256: hash, bytes: input.bytes.length }),
  ]);
  return (await first<AssetRow>(ctx.db, "SELECT * FROM fb_assets WHERE id = ?", id))!;
}

function auditStatementSafe(ctx: Ctx, action: string, objectId: string, metadata: Record<string, unknown>) {
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
    `SELECT * FROM fb_assets WHERE tenant_id = ? AND archived_at IS NULL ${kind ? "AND kind = ?" : ""} ORDER BY created_at DESC LIMIT 500`,
    ...(kind ? [ctx.tenant.id, kind] : [ctx.tenant.id]),
  );
}

export async function getAsset(ctx: Ctx, id: string): Promise<AssetRow> {
  const asset = await first<AssetRow>(ctx.db, "SELECT * FROM fb_assets WHERE id = ? AND tenant_id = ?", id, ctx.tenant.id);
  if (!asset) throw new ApiError(404, "asset_not_found", "Asset not found.");
  return asset;
}

export async function readAsset(media: R2Bucket, asset: AssetRow): Promise<ArrayBuffer> {
  const object = await media.get(asset.r2_key);
  if (!object) throw new ApiError(410, "asset_missing", "The stored asset is missing. A render job can rebuild a card from its source.");
  return object.arrayBuffer();
}

export async function assetUrl(asset: AssetRow): Promise<string> {
  return asset.visibility === "public_export" ? `/media/public/${asset.id}` : `/media/asset/${asset.id}`;
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
  if (!dimensions.width || !dimensions.height) throw new ApiError(422, "render_dimensions_invalid", "Rendered image has no dimensions.");
  const hash = await sha256Hex(input.bytes);
  const ext = mime === "image/png" ? "png" : "webp";
  const key = `tenants/${ctx.tenant.id}/renders/${hash}.${ext}`;
  await ctx.media.put(key, input.bytes, {
    httpMetadata: { contentType: mime, contentDisposition: "inline" },
    customMetadata: { tenant: ctx.tenant.id, variant: input.variantId, recipe: input.recipeId },
  });
  const assetId = newId("rnd");
  const now = nowIso();
  const publicUrl = `/media/public/${assetId}`;
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility, created_at)
         VALUES (?, ?, 'render', ?, ?, ?, ?, ?, ?, ?, 'public_export', ?)`,
      )
      .bind(assetId, ctx.tenant.id, `Card render ${input.variantId}`, mime, dimensions.width, dimensions.height, input.bytes.length, key, hash, now),
    ctx.db
      .prepare(
        `INSERT INTO fb_variant_renders
          (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, status, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
         ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET
           asset_id = excluded.asset_id, public_url = excluded.public_url, width = excluded.width,
           height = excluded.height, sha256 = excluded.sha256, status = 'published', published_at = excluded.published_at`,
      )
      .bind(newId("vr"), ctx.tenant.id, input.variantId, input.recipeId, assetId, publicUrl, dimensions.width, dimensions.height, hash, now, now),
    auditStatementSafe(ctx, "render.published", assetId, { variant_id: input.variantId, recipe_id: input.recipeId, sha256: hash }),
  ]);
  return { assetId, publicUrl, width: dimensions.width, height: dimensions.height, sha256: hash };
}

export async function getRenderAsset(ctx: Ctx, assetId: string) {
  const row = await first<{ id: string; variant_id: string; public_url: string; mime: string; r2_key: string; width: number; height: number }>(
    ctx.db,
    `SELECT a.id, r.variant_id, r.public_url, a.mime, a.r2_key, a.width, a.height
       FROM fb_variant_renders r JOIN fb_assets a ON a.id = r.asset_id
      WHERE r.tenant_id = ? AND a.id = ? AND r.status = 'published' AND a.visibility = 'public_export'`,
    ctx.tenant.id,
    assetId,
  );
  if (!row) throw new ApiError(404, "render_not_found", "Render not found.");
  return row;
}
