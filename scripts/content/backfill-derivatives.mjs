#!/usr/bin/env node
/**
 * Bounded derivative backfill.
 *
 * Published renders are 750x1050. Album grids should load 300x420 thumbnails
 * instead. This script finds published render assets with no thumb/preview
 * derivative and uploads the missing derivatives through the audited admin
 * endpoint. It never touches the original render, ownership, serials or
 * wallets.
 *
 * Dry run by default. Local:
 *   node scripts/content/backfill-derivatives.mjs --local
 *   node scripts/content/backfill-derivatives.mjs --local --apply --limit=40
 *
 * Production requires an explicitly supplied agent/service credential and a
 * fresh D1 backup. It is intentionally not run by this task.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import { apiForm, apiJson, ensureServer, BASE_URL, agentToken } from "../lib/api.mjs";

const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const apply = args.has("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.min(100, Math.max(1, Number(limitArg?.split("=")[1] ?? 40)));

function query(sql) {
  const wrangler = [
    "wrangler",
    "d1",
    "execute",
    local ? "foilbury-local" : "foilbury",
    local ? "--local" : "--remote",
  ];
  if (!local) wrangler.push("--config", "wrangler.production.jsonc");
  wrangler.push("--json", "--command", sql);
  const env = local
    ? { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" }
    : process.env;
  const output = execFileSync("npx", wrangler, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}

const rows = query(`SELECT a.id AS asset_id, a.r2_key, a.width, a.height,
  SUM(CASE WHEN d.size_key = 'thumb' THEN 1 ELSE 0 END) AS has_thumb,
  SUM(CASE WHEN d.size_key = 'preview' THEN 1 ELSE 0 END) AS has_preview
 FROM fb_assets a
 JOIN fb_variant_renders r ON r.asset_id = a.id AND r.status = 'published'
 LEFT JOIN fb_asset_derivatives d ON d.source_asset_id = a.id AND d.status = 'ready'
 WHERE a.kind = 'render' AND a.archived_at IS NULL
 GROUP BY a.id
 HAVING has_thumb = 0 OR has_preview = 0
 ORDER BY a.created_at
 LIMIT ${limit};`);

const plan = rows.map((row) => ({
  assetId: row.asset_id,
  missing: [
    Number(row.has_thumb) === 0 ? "thumb" : null,
    Number(row.has_preview) === 0 ? "preview" : null,
  ].filter(Boolean),
}));

console.log(
  JSON.stringify(
    {
      mode: apply ? "APPLY" : "DRY RUN",
      environment: local ? "local" : "production",
      candidates: plan.length,
      limit,
      sample: plan.slice(0, 3),
    },
    null,
    2,
  ),
);

if (!apply) {
  console.log("\nNo derivative was written. Re-run with --apply for a bounded batch.");
  process.exit(0);
}
if (!local) {
  throw new Error(
    "Production apply requires an explicit approval and credential path; this task intentionally stops at the dry-run plan.",
  );
}

await ensureServer();
let uploaded = 0;
for (const item of plan) {
  const response = await fetch(new URL(`/media/render/${item.assetId}`, BASE_URL), {
    headers: { authorization: `Bearer ${agentToken()}` },
  }).catch(() => null);
  if (!response?.ok) {
    console.error(`skip ${item.assetId}: source fetch ${response?.status ?? "failed"}`);
    continue;
  }
  const source = Buffer.from(await response.arrayBuffer());
  for (const [sizeKey, width, height] of [
    ["thumb", 300, 420],
    ["preview", 600, 840],
  ]) {
    if (!item.missing.includes(sizeKey)) continue;
    const bytes = await sharp(source)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: "image/webp" }),
      `${item.assetId}-${sizeKey}.webp`,
    );
    form.append("sizeKey", sizeKey);
    await apiForm(`/api/v1/admin/assets/${item.assetId}/derivatives`, form);
    uploaded += 1;
  }
}
console.log(JSON.stringify({ applied: true, uploaded, assets: plan.length }, null, 2));
