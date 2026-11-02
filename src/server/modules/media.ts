import type { APIRoute } from "astro";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { buildContext, type Ctx } from "../context";
import { first } from "../db";
import { canViewCard, effectiveCardAudience } from "./visibility";

interface RenderRow {
  asset_id: string;
  r2_key: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  variant_id: string;
  card_id: string;
  render_status: string;
  processing_state: string;
  access_classification: string;
}

async function renderRow(ctx: Ctx, assetId: string): Promise<RenderRow | null> {
  return first<RenderRow>(
    ctx.db,
    `SELECT vr.asset_id, a.r2_key, a.mime, a.bytes, a.width, a.height, a.sha256,
            vr.variant_id, v.card_id, vr.status AS render_status,
            a.processing_state, a.access_classification
       FROM fb_variant_renders vr
       JOIN fb_assets a ON a.id = vr.asset_id AND a.tenant_id = vr.tenant_id
       JOIN fb_variants v ON v.id = vr.variant_id AND v.tenant_id = vr.tenant_id
      WHERE vr.asset_id = ?`,
    assetId,
  );
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function serve(
  ctx: Ctx,
  media: R2Bucket,
  assetId: string,
  options: { publicOnly: boolean; request: Request },
): Promise<Response> {
  const row = await renderRow(ctx, assetId);
  if (!row || row.render_status !== "published" || row.processing_state !== "ready") return notFound();
  const audience = await effectiveCardAudience(ctx, row.card_id);
  if (options.publicOnly) {
    if (audience !== "public" || row.access_classification !== "public") return notFound();
  } else {
    if (audience !== "public") {
      const allowed = await canViewCard(ctx, row.card_id);
      if (!allowed) return notFound();
    }
  }
  const object = await media.get(row.r2_key);
  if (!object) return notFound();
  const isPublic = audience === "public" && row.access_classification === "public";
  const etag = `"${row.sha256.slice(0, 32)}"`;
  if (options.request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
        vary: "cookie",
      },
    });
  }
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.bytes),
      "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      vary: "cookie",
      etag,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

export const renderGET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const media = (ctx as unknown as { media: R2Bucket }).media;
  return serve(ctx, media, params.id ?? "", { publicOnly: false, request });
};

export const backRenderGET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const assetId = params.id ?? "";
  const row = await first<{
    asset_id: string; r2_key: string; mime: string; bytes: number; sha256: string; card_id: string;
  }>(
    ctx.db,
    `SELECT br.asset_id, a.r2_key, a.mime, a.bytes, a.sha256, v.card_id
       FROM fb_variant_back_renders br
       JOIN fb_assets a ON a.id = br.asset_id AND a.tenant_id = br.tenant_id
       JOIN fb_variants v ON v.id = br.variant_id AND v.tenant_id = br.tenant_id
      WHERE br.asset_id = ? AND br.status = 'published'`,
    assetId,
  );
  if (!row) return notFound();
  const audience = await effectiveCardAudience(ctx, row.card_id);
  if (audience !== "public" && !(await canViewCard(ctx, row.card_id))) return notFound();
  const object = await ctx.media.get(row.r2_key);
  if (!object) return notFound();
  const isPublic = audience === "public";
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.bytes),
      "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      vary: "cookie",
      etag: `"${row.sha256.slice(0, 32)}"`,
      "x-content-type-options": "nosniff",
    },
  });
};

export const publicRenderGET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const media = (ctx as unknown as { media: R2Bucket }).media;
  return serve(ctx, media, params.id ?? "", { publicOnly: true, request });
};

export async function derivativeResponse(ctx: Ctx, media: R2Bucket, derivativeId: string, request: Request): Promise<Response> {
  const row = await first<{
    id: string;
    r2_key: string;
    mime: string;
    bytes: number;
    sha256: string;
    source_asset_id: string;
    card_id: string;
  }>(
    ctx.db,
    `SELECT d.id, d.r2_key, d.mime, d.bytes, d.sha256, d.source_asset_id, v.card_id
       FROM fb_asset_derivatives d
       JOIN fb_variant_renders vr ON vr.asset_id = d.source_asset_id AND vr.tenant_id = d.tenant_id
       JOIN fb_variants v ON v.id = vr.variant_id AND v.tenant_id = vr.tenant_id
      WHERE d.id = ? AND d.status = 'ready' AND vr.status = 'published'`,
    derivativeId,
  );
  if (!row) return notFound();
  const audience = await effectiveCardAudience(ctx, row.card_id);
  if (audience !== "public" && !(await canViewCard(ctx, row.card_id))) return notFound();
  const object = await media.get(row.r2_key);
  if (!object) return notFound();
  const isPublic = audience === "public";
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": row.mime,
      "content-length": String(row.bytes),
      "cache-control": isPublic ? "public, max-age=31536000, immutable" : "private, no-store",
      vary: "cookie",
      etag: `"${row.sha256.slice(0, 32)}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
