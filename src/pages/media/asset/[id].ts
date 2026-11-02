import type { APIRoute } from "astro";
import { buildContext } from "../../../server/context";
import { getAsset, readAsset } from "../../../server/modules/assets";
import { first } from "../../../server/db";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const ctx = await buildContext(request);
  if (!ctx.user) return new Response("Authentication required", { status: 401, headers: { "cache-control": "no-store" } });
  const asset = await getAsset(ctx, params.id ?? "");
  if (asset.visibility !== "private") {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const privileged = ["owner", "editor", "economy_admin"].includes(ctx.user.role);
  const owned = privileged
    ? true
    : Boolean(
        await first<{ present: number }>(
          ctx.db,
          `SELECT 1 AS present FROM fb_card_instances ci
             JOIN fb_variants v ON v.id = ci.variant_id AND v.tenant_id = ci.tenant_id
             JOIN fb_artwork_editions e ON e.id = v.edition_id AND e.tenant_id = ci.tenant_id
            WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')
              AND (e.subject_asset_id = ? OR e.background_asset_id = ?) LIMIT 1`,
          ctx.tenant.id,
          ctx.user.id,
          asset.id,
          asset.id,
        ),
      );
  if (!owned) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const bytes = await readAsset(ctx.media, asset);
  return new Response(bytes, {
    headers: {
      "content-type": asset.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
};
