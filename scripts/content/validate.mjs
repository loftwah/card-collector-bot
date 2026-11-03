#!/usr/bin/env node
/**
 * Validate private collection manifests without touching the database.
 *
 *   node scripts/content/validate.mjs
 *   node scripts/content/validate.mjs --json
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const contentDir = path.join(root, ".foilbury/content");
const jsonOut = process.argv.includes("--json");
const errors = [];
const warnings = [];
const slugs = new Map();
const logicalIds = new Map();

if (!fs.existsSync(contentDir)) {
  console.error(`No content directory at ${contentDir}`);
  process.exit(1);
}

const files = fs.readdirSync(contentDir).filter((file) => file.endsWith(".json")).sort();
const report = { files: files.length, collections: [], cards: 0, achievements: 0, errors, warnings };

for (const file of files) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(contentDir, file), "utf8"));
  } catch (error) {
    errors.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  // Print-set manifests live beside collection manifests but are consumed by
  // the print-selection workflow, not the collection importer.
  if (!manifest.collection && (manifest.prints || manifest.selections || manifest.print_set || manifest.subjects)) {
    continue;
  }
  const collection = manifest.collection ?? {};
  if (manifest.schema !== 1) errors.push(`${file}: schema must be 1`);
  if (!collection.slug) errors.push(`${file}: collection.slug is required`);
  if (!collection.name) errors.push(`${file}: collection.name is required`);
  if (!["public", "members", "private"].includes(collection.view_audience ?? "members")) {
    errors.push(`${file}: collection.view_audience must be public, members or private`);
  }
  if (!Array.isArray(manifest.cards) || manifest.cards.length < 1) {
    errors.push(`${file}: at least one card is required`);
    continue;
  }
  const cardSlugs = new Set();
  for (const card of manifest.cards) {
    report.cards += 1;
    const label = `${file}:${card.slug ?? "?"}`;
    for (const field of ["slug", "name", "description", "bio", "source_refs", "attributes", "art"]) {
      if (card[field] === undefined || card[field] === null || card[field] === "") errors.push(`${label}: missing ${field}`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(card.slug ?? "")) errors.push(`${label}: slug must be lowercase kebab-case`);
    if (cardSlugs.has(card.slug)) errors.push(`${label}: duplicate slug in collection`);
    cardSlugs.add(card.slug);
    if (slugs.has(card.slug)) warnings.push(`${label}: slug also used by ${slugs.get(card.slug)}; the importer will disambiguate`);
    slugs.set(card.slug, file);
    if (card.logical_id) {
      if (logicalIds.has(card.logical_id)) errors.push(`${label}: duplicate logical_id ${card.logical_id}`);
      logicalIds.set(card.logical_id, file);
    }
    if (Number(card.spoiler_level ?? 0) > 0 && !card.bio_full) errors.push(`${label}: spoiler_level > 0 requires bio_full`);
    if (!Array.isArray(card.source_refs) || card.source_refs.length === 0) errors.push(`${label}: source_refs must contain at least one reference`);
    for (const ref of card.source_refs ?? []) {
      if (!/^https?:\/\//.test(ref)) errors.push(`${label}: source reference is not an HTTP(S) URL: ${ref}`);
    }
    if (!Array.isArray(card.attributes)) errors.push(`${label}: attributes must be an array`);
    if (!card.review_status) warnings.push(`${label}: review_status missing; defaults to draft`);
    if (card.credit && !/original|interpretation|placeholder/i.test(card.credit)) {
      warnings.push(`${label}: credit should clearly state that the art is an original interpretation`);
    }
  }
  for (const achievement of manifest.achievements ?? []) {
    report.achievements += 1;
    if (!achievement.key || !achievement.name || !achievement.criteria) errors.push(`${file}: achievement is missing key, name or criteria`);
    const target = Number(achievement.criteria?.target ?? 0);
    if (achievement.criteria?.type === "collection_unique" && target < 1) errors.push(`${file}: achievement ${achievement.key} needs a positive target`);
    if (!achievement.reward || typeof achievement.reward.foil !== "number") warnings.push(`${file}: achievement ${achievement.key} has no Foil reward`);
  }
  report.collections.push({
    file,
    slug: collection.slug,
    name: collection.name,
    audience: collection.view_audience ?? "members",
    cards: manifest.cards.length,
    achievements: manifest.achievements?.length ?? 0,
    reviewed: manifest.cards.filter((card) => card.review_status === "reviewed").length,
    draft: manifest.cards.filter((card) => card.review_status !== "reviewed").length,
  });
}

if (jsonOut) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Validated ${report.collections.length} collections, ${report.cards} cards, ${report.achievements} achievements.`);
  for (const collection of report.collections) {
    console.log(`  ${collection.slug.padEnd(28)} ${String(collection.cards).padStart(3)} cards · ${collection.reviewed} reviewed · ${collection.draft} draft · ${collection.audience}`);
  }
  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }
}
if (errors.length) {
  console.error(`\nErrors (${errors.length}):`);
  for (const error of errors) console.error(`  × ${error}`);
  process.exitCode = 1;
}
