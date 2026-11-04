#!/usr/bin/env node
/**
 * Read-only incremental content plan.
 *
 * Compares the private local manifests with production D1 and prints the exact
 * additions, alias resolution, affected renders, pool changes and rollback for
 * a bounded two-card import. It never writes production and never runs the
 * broad content provisioner.
 *
 *   node scripts/content/incremental-plan.mjs
 *   node scripts/content/incremental-plan.mjs --json
 *
 * The private manifest is gitignored; only this sanitised plan is retained.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const jsonOut = process.argv.includes("--json");
const manifestDir = path.join(ROOT, ".foilbury", "content");
const CONFIG = "wrangler.production.jsonc";
const SUBJECTS = [
  { manifest: "danganronpa.json", slug: "gonta-gokuhara", collection: "danganronpa-three-games", aliases: ["Gonta Gokuhara"] },
  { manifest: "vocaloid.json", slug: "kamui-gakupo", collection: "vocaloid", aliases: ["Kamui Gakupo", "Camui Gackpo", "Gackpoid"] },
];

function rows(sql) {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "foilbury", "--config", CONFIG, "--remote", "--json", "--command", sql],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("[")));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function loadManifest(file) {
  return JSON.parse(fs.readFileSync(path.join(manifestDir, file), "utf8"));
}

const productionCards = rows(
  "SELECT id, logical_id, slug, name, status, review_status FROM fb_card_definitions",
);
const productionCollections = rows(
  "SELECT id, slug, name, release_version, view_audience, status FROM fb_collections",
);
const productionPools = rows(
  "SELECT p.id, p.slug, p.status, p.revision, p.price FROM fb_pools p WHERE p.status = 'active'",
);
const poolEntryCounts = rows(
  "SELECT p.slug, COUNT(pe.id) entries FROM fb_pools p LEFT JOIN fb_pool_entries pe ON pe.pool_id = p.id GROUP BY p.id",
);
const renders = rows(
  `SELECT v.id AS variant_id, v.card_id, COUNT(DISTINCT vr.id) fronts, COUNT(DISTINCT br.id) backs
     FROM fb_variants v
     LEFT JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
     LEFT JOIN fb_variant_back_renders br ON br.variant_id = v.id AND br.status = 'published'
    GROUP BY v.id`,
);

const bySlug = new Map(productionCards.map((card) => [card.slug, card]));
const byLogical = new Map(productionCards.map((card) => [card.logical_id, card]));
const additions = [];
const problems = [];

for (const subject of SUBJECTS) {
  const manifest = loadManifest(subject.manifest);
  const card = manifest.cards.find((item) => item.slug === subject.slug);
  if (!card) {
    problems.push(`${subject.manifest}: ${subject.slug} is missing from the local manifest.`);
    continue;
  }
  const existing = bySlug.get(card.slug) ?? byLogical.get(card.logical_id ?? `${subject.collection}:${card.slug}`);
  if (existing) {
    additions.push({
      subject: card.name,
      slug: card.slug,
      status: "already_present",
      production_id: existing.id,
      action: "no-op",
    });
    continue;
  }
  const collection = productionCollections.find((item) => item.slug === subject.collection);
  const pool = productionPools.find(
    (item) => item.slug === `${subject.collection}-capsule` || item.slug === `${subject.collection}-draw`,
  );
  additions.push({
    subject: card.name,
    slug: card.slug,
    logical_id: card.logical_id ?? `${subject.collection}:${card.slug}`,
    aliases: subject.aliases,
    review_status: card.review_status ?? "draft",
    source_refs: (card.source_refs ?? []).length,
    status: "new",
    action: "import_one_card_and_four_variants",
    collection: collection
      ? {
          id: collection.id,
          slug: collection.slug,
          current_release: collection.release_version,
          proposed_release: collection.release_version + 1,
          audience: collection.view_audience,
        }
      : null,
    pool: pool ? { slug: pool.slug, revision: pool.revision, price: pool.price } : null,
    budget: { renders: 4, variants: 4, cards: 1, paid_generation_usd: 0 },
  });
}

const newCards = additions.filter((item) => item.status === "new");
const currentRelease = Object.fromEntries(
  productionCollections
    .filter((item) => SUBJECTS.some((subject) => subject.collection === item.slug))
    .map((item) => [item.slug, item.release_version]),
);

const plan = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  environment: "production",
  mode: "read-only-plan",
  source: "D1 remote read-back + private local manifests",
  current: {
    cards: productionCards.length,
    collections: productionCollections.length,
    active_pools: productionPools.length,
    danganronpa_release: currentRelease["danganronpa-three-games"] ?? null,
    vocaloid_release: currentRelease.vocaloid ?? null,
    danganronpa_pool: productionPools.find((item) => item.slug === "danganronpa-three-games-capsule") ?? null,
    vocaloid_pool: productionPools.find((item) => item.slug === "vocaloid-capsule") ?? null,
    render_coverage: {
      variants: renders.length,
      fully_rendered: renders.filter((item) => Number(item.fronts) > 0 && Number(item.backs) > 0).length,
    },
  },
  additions,
  summary: {
    new_cards: newCards.length,
    unmodified_cards: productionCards.length,
    affected_variants: newCards.length * 4,
    affected_front_renders: newCards.length * 4,
    affected_back_renders: newCards.length * 4,
    proposed_release_bumps: newCards
      .map((item) => item.collection)
      .filter(Boolean)
      .map((item) => `${item.slug}: ${item.current_release} → ${item.proposed_release}`),
    aliases_resolved: newCards.map((item) => ({ slug: item.slug, aliases: item.aliases })),
    frozen_achievements:
      "Do not rewrite the existing Three schools version; it stays at its frozen 8-card roster. A new completion version is a separate reviewed change.",
    paid_generation_usd: 0,
  },
  backup: {
    command: "node scripts/backup-d1-json.mjs",
    required_before_write: true,
    retain: "Keep the JSON export and its checksum; restore into an isolated database first.",
  },
  rollback: {
    scope: "Only the two new card rows, their four variants each and their pool entries are additive.",
    preconditions:
      "Confirm no ownership, ledger, serial, achievement or pool history depends on the new rows before deleting them.",
    production_restore: "Restore the pre-import JSON backup if the additive delete is not sufficient.",
  },
  prerequisites: [
    "A reviewed incremental importer that selects only these logical IDs; do not run pnpm content:provision.",
    "A production agent/session authorised for content import, with CSRF and recent strong authentication where required.",
    "Pool-entry weights and revision update reviewed before adding the new variants to the capsules.",
    "A fresh D1 JSON backup and checksum.",
  ],
  problems,
};

const dir = path.join(ROOT, ".foilbury", "evidence");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "content-incremental-plan.json");
fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);

if (jsonOut) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  console.log(`Incremental content plan · ${plan.mode}`);
  console.log(
    `Production: ${plan.current.cards} cards · Danganronpa release ${plan.current.danganronpa_release} · Vocaloid release ${plan.current.vocaloid_release}`,
  );
  for (const item of additions) {
    console.log(
      `${item.status === "new" ? "ADD " : "SKIP"} ${item.subject} (${item.slug}) · ${item.action}${item.collection ? ` · release ${item.collection.current_release} → ${item.collection.proposed_release}` : ""}`,
    );
  }
  console.log(
    `Affected: ${plan.summary.new_cards} card(s), ${plan.summary.affected_variants} variants, ${plan.summary.affected_front_renders} fronts, ${plan.summary.affected_back_renders} backs, US$0 paid generation.`,
  );
  console.log(`Backup: ${plan.backup.command} (required before any write).`);
  console.log(`Plan: ${path.relative(ROOT, file)}`);
  if (problems.length) {
    console.error(`Problems: ${problems.join("; ")}`);
    process.exitCode = 1;
  }
}
