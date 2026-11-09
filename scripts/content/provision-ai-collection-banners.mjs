#!/usr/bin/env node
/**
 * Provision the AI-assisted collection banners through the trusted Wrangler
 * production path. Idempotent by output SHA-256; member/private only.
 *
 *   node scripts/content/provision-ai-collection-banners.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const apply = process.argv.includes("--apply");
const config = "wrangler.production.jsonc";
const bucket = "foilbury-media";
const tenantId = "ten_mvyy304wagy8asnga8tg7r3f";
const manifestFile = path.join(ROOT, ".foilbury", "ai-banners", "optimized.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const env = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  FORCE_COLOR: "0",
};

function d1(sql) {
  const result = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", config, "--json", "--command", sql],
    { cwd: ROOT, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 },
  );
  const start = result.indexOf("[");
  return JSON.parse(result.slice(start))[0]?.results ?? [];
}
function r2Put(key, file, mime) {
  execFileSync(
    "npx",
    [
      "wrangler", "r2", "object", "put", `${bucket}/${key}`,
      "--file", file, "--content-type", mime,
      "--content-disposition", "inline", "--remote", "--config", config,
    ],
    { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
}
const esc = (value) => `'${String(value).replaceAll("'", "''")}'`;
const existing = new Map(
  d1(`SELECT id, sha256 FROM fb_assets WHERE tenant_id = '${tenantId}' AND kind = 'brand' AND archived_at IS NULL`).map((row) => [row.sha256, row.id]),
);
const sql = [];
const assets = [];
for (const entry of manifest.entries) {
  const id = existing.get(entry.sha256) ?? `ast_${entry.sha256.slice(0, 24)}`;
  const key = `tenants/${tenantId}/assets/brand/${entry.sha256}.webp`;
  if (apply) r2Put(key, entry.output_file, entry.output_mime);
  const provenance = {
    note: entry.note,
    origin: "ai_assisted",
    official: false,
    review_status: "reviewed",
    access_classification: "member",
    role: "banner",
    model: entry.model,
    prompt: entry.prompt,
    reference_files: entry.reference_files,
    generated_at: entry.generated_at,
    source_url: entry.source_url,
    source_sha256: entry.source_sha256,
    source_dimensions: entry.source_dimensions,
    output_dimensions: entry.output_dimensions,
    output_mime: entry.output_mime,
    output_bytes: entry.output_bytes,
    sha256: entry.sha256,
    reference_note: "The reference images are the sourced collection/card art recorded in docs/COLLECTION_ART_PROVENANCE.md and .foilbury/collection-art/manifest.json. AI-assisted composition; not official or licensed.",
  };
  sql.push(`
INSERT INTO fb_assets
  (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility,
   source_repo, source_path, source_commit, source_logical_id, credit, created_at,
   access_classification, role, processing_state, revision, derivative_of_asset_id,
   dependencies_json, provenance_json, official, review_status, origin)
VALUES
  (${esc(id)}, ${esc(tenantId)}, 'brand', ${esc(`AI-assisted collection banner: ${entry.slug}`)},
   ${esc(entry.output_mime)}, ${entry.output_dimensions.width}, ${entry.output_dimensions.height},
   ${entry.output_bytes}, ${esc(key)}, ${esc(entry.sha256)}, 'private',
   'loftwah/card-collector-bot', ${esc(entry.source_url)}, NULL,
   ${esc(`${entry.slug}:ai-banner:2026-11-09`)},
   ${esc("AI-assisted composition from published reference art. Not official or licensed. Member/private only.")},
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'member', 'banner', 'ready', 1, NULL,
   '[]', ${esc(JSON.stringify(provenance))}, 0, 'reviewed', 'ai_assisted')
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name, mime = excluded.mime, width = excluded.width, height = excluded.height,
  bytes = excluded.bytes, r2_key = excluded.r2_key, sha256 = excluded.sha256,
  source_path = excluded.source_path, source_logical_id = excluded.source_logical_id,
  credit = excluded.credit, access_classification = 'member', role = 'banner',
  processing_state = 'ready', provenance_json = excluded.provenance_json,
  official = 0, review_status = 'reviewed', origin = 'ai_assisted', archived_at = NULL;`);
  assets.push({ slug: entry.slug, asset_id: id, url: `/media/asset/${id}`, r2_key: key, sha256: entry.sha256, width: entry.output_dimensions.width, height: entry.output_dimensions.height, provenance });
  console.log(`${entry.slug.padEnd(32)} ${id} ${entry.output_dimensions.width}x${entry.output_dimensions.height}`);
}
const sqlFile = path.join(ROOT, ".foilbury", "ai-banners", "provision.sql");
fs.writeFileSync(sqlFile, sql.join("\n"), { mode: 0o600 });
const output = path.join(ROOT, ".foilbury", "ai-banners", "uploaded.json");
if (apply) {
  execFileSync("npx", ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", config, "--file", sqlFile], {
    cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "inherit", "inherit"],
  });
  fs.writeFileSync(output, JSON.stringify({ generated_at: new Date().toISOString(), entries: assets }, null, 2), { mode: 0o600 });
  console.log(`Wrote ${path.relative(ROOT, output)}`);
} else {
  console.log(JSON.stringify({ dry_run: true, assets: assets.length, sqlFile, output }, null, 2));
}
