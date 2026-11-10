import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { imageSize } from "image-size";
import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { audit } from "../http";

export type AssetKind =
  "subject" | "background" | "frame" | "material" | "effect" | "brand" | "render";

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
    /**
     * Import-style callers reuse identical bytes. Art Lab candidates and brand
     * publications must not mutate an existing live asset's metadata, so they
     * pass false and receive a new stable asset row.
     */
    dedupe?: boolean;
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
  if (input.declaredMime && ALLOWED.has(input.declaredMime) && input.declaredMime !== mime) {
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
  const existing =
    input.dedupe === false
      ? null
      : await first<AssetRow>(
          ctx.db,
          "SELECT * FROM fb_assets WHERE tenant_id = ? AND sha256 = ? AND kind = ? AND archived_at IS NULL",
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
  const key =
    input.dedupe === false
      ? `tenants/${ctx.tenant.id}/assets/${input.kind}/${hash}-${newId("art")}.${ext}`
      : `tenants/${ctx.tenant.id}/assets/${input.kind}/${hash}.${ext}`;
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
    `SELECT * FROM fb_assets WHERE tenant_id = ? AND archived_at IS NULL ${kind ? "AND kind = ?" : ""} ORDER BY created_at DESC LIMIT 500`,
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

export async function readAsset(media: R2Bucket, asset: AssetRow): Promise<ArrayBuffer> {
  const object = await media.get(asset.r2_key);
  if (!object)
    throw new ApiError(
      410,
      "asset_missing",
      "The stored asset is missing. A render job can rebuild a card from its source.",
    );
  return object.arrayBuffer();
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
