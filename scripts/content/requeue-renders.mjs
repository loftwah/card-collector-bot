#!/usr/bin/env node
/**
 * Requeue existing published variants for a deterministic re-render.
 *
 * This does not alter cards, editions, variants, ownership or serials. It only
 * creates render jobs. A human then runs the normal renderer, which publishes a
 * new asset through the same authenticated path.
 *
 * Dry run by default:
 *   node scripts/content/requeue-renders.mjs --slug danganronpa-three-games
 *   node scripts/content/requeue-renders.mjs --slug danganronpa-three-games --local --apply
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const local = args.includes("--local");
const slug = process.argv.find((arg) => arg.startsWith("--slug="))?.split("=")[1] ?? args[args.indexOf("--slug") + 1];
if (!slug) {
  console.error("Usage: node scripts/content/requeue-renders.mjs --slug <collection-slug> [--local] [--apply]");
  process.exit(1);
}
const wrangler = process.platform === "win32" ? "wrangler.cmd" : "npx";
const baseArgs = ["wrangler", "d1", "execute", local ? "foilbury-local" : "foilbury", local ? "--local" : "--remote"];
if (!local) baseArgs.push("--config", "wrangler.production.jsonc");
baseArgs.push("--json");
function query(sql) {
  const output = execFileSync(wrangler, [...baseArgs, "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}
function esc(value) {
  return String(value).replaceAll("'", "''");
}
const rows = query(`SELECT v.id AS variant_id, v.name AS variant_name, e.recipe_id, e.subject_asset_id, e.background_asset_id,
  cd.id AS card_id, cd.name AS card_name, cd.slug AS card_slug, m.key AS material_key, fx.key AS effect_key
  FROM fb_variants v
  JOIN fb_artwork_editions e ON e.id = v.edition_id
  JOIN fb_card_definitions cd ON cd.id = v.card_id
  JOIN fb_materials m ON m.id = v.material_id
  LEFT JOIN fb_effects fx ON fx.id = v.effect_id
  JOIN fb_collection_cards cc ON cc.card_id = cd.id
  JOIN fb_collections c ON c.id = cc.collection_id
  WHERE c.slug = '${esc(slug)}' AND v.status = 'published' AND cd.archived_at IS NULL
  ORDER BY cd.name, v.name`);
const existing = new Set(query(`SELECT json_extract(payload_json, '$.variant_id') AS variant_id FROM fb_jobs WHERE status IN ('pending','running') AND kind = 'render_card'`).map((row) => row.variant_id));
const pending = rows.filter((row) => !existing.has(row.variant_id));
const now = new Date().toISOString();
console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY RUN", environment: local ? "local" : "production", collection: slug, publishedVariants: rows.length, alreadyQueued: rows.length - pending.length, queued: pending.length, sample: pending.slice(0, 3).map((row) => ({ card: row.card_name, variant: row.variant_name })) }, null, 2));
if (!apply) {
  console.log("\nDry run only. Re-run with --apply, then run the normal renderer (pnpm jobs:run) with the bounded worker count.");
  process.exit(0);
}
let inserted = 0;
for (const row of pending) {
  const payload = JSON.stringify({
    variant_id: row.variant_id,
    recipe_id: row.recipe_id,
    variant_name: row.variant_name,
    card_id: row.card_id,
    card_name: row.card_name,
    card_slug: row.card_slug,
    subject_asset_id: row.subject_asset_id,
    background_asset_id: row.background_asset_id,
    material_key: row.material_key,
    effect_key: row.effect_key,
  });
  const id = `job_rerender_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  query(`INSERT INTO fb_jobs (id, tenant_id, kind, status, payload_json, attempts, max_attempts, available_at, created_at, updated_at)
    SELECT '${esc(id)}', cd.tenant_id, 'render_card', 'pending', '${esc(payload)}', 0, 3, '${now}', '${now}', '${now}'
    FROM fb_card_definitions cd WHERE cd.id = '${esc(row.card_id)}'`);
  inserted += 1;
}
console.log(JSON.stringify({ applied: true, inserted }, null, 2));
