import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { discoverSources, toManifest, writeDiscovery } from "./data.mjs";
import { apiForm, apiJson, ensureServer } from "../lib/api.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const publish = args.has("--publish");
const json = args.has("--json");
const noRender = args.has("--no-render");
const refreshPools = args.has("--refresh-pools");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : undefined;

function log(message) {
  if (!json) console.log(message);
}

async function prepareSubject(item) {
  const buffer = fs.readFileSync(item.absolutePath);
  const meta = await sharp(buffer).metadata();
  let image;
  if (meta.hasAlpha) {
    image = await sharp(buffer)
      .trim({ threshold: 12 })
      .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } else if (meta.width === meta.height) {
    image = await sharp(buffer)
      .resize({ width: 1024, height: 1024, fit: "cover", position: "attention" })
      .png()
      .toBuffer();
  } else {
    image = await sharp(buffer)
      .resize({ width: 1024, height: 1280, fit: "cover", position: "top" })
      .png()
      .toBuffer();
  }
  return image;
}

async function prepareBackground(background) {
  const buffer = fs.readFileSync(background.absolutePath);
  return sharp(buffer).resize({ width: 1600, height: 1000, fit: "cover", position: "attention" }).png().toBuffer();
}

async function upload(bytes, fields) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), `${fields.name}.png`);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  const result = await apiForm("/api/v1/admin/assets", form);
  return result.asset;
}

async function publishEverything(discovered) {
  const sets = await apiJson("/api/v1/admin/sets");
  for (const set of sets.items) {
    if (set.status === "draft" && set.cards.length > 0) {
      await apiJson(`/api/v1/admin/sets/${set.id}/publish`, { method: "POST", body: {} });
      log(`  published set ${set.slug} v${set.version}`);
    }
  }
  const cards = await apiJson("/api/v1/admin/cards?limit=200");
  const variants = cards.items.flatMap((card) =>
    card.editions.flatMap((edition) =>
      edition.variants
        .filter((variant) => variant.status === "published" && variant.render_url)
        .map((variant) => ({
          ...variant,
          card_name: card.name,
          setSlugs: card.sets.map((set) => set.slug),
          tags: card.tags.map((tag) => tag.slug),
        })),
    ),
  );
  const existing = await apiJson("/api/v1/admin/pools");
  const existingSlugs = new Set(existing.items.map((pool) => pool.slug));
  const poolSpecs = [
    { slug: "cabinet-draw", name: "Cabinet Draw", description: "A cross-cabinet draw from the curated starter collection.", price: 80, setSlugs: ["first-cabinet", "shared-table", "protocol-table"], tags: [] },
    { slug: "fighter-draw", name: "Fighter Draw", description: "The Fighter Night pool, including shared-character editions.", price: 95, setSlugs: ["fighter-night"], tags: [] },
    { slug: "protocol-draw", name: "Protocol Draw", description: "Five late-table regulars and their finishes.", price: 90, setSlugs: ["protocol-table"], tags: [] },
    { slug: "late-night-draw", name: "Late Night Draw", description: "A narrow pool tagged horror. Useful for community-policy and empty-pool checks.", price: 60, setSlugs: ["fighter-night"], tags: ["horror"], channelKey: "family-table" },
  ];
  for (const spec of poolSpecs) {
    const eligible = variants.filter(
      (variant) =>
        variant.setSlugs.some((slug) => spec.setSlugs.includes(slug)) &&
        (spec.tags.length === 0 || spec.tags.every((tag) => variant.tags.includes(tag))),
    );
    if (!eligible.length) continue;
    if (existingSlugs.has(spec.slug) && !refreshPools) continue;
    const entries = eligible.map((variant) => ({
      variantId: variant.id,
      weight:
        variant.effect_key === "holographic" ? 12 : variant.material_key === "diamond" ? 8 : variant.material_key === "gold" ? 28 : variant.material_key === "silver" ? 55 : 100,
    }));
    if (existingSlugs.has(spec.slug)) {
      const pool = existing.items.find((item) => item.slug === spec.slug);
      const updated = await apiJson(`/api/v1/admin/pools/${pool.id}`, {
        method: "PATCH",
        body: { expectedRevision: pool.revision, price: spec.price, entries },
      });
      await apiJson(`/api/v1/admin/pools/${updated.pool.id}/publish`, { method: "POST", body: {} });
      log(`  refreshed pool ${spec.slug} v${updated.pool.revision}`);
    } else {
      const created = await apiJson("/api/v1/admin/pools", {
        method: "POST",
        body: {
          slug: spec.slug,
          name: spec.name,
          description: spec.description,
          price: spec.price,
          channelKey: spec.channelKey,
          entries,
        },
      });
      await apiJson(`/api/v1/admin/pools/${created.pool.id}/publish`, { method: "POST", body: {} });
      log(`  created pool ${spec.slug} (${entries.length} entries)`);
    }
  }
  const topics = await apiJson("/api/v1/admin/topics");
  if (!topics.items.some((topic) => topic.channel_key === "family-table")) {
    await apiJson("/api/v1/admin/topics", {
      method: "POST",
      body: { channelKey: "family-table", name: "Family table", excludeTags: ["horror"] },
    });
    log("  created topic policy family-table (excludes horror)");
  }
  const release = await apiJson("/api/v1/admin/catalogue/publish", { method: "POST", body: {} });
  log(`  catalogue release v${release.version} ${release.checksum.slice(0, 12)}…`);
  return { sets: sets.items.length, variants: variants.length, release };
}

try {
  const discovered = discoverSources();
  writeDiscovery(discovered, path.join(process.cwd(), ".foilbury/sources/discovered.json"));
  const items = limit ? discovered.items.slice(0, limit) : discovered.items;
  const limited = { ...discovered, items };
  const manifestPreview = toManifest(limited);
  await ensureServer();
  const preview = await apiJson("/api/v1/admin/imports/preview", { method: "POST", body: manifestPreview });
  log(`Foilbury source import ${apply ? "(apply)" : "(preview only)"}`);
  log(`  new: ${preview.counts.new}  revisions: ${preview.counts.revision}  unchanged: ${preview.counts.unchanged}`);
  if (!apply) {
    for (const item of preview.items) log(`  ${item.action.padEnd(9)} ${item.slug.padEnd(20)} ${item.variants.length} variants`);
    log("No files were uploaded. Re-run with --apply to import.");
    process.exit(0);
  }

  const assetMap = {};
  for (const background of limited.backgrounds) {
    const bytes = await prepareBackground(background);
    const asset = await upload(bytes, {
      kind: "background",
      name: background.name,
      sourceRepo: background.sourceRepo,
      sourcePath: background.sourcePath,
      sourceCommit: background.sourceCommit,
      sourceLogicalId: `background:${background.key}`,
      credit: `${background.source} background supplied by the owner.`,
    });
    assetMap[`background:${background.key}`] = asset.id;
    log(`  background ${background.key} -> ${asset.id}`);
  }
  for (const item of items) {
    const bytes = await prepareSubject(item);
    const asset = await upload(bytes, {
      kind: "subject",
      name: item.name,
      sourceRepo: item.sourceRepo,
      sourcePath: item.sourcePath,
      sourceCommit: item.sourceCommit,
      sourceLogicalId: item.logicalId,
      credit: item.credit,
    });
    assetMap[`subject:${item.logicalId}:${item.sourceHash}`] = asset.id;
    log(`  subject ${item.slug} -> ${asset.id} (${asset.width}×${asset.height}, ${asset.bytes} bytes)`);
  }
  const manifest = toManifest(limited, assetMap);
  const result = await apiJson("/api/v1/admin/imports", { method: "POST", body: { ...manifest, publish: true } });
  log(`  import run ${result.runId}: ${JSON.stringify(result.summary)}`);
  for (const item of result.results.filter((row) => row.status === "failed")) log(`  FAILED ${item.logicalId}: ${item.error}`);

  let release = null;
  if (publish) {
    if (!noRender) {
      log("  rendering published variants…");
      const rendered = spawnSync(process.execPath, [path.join(process.cwd(), "scripts/render-cards.mjs"), "--all"], {
        stdio: json ? "ignore" : "inherit",
        cwd: process.cwd(),
      });
      if (rendered.status !== 0) throw new Error("Card rendering failed. Run pnpm cards:render for details.");
    }
    const published = await publishEverything(limited);
    release = published.release;
  }
  const uniqueCards = new Set(items.map((item) => item.logicalId)).size;
  const summary = {
    appliedAt: new Date().toISOString(),
    sourceCommits: Object.fromEntries(Object.entries(limited.sources).map(([name, source]) => [name, source.commit])),
    counts: result.summary,
    backgrounds: limited.backgrounds.length,
    cards: uniqueCards,
    editions: items.length,
    variants: items.reduce((sum, item) => sum + item.variants.length, 0),
    release,
  };
  fs.mkdirSync(path.join(process.cwd(), ".foilbury/sources"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), ".foilbury/import-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    log("Import complete.");
    log(`  cards: ${uniqueCards}, editions: ${items.length}, variants: ${summary.variants}`);
    if (release) log(`  live catalogue release v${release.version}`);
  }
} catch (error) {
  console.error(`sources:import failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
