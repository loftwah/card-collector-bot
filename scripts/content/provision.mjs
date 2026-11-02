#!/usr/bin/env node
/**
 * Provision the launch collection manifests through the supported API.
 *
 * Usage:
 *   node scripts/content/provision.mjs --dry-run
 *   node scripts/content/provision.mjs
 *   FOILBURY_URL=https://foilbury.loftwah.com FOILBURY_AGENT_TOKEN=fba_... \
 *     node scripts/content/provision.mjs --skip-render
 *
 * Art is generated locally from deterministic original briefs, uploaded to R2,
 * then imported through the same domain operations as the Admin UI. The script
 * is idempotent: unchanged source hashes are skipped, cards keep their stable
 * IDs, and existing awards are never rewritten.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { generateCollectionArt } from "../../art/collection-art.mjs";
import { composeCard, composeCardBack } from "../../art/compose.mjs";
import { apiForm, apiJson, ensureServer, BASE_URL, agentToken, accessHeaders } from "../lib/api.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipRender = args.has("--skip-render");
const regenerateArt = args.has("--regenerate-art");
const forceRender = args.has("--force-render");
const makeDerivatives = args.has("--derivatives");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1] : null;
const jsonOut = args.has("--json");
const root = process.cwd();
const contentDir = path.join(root, ".foilbury/content");
const artDir = path.join(root, ".foilbury/generated");
const tmpDir = path.join(root, ".foilbury/tmp");
fs.mkdirSync(tmpDir, { recursive: true });

function log(message) {
  if (!jsonOut) console.log(message);
}

function failure(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validateManifest(manifest, file) {
  const problems = [];
  if (manifest.schema !== 1) problems.push("schema must be 1");
  if (!manifest.collection?.slug) problems.push("collection.slug is required");
  if (!manifest.collection?.name) problems.push("collection.name is required");
  if (!Array.isArray(manifest.cards) || manifest.cards.length < 1) problems.push("at least one card is required");
  const seen = new Set();
  for (const card of manifest.cards ?? []) {
    if (!card.slug || !card.name || !card.bio) problems.push(`card ${card.slug ?? "?"} needs slug, name and bio`);
    if (seen.has(card.slug)) problems.push(`duplicate card slug ${card.slug}`);
    seen.add(card.slug);
    if (card.spoiler_level > 0 && !card.bio_full) problems.push(`card ${card.slug} is flagged for spoilers but has no bio_full`);
  }
  if (problems.length) failure(`${file}: ${problems.join("; ")}`);
}

function loadManifests() {
  if (!fs.existsSync(contentDir)) failure(`No content directory at ${contentDir}`);
  const files = fs
    .readdirSync(contentDir)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => !only || file === `${only}.json`)
    .sort();
  if (!files.length) failure("No content manifests found.");
  const seen = new Map();
  return files.map((file) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, file), "utf8"));
    validateManifest(manifest, file);
    for (const card of manifest.cards) {
      const existing = seen.get(card.slug);
      if (existing) {
        const unique = `${manifest.collection.slug}-${card.slug}`;
        log(`  slug collision: ${card.slug} (${existing}) → ${unique}`);
        card.slug = unique;
        if (card.logical_id) card.logical_id = `${card.logical_id}:${manifest.collection.slug}`;
      }
      seen.set(card.slug, manifest.collection.slug);
    }
    return { file, manifest };
  });
}

async function upload(filePath, fields) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "image/png" }), path.basename(filePath));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  const result = await apiForm("/api/v1/admin/assets", form);
  return result.asset;
}

async function ensureCollection(manifest, logoUrl, bannerUrl, backUrl) {
  const list = await apiJson("/api/v1/admin/collections");
  const existing = list.items.find((item) => item.slug === manifest.collection.slug);
  const body = {
    name: manifest.collection.name,
    description: manifest.collection.description,
    logoUrl,
    bannerUrl,
    backUrl,
    accent: manifest.collection.accent ?? "brass",
    sourceWork: manifest.collection.source_work,
    sourceContext: manifest.collection.source_context,
    contentAdvisory: manifest.collection.content_advisory,
    viewAudience: manifest.collection.view_audience ?? "members",
    status: "published",
    featured: Boolean(manifest.collection.featured),
  };
  if (existing) {
    const updated = await apiJson(`/api/v1/admin/collections/${existing.id}`, { method: "PATCH", body });
    return updated.collection;
  }
  const created = await apiJson("/api/v1/admin/collections", {
    method: "POST",
    body: { ...body, slug: manifest.collection.slug, scope: "global" },
  });
  return created.collection;
}

async function ensureCategories(manifest) {
  if (!manifest.collection.categories?.length) return;
  const taxonomy = await apiJson("/api/v1/admin/taxonomy");
  const existing = new Set((taxonomy.categories ?? []).map((item) => item.slug));
  for (const category of manifest.collection.categories) {
    if (existing.has(category.slug)) continue;
    await apiJson("/api/v1/admin/taxonomy", {
      method: "POST",
      body: { kind: "category", key: category.slug, name: category.name, description: category.description },
    });
  }
}

async function importCards(manifest, assets) {
  const existing = await apiJson("/api/v1/admin/cards?limit=2000");
  const versionBySlug = new Map(existing.items.map((card) => [card.slug, card.version]));
  const items = manifest.cards.map((card) => {
    const art = assets.get(card.slug);
    return {
      source: manifest.source,
      sourceRepo: manifest.source_repo,
      sourceCommit: manifest.source_commit,
      sourcePath: `content/${manifest.collection.slug}/${card.slug}.json`,
      sourceHash: sha256(JSON.stringify(card)),
      logicalId: card.logical_id ?? `${manifest.collection.slug}:${card.slug}`,
      slug: card.slug,
      name: card.name,
      subtitle: card.subtitle,
      description: card.description ?? card.bio,
      bio: card.bio,
      bioSafe: card.bio,
      bioFull: card.bio_full,
      spoilerLevel: card.spoiler_level ?? 0,
      attributes: card.attributes ?? [],
      sourceRefs: card.source_refs ?? [],
      reviewStatus: card.review_status ?? "draft",
      sourceWork: manifest.collection.source_work,
      adaptationBoundary: manifest.collection.source_context,
      quote: card.quote,
      categorySlug: card.category_slug,
      collectionSlug: manifest.collection.slug,
      rarityKey: card.rarity_key,
      tags: card.tags ?? [],
      credit: card.credit ?? "Original Foilbury interpretation. Not official artwork.",
      subjectAssetId: art.subject.id,
      backgroundAssetId: art.background.id,
      variants: [
        { material: "plain", effect: "none" },
        { material: "silver", effect: "none" },
        { material: "gold", effect: "none" },
        { material: "gold", effect: "holographic" },
      ],
      sets: [],
      expectedVersion: versionBySlug.get(card.slug),
    };
  });
  const manifestBody = {
    source: manifest.source,
    sourceRepo: manifest.source_repo,
    sourceCommit: manifest.source_commit,
    publish: true,
    items,
  };
  const preview = await apiJson("/api/v1/admin/imports/preview", { method: "POST", body: manifestBody });
  if (dryRun) return { preview, committed: null };
  const committed = await apiJson("/api/v1/admin/imports", { method: "POST", body: manifestBody });
  return { preview, committed };
}

async function createAchievements(manifest, collection) {
  if (!manifest.achievements?.length) return [];
  const existing = await apiJson("/api/v1/admin/achievements");
  const keys = new Set(existing.items.map((item) => item.key));
  const created = [];
  for (const achievement of manifest.achievements) {
    if (keys.has(achievement.key)) continue;
    const criteria = { ...achievement.criteria };
    if (criteria.collection_id === "@collection") criteria.collection_id = collection.id;
    const result = await apiJson("/api/v1/admin/achievements", {
      method: "POST",
      body: {
        scope: "platform",
        key: achievement.key,
        name: achievement.name,
        description: achievement.description,
        criteria,
        reward: achievement.reward ?? {},
        visibility: "member",
        artKey: achievement.art_key ?? "medal-collection",
        category: achievement.category ?? "collection",
      },
    });
    created.push(result.id);
  }
  return created;
}

async function renderQueue(cards, generated) {
  const queue = await apiJson("/api/v1/admin/renders/queue", { method: "POST", body: { force: forceRender } });
  log(`  render queue: ${queue.queued} new job${queue.queued === 1 ? "" : "s"}`);
  const index = new Map();
  for (const card of cards.items) {
    for (const edition of card.editions) {
      for (const variant of edition.variants) index.set(variant.id, { card, edition, variant });
    }
  }
  let rendered = 0;
  let failed = 0;
  while (true) {
    const jobs = await apiJson("/api/v1/admin/jobs?status=pending");
    const job = jobs.items?.[0];
    if (!job) break;
    const claimed = await apiJson(`/api/v1/admin/jobs/${job.id}/claim`, { method: "POST", body: {} });
    if (!claimed.job) break;
    const payload = claimed.job.payload;
    const entry = index.get(payload.variant_id);
    if (!entry) {
      await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, { method: "POST", body: { message: "Variant is no longer in the catalogue." } });
      failed += 1;
      continue;
    }
    try {
      const subject = await fetch(`${BASE_URL}/api/v1/admin/assets/${payload.subject_asset_id}/bytes`, {
        headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
      });
      if (!subject.ok) throw new Error(`Subject asset fetch failed (${subject.status}).`);
      const background = payload.background_asset_id
        ? await fetch(`${BASE_URL}/api/v1/admin/assets/${payload.background_asset_id}/bytes`, {
            headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
          })
        : null;
      if (background && !background.ok) throw new Error(`Background asset fetch failed (${background.status}).`);
      const subjectPath = path.join(tmpDir, `${payload.variant_id}-subject.png`);
      const backgroundPath = path.join(tmpDir, `${payload.variant_id}-background.png`);
      fs.writeFileSync(subjectPath, Buffer.from(await subject.arrayBuffer()));
      if (background) fs.writeFileSync(backgroundPath, Buffer.from(await background.arrayBuffer()));
      const outputPath = path.join(tmpDir, `${payload.variant_id}.webp`);
      await composeCard({
        subjectPath,
        backgroundPath,
        material: payload.material_key,
        effect: payload.effect_key ?? "none",
        name: entry.card.name,
        subtitle: entry.card.subtitle ?? "",
        setName: entry.card.sets[0]?.name ?? entry.card.collections[0]?.name ?? "Cabinet",
        serial: "CABINET PROOF",
        className: entry.card.class?.name ?? "",
        rarity: entry.card.rarity?.name ?? "",
        outputPath,
      });
      const backSource = generated.get(entry.card.slug)?.back;
      let backBytes;
      if (backSource && fs.existsSync(backSource)) {
        const backPath = path.join(tmpDir, `${payload.variant_id}-back.webp`);
        await composeCardBack({
          backPath: backSource,
          material: payload.material_key,
          effect: payload.effect_key ?? "none",
          outputPath: backPath,
        });
        backBytes = fs.readFileSync(backPath);
        fs.rmSync(backPath, { force: true });
      }
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(outputPath)], { type: "image/webp" }), `${payload.variant_id}.webp`);
      if (backBytes) form.append("back", new Blob([backBytes], { type: "image/webp" }), `${payload.variant_id}-back.webp`);
      const completed = await apiForm(`/api/v1/admin/jobs/${job.id}/complete`, form);
      if (makeDerivatives && completed?.assetId) {
        const thumb = await sharp(outputPath).resize(300, 420, { fit: "cover", position: "attention" }).webp({ quality: 82, effort: 5 }).toBuffer();
        const derivativeForm = new FormData();
        derivativeForm.append("file", new Blob([thumb], { type: "image/webp" }), `${payload.variant_id}-thumb.webp`);
        derivativeForm.append("sizeKey", "thumb");
        await apiForm(`/api/v1/admin/assets/${completed.assetId}/derivatives`, derivativeForm).catch(() => undefined);
        const preview = await sharp(outputPath).resize(600, 840, { fit: "cover", position: "attention" }).webp({ quality: 84, effort: 5 }).toBuffer();
        const previewForm = new FormData();
        previewForm.append("file", new Blob([preview], { type: "image/webp" }), `${payload.variant_id}-preview.webp`);
        previewForm.append("sizeKey", "preview");
        await apiForm(`/api/v1/admin/assets/${completed.assetId}/derivatives`, previewForm).catch(() => undefined);
      }
      rendered += 1;
      if (rendered % 20 === 0) log(`  rendered ${rendered}…`);
      fs.rmSync(subjectPath, { force: true });
      fs.rmSync(backgroundPath, { force: true });
      fs.rmSync(outputPath, { force: true });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await apiJson(`/api/v1/admin/jobs/${job.id}/fail`, { method: "POST", body: { message } }).catch(() => undefined);
      log(`  failed ${entry.card.name} — ${entry.variant.name}: ${message}`);
    }
  }
  return { rendered, failed };
}

function finishKey(material, effect) {
  if (effect === "holographic" || material === "diamond") return "holographic";
  if (material === "gold") return "gold";
  if (material === "silver") return "silver";
  return "plain";
}

const FINISH_WEIGHTS = { plain: 45, silver: 30, gold: 18, holographic: 7 };

async function rebuildPools(manifests) {
  const cards = await apiJson("/api/v1/admin/cards?limit=2000");
  const collections = await apiJson("/api/v1/admin/collections");
  const allEntries = [];
  for (const { manifest } of manifests) {
    const collection = collections.items.find((item) => item.slug === manifest.collection.slug);
    if (!collection) continue;
    const cardIds = new Set(manifest.cards.map((card) => card.slug));
    const entries = [];
    for (const card of cards.items) {
      if (!cardIds.has(card.slug)) continue;
      for (const edition of card.editions) {
        for (const variant of edition.variants) {
          if (variant.status !== "published" || !variant.render_url) continue;
          const key = finishKey(variant.material_key, variant.effect_key);
          entries.push({ variantId: variant.id, weight: FINISH_WEIGHTS[key] ?? 1 });
        }
      }
    }
    if (!entries.length) continue;
    allEntries.push(...entries);
    const slug = `${manifest.collection.slug}-capsule`;
    const pools = await apiJson("/api/v1/admin/pools");
    const existing = pools.items.find((pool) => pool.slug === slug);
    const poolBody = {
      name: `${manifest.collection.name} capsule`,
      description: `Open a single card from ${manifest.collection.name}. Every finish is shown with its live probability.`,
      price: 80,
      entries: entries.slice(0, 300),
    };
    if (existing) {
      const updated = await apiJson(`/api/v1/admin/pools/${existing.id}`, { method: "PATCH", body: { expectedRevision: existing.revision, ...poolBody } });
      await apiJson(`/api/v1/admin/pools/${updated.pool.id}/publish`, { method: "POST", body: {} });
    } else {
      const created = await apiJson("/api/v1/admin/pools", { method: "POST", body: { slug, ...poolBody } });
      await apiJson(`/api/v1/admin/pools/${created.pool.id}/publish`, { method: "POST", body: {} });
    }
  }
  // A mixed cabinet pool capped at 300 entries. Collection capsules carry the
  // full catalogue; the mixed pool remains the quick everyday open.
  if (allEntries.length) {
    const pools = await apiJson("/api/v1/admin/pools");
    const existing = pools.items.find((pool) => pool.slug === "cabinet-draw");
    const entries = allEntries.slice(0, 300);
    const body = {
      name: "Cabinet Draw",
      description: "A mixed capsule across the member album. Exact odds are shown before you open.",
      price: 80,
      entries,
    };
    if (existing) {
      const updated = await apiJson(`/api/v1/admin/pools/${existing.id}`, { method: "PATCH", body: { expectedRevision: existing.revision, ...body } });
      await apiJson(`/api/v1/admin/pools/${updated.pool.id}/publish`, { method: "POST", body: {} });
    } else {
      const created = await apiJson("/api/v1/admin/pools", { method: "POST", body: { slug: "cabinet-draw", ...body } });
      await apiJson(`/api/v1/admin/pools/${created.pool.id}/publish`, { method: "POST", body: {} });
    }
  }
  return { collections: manifests.length, entries: allEntries.length };
}

async function main() {
  const manifests = loadManifests();
  log(`Loaded ${manifests.length} manifest${manifests.length === 1 ? "" : "s"}.`);
  if (dryRun) {
    for (const { manifest } of manifests) {
      log(`  ${manifest.collection.slug}: ${manifest.cards.length} cards, ${manifest.achievements?.length ?? 0} achievements`);
    }
  }
  if (!dryRun && !process.env.FOILBURY_URL) await ensureServer();

  const summary = { collections: [], rendered: 0, failed: 0 };
  const generatedByCollection = new Map();
  for (const { file, manifest } of manifests) {
    log(`\n${manifest.collection.name} (${manifest.collection.slug})`);
    const outDir = path.join(artDir, manifest.collection.slug);
    fs.mkdirSync(outDir, { recursive: true });
    const generated = await generateCollectionArt({ collection: manifest.collection, cards: manifest.cards, outputDir: outDir });
    const generatedCards = new Map(generated.cards.map((entry) => [entry.card.slug, entry]));
    generatedByCollection.set(manifest.collection.slug, generatedCards);
    if (dryRun) {
      summary.collections.push({ slug: manifest.collection.slug, cards: manifest.cards.length, art: "generated" });
      continue;
    }

    const audience = manifest.collection.view_audience ?? "members";
    const access = audience === "public" ? "public" : "member";
    const mark = await upload(generated.mark, {
      kind: "brand",
      name: `${manifest.collection.name} mark`,
      role: "logo",
      access,
      reviewStatus: "approved",
      provenance: "Original Foilbury mark. Not an official logo.",
      sourceRepo: manifest.source_repo,
      sourceCommit: manifest.source_commit,
      sourceLogicalId: `${manifest.collection.slug}:mark`,
      credit: "Original Foilbury interpretation.",
    });
    const cover = await upload(generated.cover, {
      kind: "brand",
      name: `${manifest.collection.name} cover`,
      role: "cover",
      access,
      reviewStatus: "approved",
      provenance: "Original Foilbury cover. Not official artwork.",
      sourceRepo: manifest.source_repo,
      sourceCommit: manifest.source_commit,
      sourceLogicalId: `${manifest.collection.slug}:cover`,
      credit: "Original Foilbury interpretation.",
    });
    const firstBack = generated.cards[0]?.back;
    const back = firstBack
      ? await upload(firstBack, {
          kind: "brand",
          name: `${manifest.collection.name} card back`,
          role: "card_back",
          access,
          reviewStatus: "approved",
          provenance: "Original Foilbury card back.",
          sourceRepo: manifest.source_repo,
          sourceCommit: manifest.source_commit,
          sourceLogicalId: `${manifest.collection.slug}:back`,
          credit: "Original Foilbury interpretation.",
        })
      : null;

    const collection = await ensureCollection(manifest, `/media/asset/${mark.id}`, `/media/asset/${cover.id}`, back ? `/media/asset/${back.id}` : null);
    await apiJson(`/api/v1/admin/collections/${collection.id}/enable`, { method: "POST", body: { enabled: true } });
    log(`  collection ${collection.id} · enabled for this Bot`);
    await ensureCategories(manifest);

    const assets = new Map();
    for (const entry of generated.cards) {
      const subject = await upload(entry.subject, {
        kind: "subject",
        name: `${entry.card.name} subject layer`,
        role: "subject",
        access: "private",
        reviewStatus: entry.card.review_status ?? "draft",
        provenance: "Original Foilbury interpretation created from a deterministic brief. Not official character art or a licensed likeness.",
        sourceRepo: manifest.source_repo,
        sourceCommit: manifest.source_commit,
        sourcePath: `content/${manifest.collection.slug}/${entry.card.slug}.json`,
        sourceLogicalId: `${manifest.collection.slug}:${entry.card.slug}:subject`,
        credit: entry.card.credit ?? "Original Foilbury interpretation.",
      });
      const background = await upload(entry.background, {
        kind: "background",
        name: `${entry.card.name} background layer`,
        role: "background",
        access: "private",
        reviewStatus: "approved",
        provenance: "Original deterministic Foilbury texture.",
        sourceRepo: manifest.source_repo,
        sourceCommit: manifest.source_commit,
        sourceLogicalId: `${manifest.collection.slug}:${entry.card.slug}:background`,
        credit: "Original Foilbury interpretation.",
      });
      assets.set(entry.card.slug, { subject, background });
    }

    const { preview, committed } = await importCards(manifest, assets);
    log(`  import preview: ${preview.counts.new} new, ${preview.counts.unchanged} unchanged, ${preview.counts.revision} revision`);
    if (committed) log(`  import: ${committed.summary.imported} new, ${committed.summary.revised} revised, ${committed.summary.failed} failed`);
    const achievements = await createAchievements(manifest, collection);
    summary.collections.push({
      slug: manifest.collection.slug,
      id: collection.id,
      cards: manifest.cards.length,
      achievements: achievements.length,
      import: committed?.summary ?? preview.counts,
    });
  }

  if (!dryRun && !skipRender) {
    log("\nRendering card fronts and backs…");
    const cards = await apiJson("/api/v1/admin/cards?limit=2000");
    const allGenerated = new Map();
    for (const [, map] of generatedByCollection) for (const [slug, entry] of map) allGenerated.set(slug, entry);
    const result = await renderQueue(cards, allGenerated);
    summary.rendered = result.rendered;
    summary.failed = result.failed;
    log(`  rendered ${result.rendered}; failed ${result.failed}`);
  }

  if (!dryRun) {
    const pools = await rebuildPools(manifests);
    summary.pools = pools;
    log(`\nPools: ${pools.collections} collection capsules, ${pools.entries} eligible entries.`);
    if (!skipRender) {
      const release = await apiJson("/api/v1/admin/catalogue/publish", { method: "POST", body: {} });
      summary.release = release;
      log(`Published catalogue release v${release.version}.`);
    } else {
      log("Skipped catalogue release because renders were skipped.");
    }
  }

  if (jsonOut) console.log(JSON.stringify(summary, null, 2));
  else log("\nDone.");
}

main().catch((error) => {
  console.error(`\nProvisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
