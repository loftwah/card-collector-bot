#!/usr/bin/env node
/**
 * Resolve, download and prepare real subject images for the launch catalogue.
 *
 * The launch cards previously used deterministic monograms because no licensed
 * character assets were supplied. That produced cards that were not recognisable
 * and, in at least one case, an oversized "HH" that read as an unintended symbol.
 * This script sources the published character/player image from the property's
 * reference wiki (or Wikimedia Commons for NBA players), records provenance and
 * licence metadata, and prepares an editable subject/background layer pair for
 * the existing compositor.
 *
 * It does not claim official affiliation or a licence. The private manifests and
 * downloaded source images stay under `.foilbury/` (gitignored).
 *
 * Usage:
 *   node scripts/content/source-art.mjs --only=danganronpa
 *   node scripts/content/source-art.mjs
 *   node scripts/content/source-art.mjs --refresh --force
 *   node scripts/content/source-art.mjs --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { COLLECTION_SOURCES, CARD_SOURCE_OVERRIDES } from "../../art/subject-sources.mjs";
import { motifSvg, palette } from "../../art/collection-art.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const refresh = args.has("--refresh");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1] : null;
const contentDir = path.join(process.cwd(), ".foilbury/content");
const sourcedDir = path.join(process.cwd(), ".foilbury/sourced");
const provenanceFile = path.join(sourcedDir, "provenance.json");
const userAgent = "FoilburyArtResearch/1.0 (private, non-commercial member album; contact: dean@deanlofts.xyz)";

function log(message) {
  console.log(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "user-agent": userAgent, accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function fandomApi(wiki, params) {
  const url = new URL(`https://${wiki}/api.php`);
  const query = { action: "query", format: "json", redirects: "1", ...params };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetchJson(url);
}

async function fandomFileInfo(wiki, fileTitle) {
  const title = fileTitle.startsWith("File:") ? fileTitle : `File:${fileTitle}`;
  const data = await fandomApi(wiki, { titles: title, prop: "imageinfo", iiprop: "url|size|mime|extmetadata" });
  const page = Object.values(data.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info?.url) return null;
  return {
    file: title,
    filePage: `https://${wiki}/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    imageUrl: info.url,
    width: info.width,
    height: info.height,
    mime: info.mime,
    license: stripHtml(info.extmetadata?.LicenseShortName?.value) || "Not stated by source",
    licenseUrl: info.extmetadata?.LicenseUrl?.value ?? null,
    artist: stripHtml(info.extmetadata?.Artist?.value) || null,
    credit: stripHtml(info.extmetadata?.Credit?.value) || null,
  };
}

async function resolveFandom(card, source, override) {
  const wiki = source.wiki;
  if (override.file) {
    const info = await fandomFileInfo(wiki, override.file);
    if (!info) throw new Error(`File:${override.file} was not found on ${wiki}`);
    return {
      provider: "fandom",
      wiki,
      wikiLabel: source.label,
      page: card.name,
      pageUrl: `https://${wiki}/wiki/${encodeURIComponent((override.page ?? card.name).replaceAll(" ", "_"))}`,
      ...info,
    };
  }
  const title = override.page ?? card.art?.wiki_page ?? card.name;
  let page = await fandomApi(wiki, { titles: title, prop: "pageimages", piprop: "original|name" });
  let candidate = Object.values(page.query?.pages ?? {}).find((item) => item.original?.source);
  if (!candidate) {
    const search = await fandomApi(wiki, { list: "search", srsearch: card.name, srlimit: "6" });
    for (const result of search.query?.search ?? []) {
      const attempt = await fandomApi(wiki, { titles: result.title, prop: "pageimages", piprop: "original|name" });
      const found = Object.values(attempt.query?.pages ?? {}).find((item) => item.original?.source);
      if (found) {
        candidate = found;
        break;
      }
    }
  }
  if (!candidate) return null;
  const fileTitle = candidate.pageimage ? `File:${candidate.pageimage}` : null;
  const info = fileTitle ? await fandomFileInfo(wiki, fileTitle) : null;
  if (!info) {
    return {
      provider: "fandom",
      wiki,
      wikiLabel: source.label,
      page: candidate.title,
      pageUrl: `https://${wiki}/wiki/${encodeURIComponent(candidate.title.replaceAll(" ", "_"))}`,
      file: null,
      filePage: null,
      imageUrl: candidate.original.source,
      width: candidate.original.width,
      height: candidate.original.height,
      mime: "image/png",
      license: "Not stated by source",
      licenseUrl: null,
      artist: null,
      credit: null,
    };
  }
  return {
    provider: "fandom",
    wiki,
    wikiLabel: source.label,
    page: candidate.title,
    pageUrl: `https://${wiki}/wiki/${encodeURIComponent(candidate.title.replaceAll(" ", "_"))}`,
    ...info,
  };
}

async function commonsFileInfo(file) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [key, value] of Object.entries({
    action: "query",
    format: "json",
    titles: `File:${file}`,
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
  })) url.searchParams.set(key, value);
  const data = await fetchJson(url);
  const page = Object.values(data.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info?.url) return null;
  return {
    file: `File:${file}`,
    filePage: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replaceAll(" ", "_"))}`,
    imageUrl: info.url,
    width: info.width,
    height: info.height,
    mime: info.mime ?? "image/jpeg",
    license: stripHtml(info.extmetadata?.LicenseShortName?.value) || "See source",
    licenseUrl: info.extmetadata?.LicenseUrl?.value ?? null,
    artist: stripHtml(info.extmetadata?.Artist?.value) || null,
    credit: stripHtml(info.extmetadata?.Credit?.value) || null,
  };
}

async function commonsMetadata(imageUrl) {
  try {
    const pathname = decodeURIComponent(new URL(imageUrl).pathname);
    const marker = "/commons/";
    const index = pathname.indexOf(marker);
    if (index === -1) return null;
    const file = pathname.slice(index + marker.length);
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    for (const [key, value] of Object.entries({
      action: "query",
      format: "json",
      titles: `File:${file}`,
      prop: "imageinfo",
      iiprop: "extmetadata|url",
    })) url.searchParams.set(key, value);
    const data = await fetchJson(url);
    const page = Object.values(data.query?.pages ?? {})[0];
    const info = page?.imageinfo?.[0];
    if (!info) return null;
    return {
      file: `File:${file}`,
      filePage: `https://commons.wikimedia.org/wiki/File:${file}`,
      license: stripHtml(info.extmetadata?.LicenseShortName?.value) || "See source",
      licenseUrl: info.extmetadata?.LicenseUrl?.value ?? null,
      artist: stripHtml(info.extmetadata?.Artist?.value) || null,
      credit: stripHtml(info.extmetadata?.Credit?.value) || null,
    };
  } catch {
    return null;
  }
}

async function resolveWikimedia(card, source, override) {
  const title = override.wikipediaTitle ?? card.art?.wikipedia_title ?? card.name;
  if (override.commonsFile) {
    const info = await commonsFileInfo(override.commonsFile);
    if (!info) return null;
    return {
      provider: "wikimedia",
      wiki: "commons.wikimedia.org",
      wikiLabel: source.label,
      page: card.name,
      pageUrl: info.filePage,
      ...info,
    };
  }
  const summary = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`);
  if (!summary.originalimage?.source) return null;
  const original = summary.originalimage;
  // Wikipedia may already serve a scaled original for very large files (Cade
  // Cunningham's is a 3,840px thumbnail). Do not fall back to the 330px preview.
  const imageUrl = original.source;
  const meta = await commonsMetadata(original.source);
  return {
    provider: "wikimedia",
    wiki: "commons.wikimedia.org",
    wikiLabel: source.label,
    page: summary.title,
    pageUrl: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    file: meta?.file ?? null,
    filePage: meta?.filePage ?? null,
    imageUrl,
    width: original.width,
    height: original.height,
    mime: "image/jpeg",
    license: meta?.license ?? "See Wikimedia Commons",
    licenseUrl: meta?.licenseUrl ?? null,
    artist: meta?.artist ?? null,
    credit: meta?.credit ?? null,
  };
}

function creditFor(source, page) {
  const artist = source.artist ? `${source.artist} · ` : "";
  if (source.provider === "wikimedia") {
    return `${artist}${source.license} · via Wikimedia Commons${page ? ` (“${page}”)` : ""}. Card design: Foilbury original.`;
  }
  if (!source.license || /fair use|non-free|copyright|not stated/i.test(source.license)) {
    return `Character artwork © its rights holders; sourced from ${source.wikiLabel}${page ? ` (“${page}”)` : ""} for this private, non-commercial member album. Not official or licensed. Card design: Foilbury original.`;
  }
  return `${artist}${source.license} · via ${source.wikiLabel}${page ? ` (“${page}”)` : ""}. Card design: Foilbury original.`;
}

async function downloadImage(source) {
  const remote = source.imageUrl;
  if (source.provider === "fandom") {
    const proxied = `https://images.weserv.nl/?url=${encodeURIComponent(remote.replace(/^https?:\/\//, ""))}&w=1600&output=png`;
    const response = await fetch(proxied, { headers: { "user-agent": userAgent } });
    if (!response.ok) throw new Error(`Image proxy returned HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new Error(`Image proxy returned ${type}`);
    return buffer;
  }
  const response = await fetch(remote, { headers: { "user-agent": userAgent } });
  if (!response.ok) throw new Error(`Image returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function prepareSubject(buffer, outputPath, focus, crop) {
  if (crop) {
    const sourceMeta = await sharp(buffer).metadata();
    const left = Math.max(0, Math.round(crop.x * (sourceMeta.width ?? 1)));
    const top = Math.max(0, Math.round(crop.y * (sourceMeta.height ?? 1)));
    const width = Math.min((sourceMeta.width ?? 1) - left, Math.round(crop.w * (sourceMeta.width ?? 1)));
    const height = Math.min((sourceMeta.height ?? 1) - top, Math.round(crop.h * (sourceMeta.height ?? 1)));
    if (width < 1 || height < 1) throw new Error("Crop is outside the source image.");
    buffer = await sharp(buffer).extract({ left, top, width, height }).png().toBuffer();
  }
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("Source image has no dimensions.");
  const stats = await sharp(buffer).stats();
  const alpha = meta.hasAlpha ? stats.channels[3] : null;
  const hasTransparency = Boolean(alpha && alpha.min < 245);
  if (hasTransparency) {
    let trimmed;
    try {
      trimmed = await sharp(buffer).trim({ threshold: 8 }).png().toBuffer();
    } catch {
      trimmed = await sharp(buffer).png().toBuffer();
    }
    const trimMeta = await sharp(trimmed).metadata();
    const scale = Math.min(1080 / (trimMeta.width ?? 1), 1500 / (trimMeta.height ?? 1));
    const width = Math.max(1, Math.round((trimMeta.width ?? 1) * scale));
    const height = Math.max(1, Math.round((trimMeta.height ?? 1) * scale));
    const resized = await sharp(trimmed).resize(width, height, { fit: "inside" }).png().toBuffer();
    await sharp({ create: { width: 1200, height: 1600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: resized, left: Math.round((1200 - width) / 2), top: Math.max(0, 1560 - height) }])
      .png()
      .toFile(outputPath);
    return { hasTransparency: true, width: meta.width, height: meta.height };
  }
  await sharp(buffer)
    .resize(1200, 1600, { fit: "cover", position: focus ?? "attention" })
    .png()
    .toFile(outputPath);
  return { hasTransparency: false, width: meta.width, height: meta.height };
}

async function prepareBackground(buffer, outputPath, { colors, motif, seed }) {
  const meta = await sharp(buffer).metadata();
  const flattened = meta.hasAlpha
    ? await sharp(buffer).flatten({ background: colors.deep }).png().toBuffer()
    : buffer;
  const base = await sharp(flattened)
    .resize(1600, 2000, { fit: "cover", position: "attention" })
    .blur(30)
    .modulate({ brightness: 0.4, saturation: 0.78 })
    .png()
    .toBuffer();
  const overlay = Buffer.from(`<svg width="1600" height="2000" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="grade" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${colors.deep}" stop-opacity=".72"/>
        <stop offset=".48" stop-color="${colors.accent}" stop-opacity=".24"/>
        <stop offset="1" stop-color="${colors.deep}" stop-opacity=".88"/>
      </linearGradient>
      <radialGradient id="vignette" cx="50%" cy="42%" r="76%">
        <stop offset="0" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity=".58"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="2000" fill="url(#grade)"/>
    ${motifSvg(motif, colors, 1600, 2000, seed)}
    <rect width="1600" height="2000" fill="url(#vignette)"/>
  </svg>`);
  await sharp(base).composite([{ input: overlay, left: 0, top: 0 }]).png().toFile(outputPath);
}

function sourceRecord(source, page, prepared, bytes) {
  return {
    provider: source.provider,
    wiki: source.wiki,
    wiki_label: source.wikiLabel,
    page: source.page ?? page,
    page_url: source.pageUrl ?? null,
    file: source.file ?? null,
    file_page: source.filePage ?? null,
    image_url: source.imageUrl,
    retrieved_at: new Date().toISOString(),
    license: source.license,
    license_url: source.licenseUrl ?? null,
    artist: source.artist ?? null,
    credit: creditFor(source, source.page ?? page),
    review_status: "sourced-pending-review",
    source_bytes_sha256: sha256(bytes),
    source_dimensions: { width: prepared.width, height: prepared.height },
    has_transparency: prepared.hasTransparency,
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

fs.mkdirSync(sourcedDir, { recursive: true });
const files = fs
  .readdirSync(contentDir)
  .filter((file) => file.endsWith(".json"))
  .filter((file) => !only || file === `${only}.json`)
  .sort();
if (!files.length) throw new Error(`No manifests found${only ? ` for ${only}` : ""}.`);

const provenance = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile, "utf8")) : { generated_at: null, cards: {} };
if (!provenance.cards) provenance.cards = {};
const summary = [];

for (const file of files) {
  const manifestPath = path.join(contentDir, file);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const collectionSlug = manifest.collection.slug;
  const source = COLLECTION_SOURCES[file.replace(/\.json$/, "")];
  if (!source) {
    log(`SKIP ${file}: no source mapping`);
    continue;
  }
  const collectionDir = path.join(sourcedDir, collectionSlug);
  fs.mkdirSync(collectionDir, { recursive: true });
  log(`\n## ${manifest.collection.name} (${manifest.cards.length} cards)`);
  for (const card of manifest.cards) {
    const key = `${collectionSlug}:${card.slug}`;
    const override = CARD_SOURCE_OVERRIDES[key] ?? {};
    const sourcePath = path.join(collectionDir, `${card.slug}-source.png`);
    const subjectPath = path.join(collectionDir, `${card.slug}-subject.png`);
    const backgroundPath = path.join(collectionDir, `${card.slug}-background.png`);
    const existing = card.art?.source;
    try {
      let resolved = !refresh && existing?.image_url ? { ...existing, provider: existing.provider, wiki: existing.wiki, wikiLabel: existing.wiki_label, pageUrl: existing.page_url, filePage: existing.file_page, imageUrl: existing.image_url, license: existing.license, licenseUrl: existing.license_url, artist: existing.artist, wiki: existing.wiki } : null;
      if (!resolved) {
        resolved = source.provider === "fandom" ? await resolveFandom(card, source, override) : await resolveWikimedia(card, source, override);
      }
      if (!resolved?.imageUrl) throw new Error("No published subject image was resolved.");
      let bytes;
      if (!force && fs.existsSync(sourcePath) && existing?.image_url === resolved.imageUrl) {
        bytes = fs.readFileSync(sourcePath);
      } else {
        bytes = await downloadImage(resolved);
        const meta = await sharp(bytes).metadata();
        if (!meta.width || meta.width < 240 || meta.height < 240) throw new Error(`Source image is too small (${meta.width}x${meta.height}).`);
        if (meta.format === "heif" || meta.format === "svg") throw new Error(`Unsupported source format (${meta.format}).`);
        fs.writeFileSync(sourcePath, bytes);
      }
      const colors = palette(card.art?.palette ?? manifest.collection.palette);
      const motif = card.art?.motif ?? manifest.collection.motif ?? "grid";
      const prepared = await prepareSubject(bytes, subjectPath, override.focus, override.crop);
      await prepareBackground(bytes, backgroundPath, { colors, motif, seed: card.slug });
      const record = sourceRecord(resolved, card.name, prepared, bytes);
      card.art = card.art ?? {};
      card.art.source = record;
      card.credit = record.credit;
      provenance.cards[key] = record;
      const size = `${prepared.width}x${prepared.height}`;
      log(`  OK   ${card.slug} · ${resolved.page ?? resolved.file} · ${size}${prepared.hasTransparency ? " · cutout" : ""}`);
      summary.push({ key, status: "ok", source: resolved.page ?? resolved.file, license: record.license });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      card.art = card.art ?? {};
      card.art.source = { status: "missing", reason: message, retrieved_at: new Date().toISOString() };
      provenance.cards[key] = card.art.source;
      log(`  MISS ${card.slug} · ${message}`);
      summary.push({ key, status: "missing", reason: message });
    }
  }
  if (!dryRun) writeJson(manifestPath, manifest);
}

provenance.generated_at = new Date().toISOString();
if (!dryRun) writeJson(provenanceFile, provenance);
const ok = summary.filter((item) => item.status === "ok").length;
const missing = summary.filter((item) => item.status === "missing");
log(`\nResolved ${ok}/${summary.length} subject images.`);
if (missing.length) {
  log("Missing:");
  for (const item of missing) log(`  ${item.key}: ${item.reason}`);
  process.exitCode = 1;
}
if (dryRun) log("Dry run: manifests and provenance were not written.");
