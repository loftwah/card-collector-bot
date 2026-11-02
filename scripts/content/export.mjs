#!/usr/bin/env node
/**
 * Export a reproducible catalogue + asset manifest snapshot.
 *
 *   node scripts/content/export.mjs
 *   FOILBURY_URL=https://foilbury.loftwah.com FOILBURY_AGENT_TOKEN=fba_... \
 *     node scripts/content/export.mjs --output .foilbury/exports/prod.json
 *
 * The snapshot contains metadata only. It never embeds private image bytes,
 * member inventories or secrets.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { apiJson, ensureServer } from "../lib/api.mjs";

const args = process.argv.slice(2);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const output = path.resolve(process.cwd(), outputArg ? outputArg.split("=")[1] : `.foilbury/exports/catalogue-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

async function main() {
  if (!process.env.FOILBURY_URL) await ensureServer();
  const [collections, cards, assets, achievements, pools, releases] = await Promise.all([
    apiJson("/api/v1/admin/collections"),
    apiJson("/api/v1/admin/cards?limit=2000"),
    apiJson("/api/v1/admin/assets"),
    apiJson("/api/v1/admin/achievements"),
    apiJson("/api/v1/admin/pools"),
    apiJson("/api/v1/admin/imports"),
  ]);
  const snapshot = {
    schema: 1,
    generated_at: new Date().toISOString(),
    source: "foilbury-admin-api",
    collections: collections.items.map((collection) => ({
      id: collection.id,
      slug: collection.slug,
      name: collection.name,
      description: collection.description,
      scope: collection.scope,
      status: collection.status,
      view_audience: collection.view_audience,
      public_approved_at: collection.public_approved_at,
      release_version: collection.release_version,
      logo_url: collection.logo_url,
      banner_url: collection.banner_url,
      back_url: collection.back_url,
      source_work: collection.source_work,
      source_context: collection.source_context,
      content_advisory: collection.content_advisory,
      card_count: collection.card_count,
    })),
    cards: cards.items.map((card) => ({
      id: card.id,
      slug: card.slug,
      name: card.name,
      subtitle: card.subtitle,
      description: card.description,
      bio: card.bio,
      bio_safe: card.bio_safe,
      spoiler_level: card.spoiler_level,
      attributes_json: card.attributes_json,
      review_status: card.review_status,
      source_work: card.source_work,
      version: card.version,
      status: card.status,
      collections: card.collections.map((item) => item.slug),
      editions: card.editions.map((edition) => ({
        id: edition.id,
        status: edition.status,
        variants: edition.variants.map((variant) => ({
          id: variant.id,
          name: variant.name,
          material_key: variant.material_key,
          effect_key: variant.effect_key,
          status: variant.status,
          render_url: variant.render_url,
          back_render_url: variant.back_render_url,
          thumbnail_url: variant.thumbnail_url,
          preview_url: variant.preview_url,
        })),
      })),
    })),
    assets: assets.items.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      sha256: asset.sha256,
      access_classification: asset.access_classification,
      role: asset.role,
      official: Boolean(asset.official),
      review_status: asset.review_status,
      provenance_json: asset.provenance_json,
      source_repo: asset.source_repo,
      source_path: asset.source_path,
      source_commit: asset.source_commit,
      source_logical_id: asset.source_logical_id,
      credit: asset.credit,
    })),
    achievements: achievements.items,
    pools: pools.items,
    import_runs: releases.runs,
  };
  const json = JSON.stringify(snapshot, null, 2);
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, json, { mode: 0o600 });
  fs.writeFileSync(`${output}.sha256`, `${hash}  ${path.basename(output)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    output,
    collections: snapshot.collections.length,
    cards: snapshot.cards.length,
    assets: snapshot.assets.length,
    achievements: snapshot.achievements.length,
    sha256: hash,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
