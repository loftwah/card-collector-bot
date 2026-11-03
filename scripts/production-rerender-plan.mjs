#!/usr/bin/env node
/**
 * Read-only production render readiness plan.
 *
 * Verifies source assets, render/source-hash state, pending jobs and the
 * collection audience split. It never applies a migration, queues a job,
 * uploads an asset or changes D1/R2. The printed batches are the bounded
 * approval unit for an authorised re-render.
 *
 *   node scripts/production-rerender-plan.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const jsonOnly = process.argv.includes("--json");
const root = process.cwd();

function remote(sql) {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--config",
      "wrangler.production.jsonc",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}

const totals = remote(`SELECT
  (SELECT COUNT(*) FROM fb_card_definitions WHERE archived_at IS NULL) AS cards,
  (SELECT COUNT(*) FROM fb_variants WHERE status='published' AND archived_at IS NULL) AS variants,
  (SELECT COUNT(*) FROM fb_variant_renders WHERE status='published') AS fronts,
  (SELECT COUNT(*) FROM fb_variant_back_renders) AS backs,
  (SELECT COUNT(*) FROM fb_jobs WHERE kind='render_card' AND status IN ('pending','running')) AS pending_jobs,
  (SELECT COUNT(*) FROM fb_assets WHERE kind='subject' AND archived_at IS NULL) AS subjects,
  (SELECT COUNT(*) FROM fb_assets WHERE kind='background' AND archived_at IS NULL) AS backgrounds;`)[0];

const collections = remote(`SELECT c.slug, c.name, c.view_audience, c.status,
  COUNT(DISTINCT cd.id) AS cards,
  COUNT(v.id) AS variants,
  SUM(CASE WHEN vr.id IS NULL THEN 1 ELSE 0 END) AS missing_fronts,
  SUM(CASE WHEN br.id IS NULL THEN 1 ELSE 0 END) AS missing_backs,
  SUM(CASE WHEN vr.source_hash IS NULL THEN 1 ELSE 0 END) AS fronts_without_source_hash,
  SUM(CASE WHEN vr.source_hash IS NOT NULL AND e.source_hash IS NOT NULL AND vr.source_hash <> e.source_hash THEN 1 ELSE 0 END) AS source_hash_mismatch
 FROM fb_collections c
 JOIN fb_collection_cards cc ON cc.collection_id = c.id
 JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.archived_at IS NULL
 JOIN fb_variants v ON v.card_id = cd.id AND v.status='published' AND v.archived_at IS NULL
 JOIN fb_artwork_editions e ON e.id = v.edition_id
 LEFT JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status='published'
 LEFT JOIN fb_variant_back_renders br ON br.variant_id = v.id
 WHERE c.archived_at IS NULL
 GROUP BY c.id ORDER BY c.scope, c.name;`);

const orphanSources =
  remote(`SELECT COUNT(*) AS count FROM fb_variants v
  JOIN fb_artwork_editions e ON e.id = v.edition_id
  LEFT JOIN fb_assets sa ON sa.id = e.subject_asset_id AND sa.archived_at IS NULL
  WHERE v.status='published' AND v.archived_at IS NULL AND sa.id IS NULL;`)[0]?.count ?? 0;

const batchSize = 40;
const totalVariants = Number(totals?.variants ?? 0);
const batches = [];
for (let index = 0; index < totalVariants; index += batchSize) {
  batches.push({
    batch: batches.length + 1,
    variants: Math.min(batchSize, totalVariants - index),
    offset: index,
    concurrency: 2,
    approval: `APPROVE-RENDER-${String(batches.length + 1).padStart(2, "0")}`,
  });
}

const plan = {
  generated_at: new Date().toISOString(),
  mode: "READ ONLY",
  production: {
    worker: "foilbury",
    config: "wrangler.production.jsonc",
    origin: "https://foilbury.loftwah.com",
  },
  totals,
  collections,
  checks: {
    pending_jobs: Number(totals?.pending_jobs ?? 0) === 0,
    every_variant_has_subject: orphanSources === 0,
    every_variant_has_front_and_back:
      Number(totals?.variants ?? 0) === Number(totals?.fronts ?? 0) &&
      Number(totals?.variants ?? 0) === Number(totals?.backs ?? 0),
    source_hash_mismatch: collections.reduce(
      (sum, row) => sum + Number(row.source_hash_mismatch ?? 0),
      0,
    ),
    fronts_without_source_hash: collections.reduce(
      (sum, row) => sum + Number(row.fronts_without_source_hash ?? 0),
      0,
    ),
  },
  batches,
  boundaries: {
    changes_ownership: false,
    changes_serials: false,
    changes_wallets: false,
    changes_ledger: false,
    changes_public_audience: false,
    migration_required: "0015_artwork_composition.sql (additive, nullable)",
    source_assets: "Read from private R2; never overwritten",
    output: "New published render asset; previous asset retained by the normal render service",
  },
  required_sequence: [
    "Owner approval for the bounded batch and the additive migration.",
    "node scripts/backup-d1-json.mjs (production JSON backup + SHA-256).",
    "Apply migrations/0015_artwork_composition.sql through the normal reviewed migration path.",
    "node scripts/content/requeue-renders.mjs --slug <collection>  (dry run per collection).",
    "Queue one approved batch; run the deterministic compositor with --limit/worker concurrency 2.",
    "Read back every render (750x1050, front+back, source hash) and a sample contact sheet.",
    "Publish through the existing public/member media rules; never copy member media to a public path.",
    "Record the worker version, batch counts, D1/R2 read-back and rollback pointer.",
  ],
  rollback:
    "Restore the pre-run D1 JSON only if metadata changed unexpectedly. Published render assets are additive; the previous asset IDs remain in the backup and access rules are unchanged.",
};

const outDir = path.join(".foilbury", "evidence");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, "production-rerender-plan.json");
fs.writeFileSync(file, JSON.stringify(plan, null, 2));

if (!jsonOnly) {
  console.log(JSON.stringify({ ...plan, saved_to: file }, null, 2));
} else {
  console.log(JSON.stringify(plan));
}
