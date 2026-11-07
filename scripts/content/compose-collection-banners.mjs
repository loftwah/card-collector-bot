#!/usr/bin/env node
/**
 * Compose source-specific collection banners and marks from reviewed card art.
 *
 * The old banner class used a generic gradient, repeated dots/grid, a circle and
 * an initials seal. This composer uses the collection's actual published card
 * renders, the collection palette and its own name/context. It never generates
 * character illustration.
 *
 *   node scripts/content/compose-collection-banners.mjs --cookies FILE
 *   node scripts/content/compose-collection-banners.mjs --cookies FILE --apply
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { ROOT } from "../lib/local.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const valueOf = (name) => [...args].find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const cookiesPath = valueOf("--cookies");
if (!cookiesPath) throw new Error("Pass --cookies=<playwright storage-state json>.");
const BASE = "https://foilbury.loftwah.com";
const outDir = path.join(ROOT, ".foilbury", "evidence", "art-audit-2026-11-08", "replacement");
const cardDir = path.join(outDir, "cards");
fs.mkdirSync(cardDir, { recursive: true });
const contentDir = path.join(ROOT, ".foilbury", "content");
const fontFiles = [
  path.join(ROOT, "art/fonts/Fraunces.ttf"),
  path.join(ROOT, "art/fonts/Manrope.ttf"),
  path.join(ROOT, "art/fonts/IBMPlexMono-Regular.ttf"),
  path.join(ROOT, "art/fonts/IBMPlexMono-SemiBold.ttf"),
];

const state = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
const cookieJar = state.cookies.filter((cookie) => cookie.domain.includes("foilbury"));
const cookie = cookieJar.map((entry) => `${entry.name}=${entry.value}`).join("; ");
const csrf = cookieJar.find((entry) => entry.name === "fb_csrf")?.value ?? "";
const agentFile = path.join(ROOT, ".foilbury", "production-agent.json");
const agent = fs.existsSync(agentFile) ? JSON.parse(fs.readFileSync(agentFile, "utf8")) : null;
const headers = {
  cookie,
  "x-foilbury-csrf": csrf,
  accept: "application/json",
  ...(agent?.token ? { authorization: `Bearer ${agent.token}` } : {}),
};

async function api(route, { method = "GET", body, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${route}`, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${payload?.error?.message ?? text.slice(0, 400)}`);
  return payload;
}

async function bytes(route) {
  const response = await fetch(`${BASE}${route}`, { headers });
  if (!response.ok) throw new Error(`GET ${route} -> ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrap(value, maxChars) {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function svgBuffer(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Manrope" },
  });
  return resvg.render().asPng();
}

const cards = (await api("/api/v1/admin/cards?limit=2000")).items ?? [];
const collections = (await api("/api/v1/admin/collections")).items ?? [];
const manifests = fs
  .readdirSync(contentDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(contentDir, name), "utf8")))
  .filter((manifest) => manifest.collection && Array.isArray(manifest.cards));
const bySlug = new Map(manifests.map((manifest) => [manifest.collection.slug, manifest]));
const productionBySlug = new Map();
for (const card of cards) {
  for (const collection of card.collections ?? []) {
    if (!productionBySlug.has(collection.slug)) productionBySlug.set(collection.slug, []);
    productionBySlug.get(collection.slug).push(card);
  }
}

async function cardFront(card) {
  const variant = card.editions?.[0]?.variants?.find(
    (item) => item.material_key === "gold" && item.effect_key === "none" && item.render_url,
  ) ?? card.editions?.[0]?.variants?.find((item) => item.render_url);
  if (!variant) throw new Error(`No published front for ${card.slug}.`);
  const file = path.join(cardDir, `${card.slug}.png`);
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
    const webp = await bytes(variant.render_url);
    await sharp(webp).png().toFile(file);
  }
  return file;
}

async function makeBanner({ collection, manifest, selected }) {
  const palette = Array.isArray(manifest?.collection?.palette) && manifest.collection.palette.length >= 3
    ? manifest.collection.palette
    : ["#11141b", "#a8b8ff", "#f4f6fc"];
  const [deep, accent, light] = palette;
  const fronts = [];
  for (const card of selected) fronts.push(await cardFront(card));
  const width = 1600;
  const height = 900;
  const background = await sharp(fronts[0])
    .resize(width, height, { fit: "cover", position: "attention" })
    .blur(38)
    .modulate({ brightness: 0.3, saturation: 0.7 })
    .png()
    .toBuffer();
  const title = collection.name;
  const titleSize = title.length > 34 ? 48 : title.length > 24 ? 56 : 68;
  const titleLines = wrap(title, title.length > 34 ? 19 : title.length > 24 ? 21 : 22).slice(0, 3);
  const body = manifest?.collection?.description ?? collection.description ?? "";
  const source = (manifest?.collection?.source_work ?? collection.source_work ?? "Foilbury")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const context = manifest?.collection?.source_context ?? "";
  const bodyLines = wrap(body, 62).slice(0, 3);
  const meta = `RELEASE ${collection.release_version} · ${selected.length === 1 ? "1 SUBJECT SHOWN" : `${selected.length} SUBJECTS SHOWN`} · ${collection.view_audience.toUpperCase()}`;
  const ruleY = 470 + Math.max(0, titleLines.length - 2) * 60;
  const bodyY = ruleY + 36;
  const contextY = bodyY + bodyLines.length * 28 + 16;
  const overlay = svgBuffer(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="left" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${deep}" stop-opacity="0.97"/>
      <stop offset="0.44" stop-color="${deep}" stop-opacity="0.90"/>
      <stop offset="0.72" stop-color="${deep}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="${deep}" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="foot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${deep}" stop-opacity="0"/>
      <stop offset="1" stop-color="${deep}" stop-opacity="0.72"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#left)"/>
  <rect width="${width}" height="${height}" fill="url(#foot)"/>
  <rect x="80" y="96" width="6" height="88" fill="${accent}"/>
  <text x="112" y="132" font-family="IBM Plex Mono" font-size="20" letter-spacing="6" fill="${accent}">${escapeXml(source.toUpperCase())}</text>
  ${titleLines
    .map(
      (line, index) =>
        `<text x="104" y="${250 + index * (titleSize + 8)}" font-family="Fraunces" font-size="${titleSize}" font-weight="700" fill="${light}">${escapeXml(line)}</text>`,
    )
    .join("")}
  <rect x="108" y="${ruleY}" width="560" height="2" fill="${accent}" opacity="0.75"/>
  ${bodyLines
    .map(
      (line, index) =>
        `<text x="108" y="${bodyY + index * 28}" font-family="Manrope" font-size="20" fill="${light}" opacity="0.78">${escapeXml(line)}</text>`,
    )
    .join("")}
  <text x="108" y="${contextY}" font-family="IBM Plex Mono" font-size="14" fill="${light}" opacity="0.54">${escapeXml(wrap(context, 78)[0] ?? "")}</text>
  <text x="108" y="820" font-family="IBM Plex Mono" font-size="14" letter-spacing="1.5" fill="${light}" opacity="0.55">${escapeXml(meta)}</text>
</svg>`);
  const layers = [
    { input: background, left: 0, top: 0 },
    { input: overlay, left: 0, top: 0 },
  ];
  const positions = [
    { x: 800, y: 240, width: 250 },
    { x: 1030, y: 170, width: 300 },
    { x: 1300, y: 250, width: 250 },
  ];
  for (let index = 0; index < fronts.length; index += 1) {
    const position = positions[index] ?? positions[positions.length - 1];
    const card = await sharp(fronts[index]).resize({ width: position.width }).png().toBuffer();
    const shadow = await sharp(card).ensureAlpha().blur(24).modulate({ brightness: 0 }).png().toBuffer();
    layers.push({ input: shadow, left: position.x + 12, top: position.y + 18 });
    layers.push({ input: card, left: position.x, top: position.y });
  }
  const bannerFile = path.join(outDir, `${collection.slug}-banner.png`);
  await sharp({ create: { width, height, channels: 4, background: deep } })
    .composite(layers)
    .png()
    .toFile(bannerFile);

  const first = await sharp(fronts[0])
    .extract({ left: 30, top: 90, width: 690, height: 700 })
    .resize(512, 512, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();
  const logoFile = path.join(outDir, `${collection.slug}-logo.png`);
  await sharp(first)
    .composite([
      {
        input: Buffer.from(
          `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="506" height="506" fill="none" stroke="${accent}" stroke-width="6"/><rect x="14" y="14" width="484" height="484" fill="none" stroke="${deep}" stroke-width="10"/></svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toFile(logoFile);
  return { bannerFile, logoFile, palette, selected: selected.map((card) => card.slug) };
}

const generated = [];
for (const collection of collections) {
  if (collection.slug === "danganronpa-three-games") {
    generated.push({ slug: collection.slug, name: collection.name, kept: true });
    continue;
  }
  const manifest = bySlug.get(collection.slug);
  const pool = productionBySlug.get(collection.slug) ?? [];
  if (!manifest || pool.length === 0) {
    generated.push({ slug: collection.slug, name: collection.name, skipped: true });
    continue;
  }
  const selected = manifest.cards
    .map((card) => pool.find((item) => item.slug === card.slug))
    .filter(Boolean)
    .slice(0, 3);
  if (selected.length === 0) {
    generated.push({ slug: collection.slug, name: collection.name, skipped: true });
    continue;
  }
  const result = await makeBanner({ collection, manifest, selected });
  generated.push({ slug: collection.slug, name: collection.name, id: collection.id, audience: collection.view_audience, release: collection.release_version, ...result });
  console.log(`composed ${collection.slug}`);
}

const manifestFile = path.join(outDir, "manifest.json");
fs.writeFileSync(manifestFile, JSON.stringify(generated, null, 2));

if (apply) {
  const applied = [];
  for (const item of generated.filter((entry) => !entry.kept && !entry.skipped)) {
    const access = item.audience === "public" ? "public" : "member";
    const base = {
      kind: "brand",
      access,
      reviewStatus: "approved",
      sourceRepo: "loftwah/card-collector-bot",
      sourceCommit: "40bda759e9cbafd90ad1db02faefc0f919ba866c",
    };
    async function upload(file, fields) {
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)], { type: "image/png" }), path.basename(file));
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
      return (await api("/api/v1/admin/assets", { method: "POST", form })).asset;
    }
    const logo = await upload(item.logoFile, {
      ...base,
      name: `${item.name} mark`,
      role: "logo",
      sourceLogicalId: `${item.slug}:mark:2026-11-08`,
      provenance: "Composed from the reviewed card render. Not an official logo.",
      credit: "Character artwork © its rights holders; Foilbury composition for this private, non-commercial member album.",
    });
    const banner = await upload(item.bannerFile, {
      ...base,
      name: `${item.name} banner`,
      role: "banner",
      sourceLogicalId: `${item.slug}:banner:2026-11-08`,
      provenance: "Composed from reviewed Foilbury card renders. Not official artwork.",
      credit: "Character artwork © its rights holders; Foilbury composition for this private, non-commercial member album.",
    });
    applied.push({ ...item, logoAssetId: logo.id, bannerAssetId: banner.id, logoUrl: `/media/asset/${logo.id}`, bannerUrl: `/media/asset/${banner.id}` });
  }
  const sql = applied
    .map(
      (item) =>
        `UPDATE fb_collections SET logo_url='${item.logoUrl}', banner_url='${item.bannerUrl}', logo_asset_id='${item.logoAssetId}', banner_asset_id='${item.bannerAssetId}', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${item.id}' AND release_version=${item.release};`,
    )
    .join("\n");
  if (sql) {
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", "wrangler.production.jsonc", "--command", sql],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  }
  fs.writeFileSync(path.join(outDir, "applied.json"), JSON.stringify(applied, null, 2));
  console.log(JSON.stringify({ applied: applied.length, manifest: manifestFile, appliedFile: path.join(outDir, "applied.json") }, null, 2));
} else {
  console.log(JSON.stringify({ generated: generated.length, manifest: manifestFile }, null, 2));
}
