import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { first } from "../../../server/db";
import { readConfig } from "../../../server/config";
import { loadTenant } from "../../../server/context";

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const raw = env as unknown as { DB: D1Database; MEDIA: R2Bucket; FOILBURY_ENV?: string; FOILBURY_TENANT_SLUG?: string };
  const config = readConfig(raw as never);
  const tenant = await loadTenant(raw.DB, config.tenantSlug);
  const id = params.id ?? "";
  const row = await first<{ r2_key: string; mime: string }>(
    raw.DB,
    `SELECT a.r2_key, a.mime FROM fb_variant_renders r JOIN fb_assets a ON a.id = r.asset_id
      WHERE a.id = ? AND r.status = 'published' AND a.visibility = 'public_export'`,
    id,
  );
  if (!row) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const object = await raw.MEDIA.get(row.r2_key);
  if (!object) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(await object.arrayBuffer(), {
    headers: {
      "content-type": row.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
};
