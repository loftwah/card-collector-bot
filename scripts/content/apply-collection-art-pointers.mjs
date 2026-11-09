#!/usr/bin/env node
/**
 * Point published collections at the sourced banner/mark assets.
 * Idempotent and art-only: release_version, status and audience are untouched.
 *
 *   node scripts/content/apply-collection-art-pointers.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const apply = process.argv.includes("--apply");
const config = "wrangler.production.jsonc";
const uploadedFile = path.join(ROOT, ".foilbury", "collection-art", "uploaded.json");
const uploaded = JSON.parse(fs.readFileSync(uploadedFile, "utf8"));
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
const esc = (value) => `'${String(value).replaceAll("'", "''")}'`;
const slugs = uploaded.entries.map((entry) => entry.slug);
const before = d1(
  `SELECT id, slug, name, logo_url, banner_url, logo_asset_id, banner_asset_id, release_version, status, view_audience
     FROM fb_collections WHERE slug IN (${slugs.map(esc).join(",")}) ORDER BY slug`,
);
const beforeFile = path.join(ROOT, ".foilbury", "collection-art", "before.json");
fs.writeFileSync(beforeFile, JSON.stringify(before, null, 2), { mode: 0o600 });

const bySlug = new Map(before.map((row) => [row.slug, row]));
const statements = [];
const rollback = [];
for (const entry of uploaded.entries) {
  const old = bySlug.get(entry.slug);
  if (!old) throw new Error(`Collection not found: ${entry.slug}`);
  const logoUrl = entry.logo?.url ?? null;
  const bannerUrl = entry.banner?.url ?? null;
  const logoAssetId = entry.logo?.asset_id ?? null;
  const bannerAssetId = entry.banner?.asset_id ?? null;
  statements.push(`
UPDATE fb_collections
SET logo_url = ${logoUrl ? esc(logoUrl) : "NULL"},
    logo_asset_id = ${logoAssetId ? esc(logoAssetId) : "NULL"},
    banner_url = ${bannerUrl ? esc(bannerUrl) : "NULL"},
    banner_asset_id = ${bannerAssetId ? esc(bannerAssetId) : "NULL"},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = ${esc(entry.slug)}
  AND (logo_url IS NOT ${logoUrl ? esc(logoUrl) : "NULL"}
    OR logo_asset_id IS NOT ${logoAssetId ? esc(logoAssetId) : "NULL"}
    OR banner_url IS NOT ${bannerUrl ? esc(bannerUrl) : "NULL"}
    OR banner_asset_id IS NOT ${bannerAssetId ? esc(bannerAssetId) : "NULL"});`);
  rollback.push(
    `-- ${entry.slug}\nUPDATE fb_collections\nSET logo_url = ${old.logo_url ? esc(old.logo_url) : "NULL"},\n    logo_asset_id = ${old.logo_asset_id ? esc(old.logo_asset_id) : "NULL"},\n    banner_url = ${old.banner_url ? esc(old.banner_url) : "NULL"},\n    banner_asset_id = ${old.banner_asset_id ? esc(old.banner_asset_id) : "NULL"},\n    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')\nWHERE slug = ${esc(entry.slug)};`,
  );
}
const sqlFile = path.join(ROOT, ".foilbury", "collection-art", "pointers.sql");
fs.writeFileSync(sqlFile, statements.join("\n"), { mode: 0o600 });
fs.writeFileSync(path.join(ROOT, ".foilbury", "collection-art", "rollback.sql"), rollback.join("\n\n"), { mode: 0o600 });

if (apply) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", config, "--file", sqlFile],
    { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "inherit", "inherit"] },
  );
  const after = d1(
    `SELECT id, slug, name, logo_url, banner_url, logo_asset_id, banner_asset_id, release_version, status, view_audience
       FROM fb_collections WHERE slug IN (${slugs.map(esc).join(",")}) ORDER BY slug`,
  );
  fs.writeFileSync(path.join(ROOT, ".foilbury", "collection-art", "after.json"), JSON.stringify(after, null, 2), { mode: 0o600 });
  const versionChanged = after.filter((row) => row.release_version !== bySlug.get(row.slug)?.release_version);
  console.log(JSON.stringify({ updated: after.length, release_version_changed: versionChanged, sqlFile }, null, 2));
} else {
  console.log(JSON.stringify({ dry_run: true, entries: statements.length, sqlFile, beforeFile }, null, 2));
}
