#!/usr/bin/env node
/**
 * Remove duplicate artwork editions that have no owned copies, keeping the
 * edition that carries awards (or the newest source revision). This is a
 * local-repair tool for data created by the old "new edition on every import"
 * path; it never deletes an edition with an owned instance.
 *
 * Usage:
 *   node scripts/content/cleanup-duplicate-editions.mjs --dry-run
 *   node scripts/content/cleanup-duplicate-editions.mjs --apply
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const dryRun = !apply;
const root = process.cwd();

function findLocalDb() {
  const base = path.join(root, ".wrangler/state/v3/d1");
  if (!fs.existsSync(base)) throw new Error("Local D1 state was not found. Run pnpm setup:local first.");
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(entry));
    if (!file.endsWith(".sqlite") || file.endsWith("metadata.sqlite")) continue;
    try {
      const tables = execFileSync("sqlite3", [file, "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_artwork_editions';"], { encoding: "utf8" }).trim();
      if (tables) return file;
    } catch {
      // Not the application database.
    }
  }
  throw new Error("The local D1 application database was not found.");
}

const db = findLocalDb();
function query(sql) {
  const output = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

const cards = query(`
  SELECT cd.id, cd.slug, COUNT(*) AS editions
    FROM fb_artwork_editions e
    JOIN fb_card_definitions cd ON cd.id = e.card_id
   WHERE e.archived_at IS NULL
   GROUP BY cd.id
  HAVING editions > 1
   ORDER BY cd.slug
`);

let removed = 0;
let kept = 0;
let skipped = 0;
for (const card of cards) {
  const editions = query(`
    SELECT e.id, e.created_at,
           (SELECT COUNT(*) FROM fb_card_instances i
              JOIN fb_variants v ON v.id = i.variant_id
             WHERE v.edition_id = e.id) AS instances
      FROM fb_artwork_editions e
     WHERE e.card_id = '${card.id}' AND e.archived_at IS NULL
     ORDER BY e.created_at DESC
  `);
  const owned = editions.find((edition) => Number(edition.instances) > 0);
  const keeper = owned ?? editions[0];
  kept += 1;
  for (const edition of editions) {
    if (edition.id === keeper.id) continue;
    if (Number(edition.instances) > 0) {
      skipped += 1;
      console.log(`SKIP ${card.slug} ${edition.id}: ${edition.instances} owned instance(s)`);
      continue;
    }
    const variants = query(`SELECT id FROM fb_variants WHERE edition_id = '${edition.id}'`).map((row) => `'${row.id}'`);
    const variantList = variants.length ? variants.join(",") : "''";
    const sql = `BEGIN;
      DELETE FROM fb_variant_renders WHERE variant_id IN (${variantList});
      DELETE FROM fb_jobs WHERE json_extract(payload_json, '$.variant_id') IN (${variantList});
      DELETE FROM fb_variants WHERE edition_id = '${edition.id}';
      DELETE FROM fb_artwork_editions WHERE id = '${edition.id}';
      COMMIT;`;
    if (dryRun) {
      console.log(`WOULD REMOVE ${card.slug} ${edition.id} (${edition.instances} owned)`);
    } else {
      execFileSync("sqlite3", [db, sql], { encoding: "utf8" });
      console.log(`REMOVED ${card.slug} ${edition.id} (${edition.instances} owned)`);
    }
    removed += 1;
  }
}
console.log(JSON.stringify({ database: db, cards: cards.length, kept, removed, skipped, dryRun }, null, 2));
