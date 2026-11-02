import type { APIRoute } from "astro";
import { buildContext } from "../../../server/context";
import { getAsset, readAsset } from "../../../server/modules/assets";
import { first } from "../../../server/db";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  const asset = await getAsset(ctx, params.id ?? "");
  if (asset.processing_state !== "ready" || asset.archived_at) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  if (asset.access_classification === "public") {
    const bytes = await readAsset(ctx.media, asset);
    return new Response(bytes, {
      headers: {
        "content-type": asset.mime,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  }
  if (!ctx.user) return new Response("Authentication required", { status: 401, headers: { "cache-control": "no-store" } });
  if (asset.access_classification === "member") {
    const member = await first<{ present: number }>(
      ctx.db,
      "SELECT 1 AS present FROM fb_memberships WHERE user_id = ? AND status = 'active' AND revoked_at IS NULL LIMIT 1",
      ctx.user.id,
    );
    if (!member) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    const bytes = await readAsset(ctx.media, asset);
    return new Response(bytes, {
      headers: {
        "content-type": asset.mime,
        "cache-control": "private, no-store",
        vary: "cookie",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (asset.visibility !== "private" && asset.access_classification === "private") {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const privileged =
    ctx.user.platformAdmin || ["owner", "editor", "economy_admin"].includes(ctx.user.role);
  const owned = privileged
    ? true
    : Boolean(
        await first<{ present: number }>(
          ctx.db,
          `SELECT 1 AS present FROM fb_card_instances ci
             JOIN fb_variants v ON v.id = ci.variant_id
             JOIN fb_artwork_editions e ON e.id = v.edition_id
            WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
              AND (e.subject_asset_id = ? OR e.background_asset_id = ?) LIMIT 1`,
          ctx.tenant.id,
          ctx.user.id,
          asset.id,
          asset.id,
        ),
      );
  const managed = privileged
    ? true
    : Boolean(
        await first<{ present: number }>(
          ctx.db,
          `SELECT 1 AS present FROM fb_collection_cards cc
             JOIN fb_collections c ON c.id = cc.collection_id
            WHERE (c.logo_asset_id = ? OR c.banner_asset_id = ?)
              AND (c.owner_tenant_id = ? OR (c.scope = 'global' AND c.view_audience <> 'private')) LIMIT 1`,
          asset.id,
          asset.id,
          ctx.tenant.id,
        ),
      );
  if (!owned && !managed) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const bytes = await readAsset(ctx.media, asset);
  return new Response(bytes, {
    headers: {
      "content-type": asset.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
};
