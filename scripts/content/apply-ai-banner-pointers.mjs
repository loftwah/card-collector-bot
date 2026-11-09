#!/usr/bin/env node
/** Point collections at their AI-assisted banner assets. Art-only, idempotent. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const apply = process.argv.includes("--apply");
const config = "wrangler.production.jsonc";
const uploaded = JSON.parse(fs.readFileSync(path.join(ROOT, ".foilbury", "ai-banners", "uploaded.json"), "utf8"));
const env = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  FORCE_COLOR: "0",
};
function d1(sql) {
  const result = execFileSync("npx", ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", config, "--json", "--command", sql], {
    cwd: ROOT, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024,
  });
  const start = result.indexOf("[");
  return JSON.parse(result.slice(start))[0]?.results ?? [];
}
const esc = (value) => `'${String(value).replaceAll("'", "''")}'`;
const slugs = uploaded.entries.map((entry) => entry.slug);
const before = d1(`SELECT id, slug, name, logo_url, logo_asset_id, banner_url, banner_asset_id, release_version, status, view_audience FROM fb_collections WHERE slug IN (${slugs.map(esc).join(",")}) ORDER BY slug`);
fs.writeFileSync(path.join(ROOT, ".foilbury", "ai-banners", "before.json"), JSON.stringify(before, null, 2), { mode: 0o600 });
const bySlug = new Map(before.map((row) => [row.slug, row]));
const statements = [];
const rollback = [];
for (const entry of uploaded.entries) {
  const old = bySlug.get(entry.slug);
  if (!old) throw new Error(`Missing collection ${entry.slug}`);
  statements.push(`
UPDATE fb_collections
SET banner_url = ${esc(entry.url)},
    banner_asset_id = ${esc(entry.asset_id)},
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = ${esc(entry.slug)}
  AND (banner_url IS NOT ${esc(entry.url)} OR banner_asset_id IS NOT ${esc(entry.asset_id)});`);
  rollback.push(`-- ${entry.slug}\nUPDATE fb_collections\nSET banner_url = ${old.banner_url ? esc(old.banner_url) : "NULL"},\n    banner_asset_id = ${old.banner_asset_id ? esc(old.banner_asset_id) : "NULL"},\n    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')\nWHERE slug = ${esc(entry.slug)};`);
}
const sqlFile = path.join(ROOT, ".foilbury", "ai-banners", "pointers.sql");
fs.writeFileSync(sqlFile, statements.join("\n"), { mode: 0o600 });
fs.writeFileSync(path.join(ROOT, ".foilbury", "ai-banners", "rollback.sql"), rollback.join("\n\n"), { mode: 0o600 });
if (apply) {
  execFileSync("npx", ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", config, "--file", sqlFile], {
    cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "inherit", "inherit"],
  });
  const after = d1(`SELECT id, slug, name, logo_url, banner_url, logo_asset_id, banner_asset_id, release_version, status, view_audience FROM fb_collections WHERE slug IN (${slugs.map(esc).join(",")}) ORDER BY slug`);
  fs.writeFileSync(path.join(ROOT, ".foilbury", "ai-banners", "after.json"), JSON.stringify(after, null, 2), { mode: 0o600 });
  const changed = after.filter((row) => row.release_version !== bySlug.get(row.slug)?.release_version);
  console.log(JSON.stringify({ updated: after.length, release_version_changed: changed, sqlFile }, null, 2));
} else {
  console.log(JSON.stringify({ dry_run: true, entries: statements.length, sqlFile }, null, 2));
}
