#!/usr/bin/env node
/**
 * Bounded two-card production import for Gonta Gokuhara and Kamui Gakupo.
 *
 * Uses the real admin asset/import/pool services through an authenticated
 * Cloudflare Access browser session, queues only the eight new render jobs,
 * and verifies the resulting cards, variants, renders and pool eligibility.
 * It never runs the broad content provisioner and never rewrites the existing
 * rosters, achievements or issued copies.
 *
 *   node scripts/content/incremental-import.mjs --cookies FILE --backup FILE
 *   node scripts/content/incremental-import.mjs --cookies FILE --backup FILE --apply
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";
import { composeCardBack } from "../../art/compose.mjs";
import { renderQueuedFront } from "./render-queued-front.mjs";
import { readLocalRenderSource } from "./render-bytes.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};
const cookiesPath = valueOf("--cookies");
const backupPath = valueOf("--backup");
if (!cookiesPath) throw new Error("Pass --cookies=<playwright storage-state json>.");
if (apply && !backupPath) throw new Error("A D1 JSON backup is required before --apply.");
const BASE = "https://foilbury.loftwah.com";
const manifestDir = path.join(ROOT, ".foilbury", "content");
const generatedDir = path.join(ROOT, ".foilbury", "generated");
const evidenceDir = path.join(ROOT, ".foilbury", "evidence");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceJson = path.join(evidenceDir, `incremental-import-${stamp}.json`);
const rollbackFile = path.join(evidenceDir, `incremental-import-rollback-${stamp}.sql`);
const renderDir = path.join(evidenceDir, `incremental-import-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(renderDir, { recursive: true });

const subjects = [
  {
    manifest: "danganronpa.json",
    collection: "danganronpa-three-games",
    slug: "gonta-gokuhara",
    logicalId: "danganronpa:gonta-gokuhara",
    aliases: ["Gonta"],
    weightFoil: 0,
  },
  {
    manifest: "vocaloid.json",
    collection: "vocaloid",
    slug: "kamui-gakupo",
    logicalId: "vocaloid:kamui-gakupo",
    aliases: ["Camui Gackpo", "Gackpoid", "神威がくぽ"],
  },
];

const state = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
const cookieJar = state.cookies.filter((cookie) => cookie.domain.includes("foilbury"));
const cookie = cookieJar.map((entry) => `${entry.name}=${entry.value}`).join("; ");
const csrf = cookieJar.find((entry) => entry.name === "fb_csrf")?.value ?? "";
if (!cookie || !csrf) throw new Error("The storage state has no Foilbury session/CSRF cookie.");
const agentFile = path.join(ROOT, ".foilbury", "production-agent.json");
const agent = fs.existsSync(agentFile) ? JSON.parse(fs.readFileSync(agentFile, "utf8")) : null;

const headers = {
  cookie,
  "x-foilbury-csrf": csrf,
  accept: "application/json",
  ...(agent?.token ? { authorization: `Bearer ${agent.token}` } : {}),
};

async function raw(route, options = {}) {
  const response = await fetch(`${BASE}${route}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

async function api(route, { method = "GET", body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const { response, buffer } = await raw(route, init);
  const text = buffer.toString("utf8");
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `${method} ${route} -> ${response.status}: ${payload?.error?.message ?? text.slice(0, 500)}`,
    );
  }
  return payload;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function d1(sql) {
  const result = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--remote",
      "--config",
      "wrangler.production.jsonc",
      "--json",
      "--command",
      sql,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(result.slice(result.indexOf("[")));
  return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
}

function loadManifest(name) {
  return JSON.parse(fs.readFileSync(path.join(manifestDir, name), "utf8"));
}

function cardFor(subject) {
  const manifest = loadManifest(subject.manifest);
  const card = manifest.cards.find((item) => item.slug === subject.slug);
  if (!card) throw new Error(`${subject.manifest}: ${subject.slug} is missing.`);
  if (card.logical_id !== subject.logicalId)
    throw new Error(`${subject.slug}: logical id mismatch (${card.logical_id}).`);
  return { manifest, card, sourceHash: sha256(JSON.stringify(card)) };
}

const loaded = subjects.map((subject) => ({ subject, ...cardFor(subject) }));

const existingCards = (await api("/api/v1/admin/cards?limit=2000")).items ?? [];
const adminStatus = await api("/api/v1/admin/status");
const proofTenant = adminStatus.tenant?.id;
if (!proofTenant) throw new Error("Could not read the production tenant id.");
const existingForSubject = loaded.map(({ subject }) =>
  existingCards.find(
    (card) =>
      card.slug === subject.slug ||
      card.logical_id === subject.logicalId ||
      card.source_logical_id === subject.logicalId,
  ),
);
const already = loaded.filter((_, index) => Boolean(existingForSubject[index]));
const fullyDone =
  already.length === loaded.length &&
  existingForSubject.every((card) => {
    const edition = card?.editions?.[0];
    return (
      edition?.variants?.length === 4 &&
      edition.variants.every((variant) => variant.render_status === "published")
    );
  });
if (fullyDone) {
  const collectionsNow = (await api("/api/v1/admin/collections")).items ?? [];
  const releaseReady = ["danganronpa-three-games", "vocaloid"].every(
    (slug) => collectionsNow.find((item) => item.slug === slug)?.release_version === 6,
  );
  if (releaseReady) {
    console.log(JSON.stringify({ status: "already_complete", cards: already.map((item) => item.subject.slug) }, null, 2));
    process.exit(0);
  }
}
if (already.length && already.length !== loaded.length) {
  throw new Error(`Partial identity conflict: ${already.map((item) => item.subject.slug).join(", ")} already exists.`);
}

const collections = (await api("/api/v1/admin/collections")).items ?? [];
const pools = (await api("/api/v1/admin/pools")).items ?? [];
const plan = {
  generated_at: new Date().toISOString(),
  environment: "production",
  mode: apply ? "apply" : "dry-run",
  backup: backupPath ?? null,
  subjects: loaded.map(({ subject, manifest, card, sourceHash }) => {
    const collection = collections.find((item) => item.slug === manifest.collection.slug);
    const pool = pools.find((item) => item.slug === `${manifest.collection.slug}-capsule`);
    return {
      subject: card.name,
      slug: card.slug,
      logical_id: card.logical_id,
      source_hash: sourceHash,
      collection: collection
        ? {
            id: collection.id,
            slug: collection.slug,
            release_version: collection.release_version,
            proposed_release: collection.release_version + 1,
            status: collection.status,
            view_audience: collection.view_audience,
          }
        : null,
      pool: pool ? { id: pool.id, slug: pool.slug, revision: pool.revision, price: pool.price, status: pool.status } : null,
      asset_files: {
        subject: path.join(generatedDir, manifest.collection.slug, `${card.slug}-subject.png`),
        background: path.join(generatedDir, manifest.collection.slug, `${card.slug}-background.png`),
        back: path.join(generatedDir, manifest.collection.slug, `${card.slug}-back.png`),
      },
      variants: [
        { material: "plain", effect: "none" },
        { material: "silver", effect: "none" },
        { material: "gold", effect: "none" },
        { material: "gold", effect: "holographic" },
      ],
    };
  }),
};

if (!apply) {
  fs.writeFileSync(evidenceJson, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
  console.log("Dry run only. Re-run with --apply and a verified backup.");
  process.exit(0);
}

if (!backupPath || !fs.existsSync(backupPath)) throw new Error("The D1 backup file was not found.");
if (!fs.existsSync(`${backupPath}.sha256`)) throw new Error("The D1 backup checksum file was not found.");

const assetCache = new Map();
async function findAsset(sha, kind, logicalId) {
  const key = `${kind}:${sha}`;
  if (assetCache.has(key)) return assetCache.get(key);
  const list = (await api(`/api/v1/admin/assets?kind=${encodeURIComponent(kind)}`)).items ?? [];
  const match = list.find(
    (asset) =>
      asset.sha256 === sha &&
      asset.kind === kind &&
      (asset.source_logical_id === logicalId || asset.sourceLogicalId === logicalId),
  );
  if (match) assetCache.set(key, match);
  return match ?? null;
}

async function uploadAsset(file, fields) {
  const bytes = fs.readFileSync(file);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), path.basename(file));
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  return (await api("/api/v1/admin/assets", { method: "POST", form })).asset;
}

async function ensureAsset(file, fields, logicalId) {
  const sha = sha256(fs.readFileSync(file));
  const found = await findAsset(sha, fields.kind, logicalId);
  if (found) return { asset: found, uploaded: false };
  const asset = await uploadAsset(file, fields);
  return { asset, uploaded: true };
}

const imported = [];
for (const { subject, manifest, card, sourceHash } of loaded) {
  const collection = collections.find((item) => item.slug === manifest.collection.slug);
  if (!collection) throw new Error(`Missing production collection ${manifest.collection.slug}.`);
  const subjectFile = path.join(generatedDir, manifest.collection.slug, `${card.slug}-subject.png`);
  const backgroundFile = path.join(generatedDir, manifest.collection.slug, `${card.slug}-background.png`);
  const backFile = path.join(generatedDir, manifest.collection.slug, `${card.slug}-back.png`);
  for (const file of [subjectFile, backgroundFile, backFile]) {
    if (!fs.existsSync(file)) throw new Error(`Missing local render input ${file}.`);
  }
  const existing = existingCards.find(
    (item) => item.logical_id === card.logical_id || item.slug === card.slug,
  );
  if (existing) {
    const edition = existing.editions?.[0];
    if (!edition || !edition.subject_asset_id || !edition.background_asset_id) {
      throw new Error(`Existing card ${card.slug} has no complete artwork edition.`);
    }
    imported.push({
      subject: subject.slug,
      collection: manifest.collection.slug,
      collectionId: collection.id,
      cardId: existing.id,
      editionId: edition.id,
      subjectAssetId: edition.subject_asset_id,
      backgroundAssetId: edition.background_asset_id,
      subjectUploaded: false,
      backgroundUploaded: false,
      sourceHash,
      backFile,
      preview: null,
      resumed: true,
    });
    continue;
  }
  const subjectAsset = await ensureAsset(
    subjectFile,
    {
      kind: "subject",
      name: `${card.name} subject layer`,
      sourceRepo: manifest.source_repo,
      sourcePath: `content/${manifest.collection.slug}/${card.slug}.json`,
      sourceCommit: manifest.source_commit,
      sourceLogicalId: card.logical_id,
      credit: card.credit,
    },
    card.logical_id,
  );
  const backgroundAsset = await ensureAsset(
    backgroundFile,
    {
      kind: "background",
      name: `${card.name} background layer`,
      sourceRepo: manifest.source_repo,
      sourcePath: `content/${manifest.collection.slug}/${card.slug}.json`,
      sourceCommit: manifest.source_commit,
      sourceLogicalId: card.logical_id,
      credit: card.credit,
    },
    card.logical_id,
  );

  const item = {
    source: manifest.source,
    sourceRepo: manifest.source_repo,
    sourceCommit: manifest.source_commit,
    sourcePath: `content/${manifest.collection.slug}/${card.slug}.json`,
    sourceHash,
    logicalId: card.logical_id,
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
    credit: card.credit,
    subjectAssetId: subjectAsset.asset.id,
    backgroundAssetId: backgroundAsset.asset.id,
    variants: [
      { material: "plain", effect: "none" },
      { material: "silver", effect: "none" },
      { material: "gold", effect: "none" },
      { material: "gold", effect: "holographic" },
    ],
    sets: [],
  };
  const body = {
    source: manifest.source,
    sourceRepo: manifest.source_repo,
    sourceCommit: manifest.source_commit,
    publish: true,
    items: [item],
  };
  const preview = await api("/api/v1/admin/imports/preview", { method: "POST", body });
  if (preview.counts?.new !== 1 || preview.counts?.unchanged || preview.counts?.revision) {
    throw new Error(`Unexpected preview for ${card.slug}: ${JSON.stringify(preview.counts)}`);
  }
  const result = await api("/api/v1/admin/imports", { method: "POST", body });
  const row = result.results?.find((entry) => entry.logicalId === card.logical_id);
  if (!row || row.status !== "new") throw new Error(`Import failed for ${card.slug}: ${JSON.stringify(result)}`);
  imported.push({
    subject: subject.slug,
    collection: manifest.collection.slug,
    collectionId: collection.id,
    cardId: row.cardId,
    editionId: row.editionId,
    subjectAssetId: subjectAsset.asset.id,
    backgroundAssetId: backgroundAsset.asset.id,
    subjectUploaded: subjectAsset.uploaded,
    backgroundUploaded: backgroundAsset.uploaded,
    sourceHash,
    backFile,
    preview,
  });
}

const afterCards = (await api("/api/v1/admin/cards?limit=2000")).items ?? [];
const newCards = imported.map((entry) => {
  const card = afterCards.find((item) => item.id === entry.cardId);
  if (!card) throw new Error(`Imported card ${entry.cardId} was not readable.`);
  const edition = card.editions?.[0];
  if (!edition) throw new Error(`Imported card ${entry.cardId} has no edition.`);
  const variants = edition.variants ?? [];
  if (variants.length !== 4) throw new Error(`Imported card ${entry.cardId} has ${variants.length} variants.`);
  return { ...entry, card, edition, variants };
});

const newVariantIds = newCards.flatMap((entry) => entry.variants.map((variant) => variant.id));
const now = new Date().toISOString();
const jobRows = newCards.flatMap((entry) =>
  entry.variants.map((variant) => {
    const payload = {
      variant_id: variant.id,
      card_id: entry.cardId,
      edition_id: entry.editionId,
      recipe_id: entry.edition.recipe_id,
      subject_asset_id: entry.edition.subject_asset_id,
      background_asset_id: entry.edition.background_asset_id,
      card_name: entry.card.name,
      card_slug: entry.card.slug,
      card_subtitle: entry.card.subtitle,
      variant_name: variant.name,
      material_key: variant.material_key,
      effect_key: variant.effect_key,
      composition_json: entry.edition.composition_json ?? null,
    };
    return `(${quote(`job_imp_${variant.id}`)}, ${quote(entry.card.tenant_id)}, 'render_card', 'pending', ${quote(JSON.stringify(payload))}, 0, 3, ${quote(now)}, ${quote(now)}, ${quote(now)})`;
  }),
);
if (jobRows.length !== 8) throw new Error(`Expected eight render jobs, got ${jobRows.length}.`);
d1(
  `INSERT OR IGNORE INTO fb_jobs (id, tenant_id, kind, status, payload_json, attempts, max_attempts, available_at, created_at, updated_at) VALUES ${jobRows.join(",")};`,
);

async function processJobs() {
  let jobs = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pending = (await api("/api/v1/admin/jobs?status=pending")).items ?? [];
    jobs = pending.filter((job) => {
      const payload = job.payload ?? JSON.parse(job.payload_json ?? "{}");
      return newVariantIds.includes(payload.variant_id);
    });
    if (jobs.length === 8) break;
    if (jobs.length === 0) {
      const current = (await api("/api/v1/admin/cards?limit=2000")).items ?? [];
      const ready = newVariantIds.every((id) =>
        current.some((card) =>
          (card.editions ?? []).some((edition) =>
            (edition.variants ?? []).some(
              (variant) => variant.id === id && variant.render_status === "published",
            ),
          ),
        ),
      );
      if (ready) return [];
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (jobs.length !== 8) throw new Error(`Expected eight pending new render jobs, found ${jobs.length}.`);
  const completed = [];
  for (const job of jobs) {
    const claimed = await api(`/api/v1/admin/jobs/${job.id}/claim`, { method: "POST", body: {} });
    if (!claimed.job) throw new Error(`Could not claim ${job.id}.`);
    const payload = claimed.job.payload;
    const entry = newCards.find((item) => item.cardId === payload.card_id);
    if (!entry) throw new Error(`No card for job ${job.id}.`);
    const subjectBytes = (await raw(`/api/v1/admin/assets/${payload.subject_asset_id}/bytes`)).buffer;
    const backgroundBytes = (await raw(`/api/v1/admin/assets/${payload.background_asset_id}/bytes`)).buffer;
    let markBuffer;
    let markMime;
    const logo = entry.card.collections?.[0]?.logo_url;
    if (logo) {
      try {
        const mark = await raw(logo);
        markBuffer = mark.buffer;
        markMime = mark.response.headers.get("content-type") ?? "image/png";
      } catch {
        markBuffer = undefined;
      }
    }
    const { buffer: frontBytes } = await renderQueuedFront({
      payload,
      meta: entry.card,
      subjectPath: subjectBytes,
      backgroundPath: backgroundBytes,
      markBuffer,
      markMime,
      returnBytes: true,
    });
    const backBytes = await composeCardBack({
      backPath: readLocalRenderSource(entry.backFile),
      material: payload.material_key,
      effect: payload.effect_key ?? "none",
      returnBytes: true,
    });
    const form = new FormData();
    form.append("file", new Blob([frontBytes], { type: "image/webp" }), `${payload.variant_id}.webp`);
    form.append("back", new Blob([backBytes], { type: "image/webp" }), `${payload.variant_id}-back.webp`);
    form.append("attempt", String(claimed.job.attempts));
    const result = await api(`/api/v1/admin/jobs/${job.id}/complete`, { method: "POST", form });
    completed.push({ jobId: job.id, variantId: payload.variant_id, result });
  }
  return completed;
}

const completedJobs = await processJobs();

const refreshedCards = (await api("/api/v1/admin/cards?limit=2000")).items ?? [];
for (const entry of newCards) {
  const card = refreshedCards.find((item) => item.id === entry.cardId);
  const rendered = card?.editions?.[0]?.variants ?? [];
  if (rendered.length !== 4 || rendered.some((variant) => variant.render_status !== "published")) {
    throw new Error(`Renders did not publish for ${entry.card.name}: ${JSON.stringify(rendered.map((v) => v.render_status))}`);
  }
}

const weights = { plain: 45, silver: 30, gold: 18, holographic: 7 };
const poolUpdates = [];
for (const entry of newCards) {
  const collection = collections.find((item) => item.slug === entry.collection);
  const pool = pools.find((item) => item.slug === `${entry.collection}-capsule`);
  if (!collection || !pool) throw new Error(`Missing pool/collection for ${entry.collection}.`);
  const detail = await api(`/api/v1/admin/pools/${pool.id}`);
  const entries = (detail.entries ?? []).map((row) => ({ variantId: row.variant_id, weight: row.weight }));
  const missing = entry.variants.filter((variant) => !entries.some((row) => row.variantId === variant.id));
  if (!missing.length) {
    poolUpdates.push({
      slug: pool.slug,
      id: pool.id,
      skipped: true,
      revision: detail.pool?.revision ?? pool.revision,
      entries: entries.length,
    });
    continue;
  }
  for (const variant of missing) {
    entries.push({
      variantId: variant.id,
      weight:
        weights[
          variant.effect_key === "holographic" ? "holographic" : variant.material_key
        ] ?? 1,
    });
  }
  const currentRevision = detail.pool?.revision ?? pool.revision;
  const updated = await api(`/api/v1/admin/pools/${pool.id}`, {
    method: "PATCH",
    body: { expectedRevision: currentRevision, entries },
  });
  await api(`/api/v1/admin/pools/${pool.id}/publish`, { method: "POST", body: {} });
  poolUpdates.push({
    slug: pool.slug,
    id: pool.id,
    previous_revision: currentRevision,
    next_revision: updated.pool?.revision ?? currentRevision + 1,
    entries: entries.length,
  });
}

const aliases = newCards.flatMap((entry) => {
  const subject = subjects.find((item) => item.slug === entry.subject);
  return (subject?.aliases ?? []).map((alias) => ({
    cardId: entry.cardId,
    alias,
    normalized: alias.toLowerCase(),
  }));
});
const releaseSql = [
  `UPDATE fb_collections SET release_version = 6, updated_at = ${quote(now)} WHERE slug IN ('danganronpa-three-games','vocaloid') AND release_version = 5;`,
  ...aliases.map(
    (alias) =>
      `INSERT OR IGNORE INTO fb_card_name_aliases (tenant_id, card_id, alias, normalized, created_at) VALUES (${quote(proofTenant)}, ${quote(alias.cardId)}, ${quote(alias.alias)}, ${quote(alias.normalized)}, ${quote(now)});`,
  ),
  ...newCards.map(
    (entry) =>
      `INSERT OR IGNORE INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at) VALUES (${quote(`aud_imp_${entry.cardId}`)}, ${quote(proofTenant)}, 'system', 'trusted-incremental-import', 'usr_prod_owner', 'content.incremental_import', 'collection', ${quote(entry.collectionId)}, ${quote(JSON.stringify({ card_id: entry.cardId, subject: entry.subject, backup: backupPath, source_hash: entry.sourceHash }))}, 'incremental-import', ${quote(now)});`,
  ),
];
d1(releaseSql.join("\n"));

const finalCards = (await api("/api/v1/admin/cards?limit=2000")).items ?? [];
const created = finalCards.filter((card) => newCards.some((entry) => entry.cardId === card.id));
if (created.length !== 2) throw new Error(`Expected two new cards, found ${created.length}.`);
const counts = d1(
  `SELECT
     (SELECT COUNT(*) FROM fb_card_definitions WHERE tenant_id = ${quote(proofTenant)}) AS cards,
     (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id = ${quote(proofTenant)}) AS instances,
     (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = ${quote(proofTenant)}) AS ledger,
     (SELECT COUNT(*) FROM fb_assets WHERE tenant_id = ${quote(proofTenant)}) AS assets,
     (SELECT COUNT(*) FROM fb_variant_renders vr JOIN fb_variants v ON v.id = vr.variant_id JOIN fb_card_definitions cd ON cd.id = v.card_id WHERE cd.slug IN ('gonta-gokuhara','kamui-gakupo') AND vr.status = 'published') AS new_fronts,
     (SELECT COUNT(*) FROM fb_variant_back_renders vr JOIN fb_variants v ON v.id = vr.variant_id JOIN fb_card_definitions cd ON cd.id = v.card_id WHERE cd.slug IN ('gonta-gokuhara','kamui-gakupo') AND vr.status = 'published') AS new_backs,
     (SELECT COUNT(*) FROM fb_collection_cards cc JOIN fb_card_definitions cd ON cd.id = cc.card_id WHERE cd.slug IN ('gonta-gokuhara','kamui-gakupo')) AS new_links,
     (SELECT COUNT(*) FROM fb_card_name_aliases a JOIN fb_card_definitions cd ON cd.id = a.card_id WHERE cd.slug IN ('gonta-gokuhara','kamui-gakupo')) AS new_aliases`)[0];
if (Number(counts.new_fronts) !== 8 || Number(counts.new_backs) !== 8) {
  throw new Error(`Render proof count mismatch: ${JSON.stringify(counts)}`);
}
if (Number(counts.new_links) !== 2 || Number(counts.new_aliases) < 4) {
  throw new Error(`Relationship count mismatch: ${JSON.stringify(counts)}`);
}

const proof = [];
for (const entry of created) {
  const edition = entry.editions?.[0];
  for (const variant of edition?.variants ?? []) {
    const front = (await raw(variant.render_url)).buffer;
    const back = (await raw(variant.back_render_url)).buffer;
    const frontMeta = await sharp(front).metadata();
    const backMeta = await sharp(back).metadata();
    const label = `${entry.name} · ${variant.name}`.replace(/[^\w ·.-]/g, "");
    const frontFile = path.join(renderDir, `${entry.slug}-${variant.material_key}-${variant.effect_key}-front.png`);
    const backFile = path.join(renderDir, `${entry.slug}-${variant.material_key}-${variant.effect_key}-back.png`);
    await sharp(front).png().toFile(frontFile);
    await sharp(back).png().toFile(backFile);
    proof.push({
      card: entry.name,
      variant: variant.name,
      front: { file: frontFile, width: frontMeta.width, height: frontMeta.height, bytes: front.length },
      back: { file: backFile, width: backMeta.width, height: backMeta.height, bytes: back.length },
      label,
    });
  }
}
if (proof.some((item) => item.front.width !== 750 || item.front.height !== 1050 || item.back.width !== 750 || item.back.height !== 1050)) {
  throw new Error("A proof render is not 750x1050.");
}

const grid = [];
const cellW = 300;
const cellH = 420;
const gap = 14;
const margin = 24;
const labelH = 42;
const columns = 4;
const rows = Math.ceil(proof.length / columns);
const width = margin * 2 + columns * cellW + (columns - 1) * gap;
const height = margin * 2 + 70 + rows * (cellH + labelH + gap);
for (let index = 0; index < proof.length; index += 1) {
  const left = margin + (index % columns) * (cellW + gap);
  const top = margin + 70 + Math.floor(index / columns) * (cellH + labelH + gap);
  grid.push({ input: await sharp(proof[index].front.file).resize(cellW, cellH, { fit: "contain", background: "#11141b" }).png().toBuffer(), left, top });
  grid.push({
    input: Buffer.from(
      `<svg width="${cellW}" height="${labelH}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="24" fill="#e9edf7" font-family="sans-serif" font-size="14" font-weight="700">${proof[index].label.slice(0, 34)}</text><text x="0" y="40" fill="#aab4c8" font-family="sans-serif" font-size="12">750x1050 front</text></svg>`,
    ),
    left,
    top: top + cellH,
  });
}
const title = Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="${margin}" y="${margin + 30}" fill="#f4f6fc" font-family="sans-serif" font-size="28" font-weight="700">Gonta and Gakupo · production render proof</text><text x="${margin}" y="${margin + 54}" fill="#aab4c8" font-family="sans-serif" font-size="15">Eight new 750x1050 fronts and independent backs</text></svg>`,
);
const contactSheet = path.join(renderDir, "contact-sheet.png");
await sharp({ create: { width, height, channels: 4, background: "#11141b" } })
  .composite([...grid, { input: title, left: 0, top: 0 }])
  .png()
  .toFile(contactSheet);

const rollback = [
  `-- Rollback for the bounded Gonta/Gakupo production import. Review before running.`,
  `-- Pre-import D1 JSON backup: ${backupPath}`,
  `DELETE FROM fb_jobs WHERE id LIKE 'job_imp_%';`,
  `DELETE FROM fb_pool_entries WHERE variant_id IN (${newVariantIds.map(quote).join(",")});`,
  `DELETE FROM fb_variant_back_renders WHERE variant_id IN (${newVariantIds.map(quote).join(",")});`,
  `DELETE FROM fb_variant_renders WHERE variant_id IN (${newVariantIds.map(quote).join(",")});`,
  `DELETE FROM fb_variants WHERE id IN (${newVariantIds.map(quote).join(",")});`,
  `DELETE FROM fb_card_name_aliases WHERE card_id IN (${newCards.map((entry) => quote(entry.cardId)).join(",")});`,
  `DELETE FROM fb_collection_cards WHERE card_id IN (${newCards.map((entry) => quote(entry.cardId)).join(",")});`,
  `DELETE FROM fb_artwork_editions WHERE card_id IN (${newCards.map((entry) => quote(entry.cardId)).join(",")});`,
  `DELETE FROM fb_card_definitions WHERE id IN (${newCards.map((entry) => quote(entry.cardId)).join(",")});`,
  `DELETE FROM fb_assets WHERE id IN (${[
    ...newCards.flatMap((entry) => [entry.subjectAssetId, entry.backgroundAssetId]),
    ...d1(
      `SELECT DISTINCT asset_id FROM fb_variant_renders WHERE variant_id IN (${newVariantIds.map(quote).join(",")}) UNION SELECT DISTINCT asset_id FROM fb_variant_back_renders WHERE variant_id IN (${newVariantIds.map(quote).join(",")})`,
    ).map((row) => row.asset_id),
  ].map(quote).join(",")});`,
  `UPDATE fb_collections SET release_version = release_version - 1 WHERE slug IN ('danganronpa-three-games','vocaloid');`,
  `-- Pool revision rollback is only safe if no later pool edit has occurred.`,
  `UPDATE fb_pools SET revision = revision - 1, status = 'active' WHERE slug IN ('danganronpa-three-games-capsule','vocaloid-capsule');`,
  `-- Or restore the whole pre-import JSON backup if the additive delete is not sufficient.`,
];
fs.writeFileSync(rollbackFile, `${rollback.join("\n")}\n`);

const report = {
  status: "applied",
  generated_at: new Date().toISOString(),
  environment: "production",
  backup: { file: backupPath, checksum_file: `${backupPath}.sha256` },
  imported: newCards.map((entry) => ({
    subject: entry.subject,
    card_id: entry.cardId,
    edition_id: entry.editionId,
    collection_id: entry.collectionId,
    variants: entry.variants.map((variant) => ({ id: variant.id, name: variant.name, material: variant.material_key, effect: variant.effect_key })),
    subject_asset_id: entry.subjectAssetId,
    background_asset_id: entry.backgroundAssetId,
  })),
  pool_updates: poolUpdates,
  aliases,
  counts,
  render_proof: proof,
  contact_sheet: contactSheet,
  rollback: rollbackFile,
  jobs: completedJobs,
};
fs.writeFileSync(evidenceJson, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  status: report.status,
  cards: report.imported.map((entry) => entry.subject),
  counts,
  pool_updates: report.pool_updates,
  contact_sheet: contactSheet,
  rollback: rollbackFile,
  evidence: evidenceJson,
}, null, 2));
