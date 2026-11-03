#!/usr/bin/env node
/**
 * Publish the reviewed public card fronts and designed backs to production.
 *
 * This touches ONLY public_export renders for public showcase variants. It never
 * changes cards, variants, inventory, serials, wallet, achievements or member
 * media. A D1 JSON backup and a read-back are required before --apply.
 *
 *   node scripts/publish-public-renders.mjs
 *   node scripts/publish-public-renders.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const apply = process.argv.includes("--apply");
const wrangler = process.platform === "win32" ? "wrangler.cmd" : "npx";
const tmp = path.join(".foilbury", "tmp", "public-publish");
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(path.join(".foilbury", "evidence"), { recursive: true });

function d1(args) {
  const output = execFileSync(wrangler, ["wrangler", "d1", "execute", ...args, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}
const local = (sql) => d1(["foilbury-local", "--local", "--command", sql]);
const remote = (sql) => d1(["foilbury", "--remote", "--config", "wrangler.production.jsonc", "--command", sql]);
const esc = (value) => String(value).replaceAll("'", "''");

const tenant = remote("SELECT id FROM fb_tenants WHERE slug = 'cabinet'")[0]?.id;
if (!tenant) throw new Error("Production cabinet tenant not found.");
const productionIds = new Set(remote(`SELECT v.id FROM fb_variants v
  JOIN fb_collection_cards cc ON cc.card_id = v.card_id
  JOIN fb_collections c ON c.id = cc.collection_id
  WHERE c.view_audience = 'public' AND c.public_approved_at IS NOT NULL AND v.status = 'published'
  GROUP BY v.id`).map((row) => row.id));
const variants = local(`SELECT v.id, v.tenant_id, vr.recipe_id, vr.public_url AS front_url,
  br.asset_id AS back_asset_id, cd.name AS card_name, v.name AS variant_name
  FROM fb_variants v
  JOIN fb_card_definitions cd ON cd.id = v.card_id
  JOIN fb_collection_cards cc ON cc.card_id = v.card_id
  JOIN fb_collections c ON c.id = cc.collection_id
  JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
  LEFT JOIN fb_variant_back_renders br ON br.variant_id = v.id AND br.status = 'published'
  WHERE c.view_audience = 'public' AND c.public_approved_at IS NOT NULL AND v.status = 'published'
  GROUP BY v.id`).filter((row) => productionIds.has(row.id));

async function fetchBytes(url) {
  const response = await fetch(`http://127.0.0.1:5173${url}`);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function s3(args) {
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.CF_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.CF_SECRET_ACCESS_KEY,
  };
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("R2 S3 credentials are missing.");
  execFileSync("aws", [...args, "--endpoint-url", process.env.CF_S3_API_ENDPOINT], { env, stdio: ["ignore", "pipe", "pipe"] });
}

async function prepare(row) {
  const front = await fetchBytes(row.front_url);
  const frontSha = crypto.createHash("sha256").update(front).digest("hex");
  const frontMeta = await sharp(front).metadata();
  let back = null;
  let backSha = null;
  let backMeta = null;
  if (row.back_asset_id) {
    try {
      back = await fetchBytes(`/media/back/${row.back_asset_id}`);
      backSha = crypto.createHash("sha256").update(back).digest("hex");
      backMeta = await sharp(back).metadata();
    } catch {
      back = null;
    }
  }
  return { ...row, front, frontSha, frontMeta, back, backSha, backMeta };
}

const prepared = [];
for (const row of variants) {
  try {
    prepared.push(await prepare(row));
  } catch (error) {
    console.error(`skip ${row.card_name} ${row.variant_name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(JSON.stringify({
  mode: apply ? "APPLY" : "DRY RUN",
  productionPublicVariants: productionIds.size,
  localMatchedVariants: variants.length,
  prepared: prepared.length,
  withDesignedBack: prepared.filter((row) => row.back).length,
  sample: prepared.slice(0, 4).map((row) => `${row.card_name} — ${row.variant_name}`),
  authority: "public_export fronts/backs only; no inventory, serial, wallet, variant or card identity change",
}, null, 2));
if (!apply) {
  console.log("\nDry run only. Take a D1 backup, then re-run with --apply.");
  process.exit(0);
}

const now = new Date().toISOString();
let uploaded = 0;
let fronts = 0;
let backs = 0;
for (const row of prepared) {
  const frontKey = `tenants/${tenant}/renders/${row.frontSha}.webp`;
  const frontAsset = `rnd_${row.frontSha.slice(0, 20)}`;
  fs.writeFileSync(path.join(tmp, `${row.id}-front.webp`), row.front);
  s3(["s3", "cp", path.join(tmp, `${row.id}-front.webp`), `s3://foilbury-media/${frontKey}`, "--content-type", "image/webp", "--cache-control", "public, max-age=31536000, immutable", "--only-show-errors"]);
  fronts += 1;
  const statements = [
    `INSERT OR IGNORE INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility, access_classification, role, processing_state, review_status, created_at)
     VALUES ('${esc(frontAsset)}', '${esc(tenant)}', 'render', '${esc(`Public render ${row.card_name} ${row.variant_name}`)}', 'image/webp', ${row.frontMeta.width}, ${row.frontMeta.height}, ${row.front.length}, '${esc(frontKey)}', '${row.frontSha}', 'public_export', 'public', 'render', 'ready', 'approved', '${now}')`,
    `INSERT INTO fb_variant_renders (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, source_hash, status, created_at, published_at)
     VALUES ('vr_public_${row.id.slice(-12)}_${row.frontSha.slice(0, 8)}', '${esc(tenant)}', '${esc(row.id)}', '${esc(row.recipe_id)}', '${esc(frontAsset)}', '/media/render/${esc(frontAsset)}', ${row.frontMeta.width}, ${row.frontMeta.height}, '${row.frontSha}', NULL, 'published', '${now}', '${now}')
     ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET asset_id = excluded.asset_id, public_url = excluded.public_url, width = excluded.width, height = excluded.height, sha256 = excluded.sha256, source_hash = excluded.source_hash, status = 'published', published_at = excluded.published_at`,
  ];
  if (row.back && row.backSha) {
    const backKey = `tenants/${tenant}/backs/${row.backSha}.webp`;
    const backAsset = `rnd_${row.backSha.slice(0, 20)}`;
    fs.writeFileSync(path.join(tmp, `${row.id}-back.webp`), row.back);
    s3(["s3", "cp", path.join(tmp, `${row.id}-back.webp`), `s3://foilbury-media/${backKey}`, "--content-type", "image/webp", "--cache-control", "public, max-age=31536000, immutable", "--only-show-errors"]);
    backs += 1;
    statements.push(
      `INSERT OR IGNORE INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility, access_classification, role, processing_state, review_status, created_at)
       VALUES ('${esc(backAsset)}', '${esc(tenant)}', 'render', '${esc(`Public back ${row.card_name} ${row.variant_name}`)}', 'image/webp', ${row.backMeta.width}, ${row.backMeta.height}, ${row.back.length}, '${esc(backKey)}', '${row.backSha}', 'public_export', 'public', 'render_back', 'ready', 'approved', '${now}')`,
      `INSERT INTO fb_variant_back_renders (id, tenant_id, variant_id, recipe_id, asset_id, width, height, sha256, status, created_at, published_at)
       VALUES ('br_public_${row.id.slice(-12)}_${row.backSha.slice(0, 8)}', '${esc(tenant)}', '${esc(row.id)}', '${esc(row.recipe_id)}', '${esc(backAsset)}', ${row.backMeta.width}, ${row.backMeta.height}, '${row.backSha}', 'published', '${now}', '${now}')
       ON CONFLICT(tenant_id, variant_id, recipe_id) DO UPDATE SET asset_id = excluded.asset_id, width = excluded.width, height = excluded.height, sha256 = excluded.sha256, status = 'published', published_at = excluded.published_at`,
    );
  }
  remote(statements.join(";\n"));
  uploaded += 1;
}
remote(`INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
  VALUES ('aud_public_signal_${Date.now()}', '${esc(tenant)}', 'system', 'publish-public-renders', NULL, 'render.public.published', 'catalogue', '${esc(tenant)}', '${esc(JSON.stringify({ fronts, backs, source: "scripts/publish-public-renders.mjs" }))}', 'publish-public-renders', '${now}')`);
const readBack = remote(`SELECT COUNT(*) AS public_fronts FROM fb_variant_renders vr
  JOIN fb_variants v ON v.id = vr.variant_id
  JOIN fb_collection_cards cc ON cc.card_id = v.card_id
  JOIN fb_collections c ON c.id = cc.collection_id
  JOIN fb_assets a ON a.id = vr.asset_id
  WHERE c.view_audience = 'public' AND a.visibility = 'public_export' AND vr.status = 'published'`);
console.log(JSON.stringify({ applied: true, uploaded, fronts, backs, readBack, evidence: ".foilbury/evidence/public-render-publish.json" }, null, 2));
fs.writeFileSync(path.join(".foilbury", "evidence", "public-render-publish.json"), JSON.stringify({ generated_at: now, uploaded, fronts, backs, readBack, sample: prepared.slice(0, 10).map((row) => ({ card: row.card_name, variant: row.variant_name, front_sha: row.frontSha, back_sha: row.backSha })) }, null, 2));
