#!/usr/bin/env node
/**
 * Trusted production provisioning for sourced collection art.
 *
 * Cloudflare Access protects the admin HTTP API, so this path writes the same
 * asset rows and R2 objects directly through the existing Wrangler production
 * configuration. It is idempotent by sha256: existing brand assets are reused
 * and their metadata is refreshed. Collection pointers are updated separately.
 *
 *   node scripts/content/provision-collection-art.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const apply = process.argv.includes("--apply");
const config = "wrangler.production.jsonc";
const bucket = "foilbury-media";
const tenantId = "ten_mvyy304wagy8asnga8tg7r3f";
const manifestFile = path.join(ROOT, ".foilbury", "collection-art", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const env = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  FORCE_COLOR: "0",
};

function d1(sql, { json = true } = {}) {
  const argv = ["d1", "execute", "foilbury", "--remote", "--config", config, "--command", sql];
  if (json) argv.push("--json");
  const result = execFileSync("npx", ["wrangler", ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!json) return result;
  const start = result.indexOf("[");
  return JSON.parse(result.slice(start))[0]?.results ?? [];
}

function r2Put(key, file, mime) {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--file",
      file,
      "--content-type",
      mime,
      "--content-disposition",
      "inline",
      "--remote",
      "--config",
      config,
    ],
    { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
}

const existing = new Map(
  d1(
    `SELECT id, sha256 FROM fb_assets WHERE tenant_id = '${tenantId}' AND kind = 'brand' AND archived_at IS NULL`,
  ).map((row) => [row.sha256, row.id]),
);

const sql = [];
const assets = [];
for (const entry of manifest.entries) {
  const row = { slug: entry.slug, name: entry.name };
  for (const role of ["banner", "logo"]) {
    const record = entry[role];
    if (!record) continue;
    const sha = record.sha256;
    const id = existing.get(sha) ?? `ast_${sha.slice(0, 24)}`;
    const ext = record.output_mime === "image/png" ? "png" : "webp";
    const key = `tenants/${tenantId}/assets/brand/${sha}.${ext}`;
    if (apply) r2Put(key, record.output_file, record.output_mime);
    const provenance = {
      note: "Real series logo/key art sourced from the recorded public reference. Not a generated placeholder, not a card render, not official or licensed by the rights holder.",
      origin: record.origin,
      official: false,
      review_status: record.review_status,
      access_classification: record.access_classification,
      role,
      wiki: record.wiki,
      page_url: record.page_url,
      file_page: record.file_page,
      file_title: record.file_title,
      image_url: record.image_url,
      retrieved_at: record.retrieved_at,
      license: record.license,
      artist: record.artist,
      credit: record.credit,
      source_dimensions: record.source_dimensions,
      source_bytes_sha256: record.source_bytes_sha256,
      transform: record.transform,
      output_dimensions: record.output_dimensions,
      output_mime: record.output_mime,
      output_bytes: record.output_bytes,
      sha256: record.sha256,
      ...(record.note ? { transform_note: record.note } : {}),
    };
    const esc = (value) => `'${String(value).replaceAll("'", "''")}'`;
    sql.push(`
INSERT INTO fb_assets
  (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility,
   source_repo, source_path, source_commit, source_logical_id, credit, created_at,
   access_classification, role, processing_state, revision, derivative_of_asset_id,
   dependencies_json, provenance_json, official, review_status, origin)
VALUES
  (${esc(id)}, ${esc(tenantId)}, 'brand', ${esc(`${entry.name} ${role === "banner" ? "banner" : "mark"}`)},
   ${esc(record.output_mime)}, ${record.output_dimensions.width}, ${record.output_dimensions.height},
   ${record.output_bytes}, ${esc(key)}, ${esc(sha)}, 'private',
   'loftwah/card-collector-bot', ${esc(record.file_page)}, NULL,
   ${esc(`${entry.slug}:collection-${role}:2026-11-09`)}, ${esc(record.credit)},
   strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'member', ${esc(role)}, 'ready', 1, NULL,
   '[]', ${esc(JSON.stringify(provenance))}, 0, 'reviewed', 'sourced')
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  mime = excluded.mime,
  width = excluded.width,
  height = excluded.height,
  bytes = excluded.bytes,
  r2_key = excluded.r2_key,
  sha256 = excluded.sha256,
  source_path = excluded.source_path,
  source_logical_id = excluded.source_logical_id,
  credit = excluded.credit,
  access_classification = excluded.access_classification,
  role = excluded.role,
  processing_state = 'ready',
  provenance_json = excluded.provenance_json,
  official = 0,
  review_status = 'reviewed',
  origin = 'sourced',
  archived_at = NULL;`);
    row[role] = {
      asset_id: id,
      url: `/media/asset/${id}`,
      r2_key: key,
      sha256: sha,
      width: record.output_dimensions.width,
      height: record.output_dimensions.height,
      mime: record.output_mime,
      provenance,
    };
    console.log(`${entry.slug.padEnd(32)} ${role.padEnd(6)} ${id} ${record.output_dimensions.width}x${record.output_dimensions.height}`);
  }
  assets.push(row);
}
const sqlFile = path.join(ROOT, ".foilbury", "collection-art", "provision.sql");
fs.writeFileSync(sqlFile, sql.join("\n"), { mode: 0o600 });
const output = path.join(ROOT, ".foilbury", "collection-art", "uploaded.json");
if (apply) {
  execFileSync("npx", ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", config, "--file", sqlFile], {
    cwd: ROOT,
    encoding: "utf8",
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  fs.writeFileSync(
    output,
    JSON.stringify({ generated_at: new Date().toISOString(), tenant_id: tenantId, entries: assets }, null, 2),
    { mode: 0o600 },
  );
  console.log(`Wrote ${path.relative(ROOT, output)}`);
} else {
  console.log(JSON.stringify({ dry_run: true, assets: assets.length, sqlFile, output }, null, 2));
}
