#!/usr/bin/env node
/**
 * Export the reviewed local print set into a reproducible production bundle.
 *
 *   node scripts/art/export-print-set.mjs
 *
 * Produces:
 *   .foilbury/exports/print-set/production.sql
 *   .foilbury/exports/print-set/r2/<key>
 *   .foilbury/exports/print-set/manifest.json
 *
 * The SQL is additive and idempotent. It never deletes or rewrites an existing
 * catalogue row. User references are mapped to the provisioned production owner
 * so the review is recorded as an agent-delegated decision, not a human one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apiFetch, agentToken, ensureServer, BASE_URL } from "../lib/api.mjs";

const root = process.cwd();
const outDir = path.join(root, ".foilbury/exports/print-set");
const r2Dir = path.join(outDir, "r2");
fs.mkdirSync(r2Dir, { recursive: true, mode: 0o700 });

const dbFile = fs
  .readdirSync(path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"))
  .find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
if (!dbFile) throw new Error("Local D1 database not found. Run pnpm db:migrate:local first.");
const db = new DatabaseSync(
  path.join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject", dbFile),
);
const q = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);

const selections = JSON.parse(
  fs.readFileSync(path.join(root, ".foilbury/content/print-selections.json"), "utf8"),
);
const plan = JSON.parse(fs.readFileSync(path.join(root, ".foilbury/content/print-set.json"), "utf8"));
const cards = q("SELECT id, slug, name FROM fb_card_definitions WHERE slug IN ('tux','gabe','drop-bear')");
const allowedNames = [];
for (const selection of selections.prints) {
  const subject = plan.subjects.find((item) => item.slug === selection.subject);
  const print = subject?.prints.find(
    (item) =>
      `${item.print_number}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` ===
      selection.print,
  );
  const card = cards.find((item) => item.slug === subject?.card_slug);
  if (print && card) allowedNames.push(`${card.name} — ${print.title}`);
}
const editions = q(
  `SELECT * FROM fb_artwork_editions WHERE name IN (${allowedNames.map(() => "?").join(",")})`,
  ...allowedNames,
);
if (editions.length !== allowedNames.length) {
  throw new Error(`Expected ${allowedNames.length} editions, found ${editions.length}.`);
}
const editionIds = editions.map((row) => row.id);
const variants = q(
  `SELECT * FROM fb_variants WHERE edition_id IN (${editionIds.map(() => "?").join(",")})`,
  ...editionIds,
);
const variantIds = variants.map((row) => row.id);
const renders = q(
  `SELECT * FROM fb_variant_renders WHERE variant_id IN (${variantIds.map(() => "?").join(",")})`,
  ...variantIds,
);
const backRenders = q(
  `SELECT * FROM fb_variant_back_renders WHERE variant_id IN (${variantIds.map(() => "?").join(",")})`,
  ...variantIds,
);
const proposals = q(
  `SELECT * FROM fb_print_proposals WHERE card_id IN (${cards.map(() => "?").join(",")})
    AND provenance_json LIKE '%original-ip-second-print%'`,
  ...cards.map((row) => row.id),
);
const proposalIds = proposals.map((row) => row.id);
const reviews = q(
  `SELECT * FROM fb_print_proposal_reviews WHERE proposal_id IN (${proposalIds.map(() => "?").join(",")})`,
  ...proposalIds,
);
const pool = one("SELECT * FROM fb_pools WHERE slug = 'second-print-capsule'");
if (!pool) throw new Error("The second-print pool has not been provisioned locally.");
const poolEntries = q(
  "SELECT * FROM fb_pool_entries WHERE pool_id = ? AND pool_revision = ?",
  pool.id,
  pool.revision,
);

const assetIds = new Set([
  ...editions.map((row) => row.subject_asset_id),
  ...editions.map((row) => row.background_asset_id).filter(Boolean),
  ...renders.map((row) => row.asset_id),
  ...backRenders.map((row) => row.asset_id),
]);
const assets = q(
  `SELECT * FROM fb_assets WHERE id IN (${[...assetIds].map(() => "?").join(",")})`,
  ...[...assetIds],
);

await ensureServer();
const token = agentToken("owner");
let downloaded = 0;
for (const asset of assets) {
  const endpoint = asset.kind === "render"
    ? asset.role === "render_back"
      ? `/media/back/${asset.id}`
      : `/media/render/${asset.id}`
    : `/media/asset/${asset.id}`;
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Could not download ${endpoint} (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const target = path.join(r2Dir, asset.r2_key);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  downloaded += 1;
}

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

const ownerId = "usr_prod_owner";
const userColumns = new Set(["created_by", "reviewed_by", "reviewer_id", "actor_id"]);
function insertStatement(table, row) {
  const columns = Object.keys(row);
  const values = columns.map((column) => {
    if (userColumns.has(column) && typeof row[column] === "string" && row[column].startsWith("usr_")) {
      return quote(ownerId);
    }
    return quote(row[column]);
  });
  return `INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES (${values.join(",")});`;
}

const lines = [
  "-- Foilbury reviewed original-IP print set.",
  "-- Additive and idempotent. Generated from the locally reviewed D1 catalogue.",
  "-- D1's file executor rejects explicit BEGIN/COMMIT; each statement is independently idempotent.",
  ...assets.map((row) => insertStatement("fb_assets", row)),
  ...editions.map((row) => insertStatement("fb_artwork_editions", row)),
  ...variants.map((row) => insertStatement("fb_variants", row)),
  ...renders.map((row) => insertStatement("fb_variant_renders", row)),
  ...backRenders.map((row) => insertStatement("fb_variant_back_renders", row)),
  ...proposals.map((row) => insertStatement("fb_print_proposals", row)),
  ...reviews.map((row) => insertStatement("fb_print_proposal_reviews", row)),
  insertStatement("fb_pools", pool),
  ...poolEntries.map((row) => insertStatement("fb_pool_entries", row)),
];
for (const edition of editions) {
  lines.push(
    `INSERT OR IGNORE INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at) VALUES (${quote(`aud_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`)}, ${quote(edition.tenant_id)}, 'agent', ${quote(ownerId)}, ${quote(ownerId)}, 'print.set.published', 'artwork_edition', ${quote(edition.id)}, ${quote(JSON.stringify({ source: "agent-delegated print set", edition: edition.name }))}, NULL, ${quote(new Date().toISOString())});`,
  );
}
fs.writeFileSync(path.join(outDir, "production.sql"), `${lines.join("\n")}\n`, { mode: 0o600 });

const manifest = {
  generated_at: new Date().toISOString(),
  generated_from_local_db: dbFile,
  editions: editions.map((row) => ({ id: row.id, name: row.name, status: row.status })),
  counts: {
    assets: assets.length,
    editions: editions.length,
    variants: variants.length,
    fronts: renders.length,
    backs: backRenders.length,
    proposals: proposals.length,
    reviews: reviews.length,
    pool_entries: poolEntries.length,
    r2_files: downloaded,
  },
  total_bytes: assets.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
  sql: path.relative(root, path.join(outDir, "production.sql")),
  r2_root: path.relative(root, r2Dir),
  reviewed_by: "agent-delegated",
  source_commit: plan.source_commit,
  hashes: {
    sql: crypto.createHash("sha256").update(fs.readFileSync(path.join(outDir, "production.sql"))).digest("hex"),
  },
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
