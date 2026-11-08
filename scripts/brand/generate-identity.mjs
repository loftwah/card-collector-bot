#!/usr/bin/env node
/**
 * Generate the Foil Standard identity.
 *
 * The mark is an original geometric F cut from a stack of two cards: a paper
 * plane over a foil-blue plane, with a chamfered fold at the top right. The
 * type is Vercel's Geist family (SIL OFL 1.1), self-hosted under /fonts/geist.
 *
 * Everything is deterministic, local and unpaid. Rasters are rendered in real
 * Chromium so the self-hosted faces never silently fall back.
 *
 *   node scripts/brand/generate-identity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const publicBrand = path.join(ROOT, "public", "brand");
const kit = path.join(publicBrand, "kit");
const systemDir = path.join(kit, "systems", "foil-standard");
fs.mkdirSync(path.join(kit, "foil-standard"), { recursive: true });
fs.mkdirSync(systemDir, { recursive: true });
fs.mkdirSync(path.join(kit, "social"), { recursive: true });
fs.mkdirSync(path.join(kit, "banners"), { recursive: true });
fs.mkdirSync(path.join(kit, "wordmarks"), { recursive: true });

const INK = "#0A0A0A";
const PAPER = "#FAFAF8";
const GRAPHITE = "#5B5B57";
const RULE = "#E4E4DF";
const FOIL = "#1F5EFF";
const FOIL_SOFT = "#8FB0FF";
const DARK_PANEL = "#111111";
const DARK_LINE = "#2A2A2A";
const HOLO = ["#8BE9FF", "#1F5EFF", "#B18CFF", "#E9FF8A"];

const F = "M56 48h108l12 12v28H96v28h64v40H96v60H56z";

const fontFiles = {
  serif: path.join(ROOT, "public", "fonts", "geist", "GeistSerifVF.woff2"),
  sans: path.join(ROOT, "public", "fonts", "geist", "GeistSansVF.woff2"),
  mono: path.join(ROOT, "public", "fonts", "geist", "GeistMonoVF.woff2"),
};

function fontFace(name, file) {
  return `@font-face{font-family:"${name}";src:url("data:font/woff2;base64,${fs
    .readFileSync(file)
    .toString("base64")}") format("woff2");font-weight:100 900;font-style:normal;font-display:block}`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function markSvg({
  background = INK,
  front = PAPER,
  foil = FOIL,
  transparent = false,
  scale = 1,
} = {}) {
  const transform = scale === 1 ? "" : ` transform="translate(${128 - 128 * scale} ${128 - 128 * scale}) scale(${scale})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Foilbury mark">
    ${transparent ? "" : `<rect width="256" height="256" fill="${background}"/>`}
    <g${transform}>
      <path d="${F}" transform="translate(12 12)" fill="${foil}"/>
      <path d="${F}" fill="${front}"/>
    </g>
  </svg>`;
}

function glyphSvg({ front = "currentColor", foil = FOIL } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="28 24 200 200" role="img" aria-label="Foilbury mark">
    <path d="${F}" transform="translate(12 12)" fill="${foil}"/>
    <path d="${F}" fill="${front}"/>
  </svg>`;
}

function wordmarkSvg({ color = INK, foil = FOIL, background = null, text = "Foilbury" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 400" role="img" aria-label="Foilbury wordmark">
    ${background ? `<rect width="1600" height="400" fill="${background}"/>` : ""}
    <g transform="translate(40 0)">
      <g transform="translate(0 96) scale(0.62)">
        <path d="${F}" transform="translate(12 12)" fill="${foil}"/>
        <path d="${F}" fill="${color}"/>
      </g>
      <text x="220" y="248" font-family="Geist Serif" font-weight="500" font-size="210" letter-spacing="-8" fill="${color}">${escapeXml(text)}</text>
      <text x="226" y="312" font-family="Geist Mono" font-size="22" letter-spacing="8" fill="${color}" opacity=".58">A COLLECTOR'S CABINET</text>
    </g>
  </svg>`;
}

function lockupSvg({ color = INK, foil = FOIL, background = null } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 360" role="img" aria-label="Foilbury lockup">
    ${background ? `<rect width="1200" height="360" fill="${background}"/>` : ""}
    <g transform="translate(48 52) scale(0.82)">
      <path d="${F}" transform="translate(12 12)" fill="${foil}"/>
      <path d="${F}" fill="${color}"/>
    </g>
    <text x="330" y="228" font-family="Geist Serif" font-weight="500" font-size="168" letter-spacing="-6" fill="${color}">Foilbury</text>
  </svg>`;
}

function gridPattern(id, colour = PAPER, opacity = 0.08, size = 48) {
  return `<pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse">
    <path d="M${size} 0H0V${size}" fill="none" stroke="${colour}" stroke-width="1" opacity="${opacity}"/>
  </pattern>`;
}

function ogSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="Foilbury social preview">
    <defs>
      ${gridPattern("og-grid", PAPER, 0.06, 60)}
      <linearGradient id="holo" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${HOLO[0]}"/>
        <stop offset=".38" stop-color="${HOLO[1]}"/>
        <stop offset=".72" stop-color="${HOLO[2]}"/>
        <stop offset="1" stop-color="${HOLO[3]}"/>
      </linearGradient>
    </defs>
    <rect width="1200" height="630" fill="${INK}"/>
    <rect width="1200" height="630" fill="url(#og-grid)"/>
    <g transform="translate(64 54)">
      <g transform="translate(0 0) scale(0.34)">
        <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
        <path d="${F}" fill="${PAPER}"/>
      </g>
      <text x="76" y="48" font-family="Geist Serif" font-weight="500" font-size="34" letter-spacing="-1" fill="${PAPER}">Foilbury</text>
    </g>
    <text x="64" y="252" font-family="Geist Serif" font-weight="500" font-size="86" letter-spacing="-3" fill="${PAPER}">Characters</text>
    <text x="64" y="338" font-family="Geist Serif" font-weight="500" font-size="86" letter-spacing="-3" fill="${PAPER}">worth keeping.</text>
    <text x="66" y="404" font-family="Geist Sans" font-size="24" fill="#B8B8B2">A free collectible-card cabinet for original worlds.</text>
    <rect x="66" y="446" width="260" height="6" fill="url(#holo)"/>
    <text x="66" y="514" font-family="Geist Mono" font-size="17" letter-spacing="4" fill="#B8B8B2">FREE TO PLAY · PUBLIC SHELF · MEMBER ALBUM</text>
    <text x="66" y="566" font-family="Geist Mono" font-size="18" letter-spacing="3" fill="${FOIL_SOFT}">foilbury.loftwah.com</text>
    <g transform="translate(804 154) rotate(-9 120 168)" opacity=".5">
      <rect width="240" height="336" rx="9" fill="#0B0B0B" stroke="${DARK_LINE}"/>
      <rect x="0" y="330" width="240" height="3" fill="${DARK_LINE}"/>
    </g>
    <g transform="translate(842 84) rotate(7 150 210)">
      <rect x="16" y="16" width="300" height="420" rx="10" fill="#0E0E0E" stroke="${DARK_LINE}"/>
      <rect x="0" y="0" width="300" height="420" rx="10" fill="${DARK_PANEL}" stroke="${DARK_LINE}"/>
      <g transform="translate(90 150) scale(0.47)">
        <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
        <path d="${F}" fill="${PAPER}"/>
      </g>
      <text x="150" y="372" text-anchor="middle" font-family="Geist Mono" font-size="12" letter-spacing="4" fill="#8A8A84">PUBLIC SHELF · 001</text>
      <rect x="0" y="414" width="300" height="6" fill="url(#holo)"/>
    </g>
  </svg>`;
}

function heroSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" role="img" aria-label="Foilbury hero artwork">
    <defs>${gridPattern("hero-grid", PAPER, 0.05, 80)}</defs>
    <rect width="1920" height="1080" fill="${INK}"/>
    <rect width="1920" height="1080" fill="url(#hero-grid)"/>
    <g transform="translate(96 96)">
      <g transform="translate(0 0) scale(0.5)">
        <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
        <path d="${F}" fill="${PAPER}"/>
      </g>
      <text x="112" y="68" font-family="Geist Serif" font-weight="500" font-size="48" letter-spacing="-1" fill="${PAPER}">Foilbury</text>
    </g>
    <text x="96" y="520" font-family="Geist Serif" font-weight="500" font-size="160" letter-spacing="-6" fill="${PAPER}">Characters</text>
    <text x="96" y="678" font-family="Geist Serif" font-weight="500" font-size="160" letter-spacing="-6" fill="${PAPER}">worth keeping.</text>
    <text x="100" y="782" font-family="Geist Sans" font-size="34" fill="#B8B8B2">A free collectible-card cabinet for original worlds.</text>
    <rect x="100" y="838" width="420" height="8" fill="${FOIL}"/>
    <text x="100" y="924" font-family="Geist Mono" font-size="22" letter-spacing="6" fill="#8A8A84">FREE TO PLAY · NO PURCHASE · EARNED FOIL ONLY</text>
    <g transform="translate(1320 92) rotate(6 240 336)">
      <rect x="24" y="24" width="480" height="672" rx="14" fill="#0E0E0E" stroke="${DARK_LINE}"/>
      <rect width="480" height="672" rx="14" fill="${DARK_PANEL}" stroke="${DARK_LINE}"/>
      <g transform="translate(150 230) scale(0.7)">
        <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
        <path d="${F}" fill="${PAPER}"/>
      </g>
      <text x="240" y="588" text-anchor="middle" font-family="Geist Mono" font-size="17" letter-spacing="7" fill="#8A8A84">PUBLIC SHELF · 001</text>
      <rect y="666" width="480" height="6" fill="${FOIL}"/>
    </g>
  </svg>`;
}

function bannerSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" role="img" aria-label="Foilbury Discord banner">
    <defs>${gridPattern("banner-grid", PAPER, 0.07, 40)}</defs>
    <rect width="960" height="540" fill="${INK}"/>
    <rect width="960" height="540" fill="url(#banner-grid)"/>
    <g transform="translate(56 106)">
      <g transform="translate(0 0) scale(0.42)">
        <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
        <path d="${F}" fill="${PAPER}"/>
      </g>
      <text x="96" y="60" font-family="Geist Serif" font-weight="500" font-size="40" letter-spacing="-1" fill="${PAPER}">Foilbury</text>
    </g>
    <text x="56" y="330" font-family="Geist Serif" font-weight="500" font-size="64" letter-spacing="-3" fill="${PAPER}">Characters</text>
    <text x="56" y="400" font-family="Geist Serif" font-weight="500" font-size="64" letter-spacing="-3" fill="${PAPER}">worth keeping.</text>
    <rect x="58" y="432" width="220" height="5" fill="${FOIL}"/>
    <text x="58" y="484" font-family="Geist Mono" font-size="14" letter-spacing="4" fill="#8A8A84">PUBLIC SHELF · MEMBER ALBUM · ORIGINAL WORLDS</text>
    <g transform="translate(686 128) rotate(8 100 140)">
      <rect x="12" y="12" width="200" height="280" rx="8" fill="#0E0E0E" stroke="${DARK_LINE}"/>
      <rect width="200" height="280" rx="8" fill="${DARK_PANEL}" stroke="${DARK_LINE}"/>
      <g transform="translate(64 88) scale(0.34)">
        <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
        <path d="${F}" fill="${PAPER}"/>
      </g>
      <text x="100" y="246" text-anchor="middle" font-family="Geist Mono" font-size="9" letter-spacing="3" fill="#8A8A84">PUBLIC SHELF · 001</text>
      <rect y="276" width="200" height="4" fill="${FOIL}"/>
    </g>
  </svg>`;
}

function cardBackSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 1050" role="img" aria-label="Foilbury card back">
    <defs>${gridPattern("card-grid", PAPER, 0.05, 50)}</defs>
    <rect width="750" height="1050" fill="${INK}"/>
    <rect width="750" height="1050" fill="url(#card-grid)"/>
    <rect x="28" y="28" width="694" height="994" fill="none" stroke="${DARK_LINE}" stroke-width="2"/>
    <rect x="48" y="48" width="654" height="954" fill="none" stroke="${DARK_LINE}" stroke-width="1"/>
    <g transform="translate(223 315) scale(1.18)">
      <path d="${F}" transform="translate(12 12)" fill="${FOIL}"/>
      <path d="${F}" fill="${PAPER}"/>
    </g>
    <text x="375" y="850" text-anchor="middle" font-family="Geist Serif" font-weight="500" font-size="58" letter-spacing="-2" fill="${PAPER}">Foilbury</text>
    <text x="375" y="888" text-anchor="middle" font-family="Geist Mono" font-size="15" letter-spacing="8" fill="#8A8A84">A COLLECTOR'S CABINET</text>
    <rect x="225" y="930" width="300" height="5" fill="${FOIL}"/>
    <text x="375" y="976" text-anchor="middle" font-family="Geist Mono" font-size="12" letter-spacing="5" fill="#8A8A84">FOILBURY.LOFTWAH.COM</text>
  </svg>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const fontCss = [
  fontFace("Geist Serif", fontFiles.serif),
  fontFace("Geist Sans", fontFiles.sans),
  fontFace("Geist Mono", fontFiles.mono),
].join("\n");

async function capture(svg, width, height, { transparent = false, background = INK } = {}) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontCss}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? "transparent" : background}}
    svg{display:block;width:${width}px;height:${height}px}
    text{font-kerning:normal}
  </style></head><body>${svg}</body></html>`;
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ type: "png", omitBackground: transparent });
}

async function render(svg, file, width, height, options = {}) {
  const buffer = await capture(svg, width, height, options);
  fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, file), buffer);
  return buffer;
}

async function renderJpg(svg, file, width, height, background = INK) {
  const buffer = await capture(svg, width, height, { background });
  await sharp(buffer).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toFile(path.join(ROOT, file));
}

async function renderWebp(svg, file, width, height, background = INK) {
  const buffer = await capture(svg, width, height, { background });
  await sharp(buffer).webp({ quality: 92 }).toFile(path.join(ROOT, file));
}

const icon = markSvg();
const iconTransparent = markSvg({ transparent: true });
const iconMonoLight = markSvg({ transparent: true, front: INK, foil: INK });
const iconMonoDark = markSvg({ transparent: true, front: PAPER, foil: PAPER });

// App and web icons.
fs.writeFileSync(path.join(publicBrand, "mark.svg"), `${icon}\n`);
fs.writeFileSync(path.join(publicBrand, "mark-mono.svg"), `${iconMonoLight}\n`);
fs.writeFileSync(path.join(publicBrand, "glyph.svg"), `${glyphSvg()}\n`);
await render(icon, "public/brand/mark.png", 512, 512);
await render(iconMonoLight, "public/brand/mark-mono.png", 512, 512, { transparent: true });
await render(icon, "public/brand/discord-avatar.png", 512, 512);
await render(markSvg({ front: PAPER, foil: PAPER }), "public/brand/favicon-16.png", 16, 16);
await render(icon, "public/brand/favicon-32.png", 32, 32);
await render(icon, "public/brand/favicon-48.png", 48, 48);
await render(icon, "public/brand/apple-touch-icon.png", 180, 180);
await render(icon, "public/brand/icon-192.png", 192, 192);
await render(icon, "public/brand/icon-512.png", 512, 512);
const maskable = markSvg({ scale: 0.62 });
await render(maskable, "public/brand/icon-192-maskable.png", 192, 192);
await render(maskable, "public/brand/icon-512-maskable.png", 512, 512);

// Brand-kit masters.
fs.writeFileSync(path.join(kit, "foil-standard", "mark.svg"), `${icon}\n`);
fs.writeFileSync(path.join(kit, "foil-standard", "glyph.svg"), `${glyphSvg()}\n`);
await render(icon, "public/brand/kit/foil-standard/mark-256.png", 256, 256);
await render(icon, "public/brand/kit/foil-standard/mark-512.png", 512, 512);
await render(icon, "public/brand/kit/foil-standard/mark-1024.png", 1024, 1024);
await render(iconTransparent, "public/brand/kit/foil-standard/mark-transparent-1024.png", 1024, 1024, { transparent: true });
await render(icon, "public/brand/kit/foil-standard/avatar-512.png", 512, 512);

// Wordmarks and lockups.
fs.writeFileSync(path.join(kit, "wordmarks", "foil-standard.svg"), `${wordmarkSvg({ background: PAPER })}\n`);
fs.writeFileSync(path.join(kit, "wordmarks", "foil-standard-reverse.svg"), `${wordmarkSvg({ color: PAPER, background: INK })}\n`);
fs.writeFileSync(path.join(publicBrand, "wordmark.svg"), `${wordmarkSvg()}\n`);
fs.writeFileSync(path.join(publicBrand, "lockup.svg"), `${lockupSvg()}\n`);
await render(wordmarkSvg({ background: PAPER }), "public/brand/wordmark.png", 1600, 400, { background: PAPER });
await render(wordmarkSvg({ color: PAPER, background: INK }), "public/brand/wordmark-reverse.png", 1600, 400, { background: INK });
await render(wordmarkSvg({ background: null }), "public/brand/kit/wordmarks/foil-standard-transparent-1600x400.png", 1600, 400, { transparent: true });
await render(wordmarkSvg({ color: PAPER, background: null }), "public/brand/kit/wordmarks/foil-standard-reverse-transparent-1600x400.png", 1600, 400, { transparent: true });
await render(lockupSvg(), "public/brand/kit/foil-standard/lockup-1600x400.png", 1600, 400, { background: PAPER });

// Social, hero and Discord banners.
await renderJpg(ogSvg(), "public/brand/social-preview.jpg", 1200, 630);
await render(ogSvg(), "public/brand/kit/social/og-1200x630.png", 1200, 630);
await render(heroSvg(), "public/brand/kit/social/hero-1920x1080.png", 1920, 1080);
await render(bannerSvg(), "public/brand/kit/banners/foil-standard-960x540.png", 960, 540);
await render(bannerSvg(), "public/brand/kit/banners/foil-standard-1920x1080.png", 1920, 1080);

// System folder mirrors the existing reviewed-system layout.
fs.mkdirSync(path.join(systemDir), { recursive: true });
fs.writeFileSync(path.join(systemDir, "icon.svg"), `${icon}\n`);
fs.writeFileSync(path.join(systemDir, "icon-mono-dark.svg"), `${iconMonoDark}\n`);
fs.writeFileSync(path.join(systemDir, "icon-mono-light.svg"), `${iconMonoLight}\n`);
fs.writeFileSync(path.join(systemDir, "icon-transparent.svg"), `${markSvg({ transparent: true, front: INK, foil: FOIL })}\n`);
fs.writeFileSync(path.join(systemDir, "banner.svg"), `${bannerSvg()}\n`);
await render(icon, "public/brand/kit/systems/foil-standard/icon-1024.png", 1024, 1024);
await render(icon, "public/brand/kit/systems/foil-standard/icon-512.png", 512, 512);
await render(icon, "public/brand/kit/systems/foil-standard/icon-128.png", 128, 128);
await render(icon, "public/brand/kit/systems/foil-standard/icon-64.png", 64, 64);
await render(icon, "public/brand/kit/systems/foil-standard/icon-32.png", 32, 32);
await render(markSvg({ background: PAPER, front: INK, foil: FOIL }), "public/brand/kit/systems/foil-standard/icon-light-1024.png", 1024, 1024);
await render(markSvg({ transparent: true, front: INK, foil: FOIL }), "public/brand/kit/systems/foil-standard/icon-transparent-1024.png", 1024, 1024, { transparent: true });
await render(iconMonoDark, "public/brand/kit/systems/foil-standard/icon-mono-dark-1024.png", 1024, 1024, { transparent: true });
await render(iconMonoLight, "public/brand/kit/systems/foil-standard/icon-mono-light-1024.png", 1024, 1024, { transparent: true });
await render(bannerSvg(), "public/brand/kit/systems/foil-standard/banner-960x540.png", 960, 540);
await render(bannerSvg(), "public/brand/kit/systems/foil-standard/banner-1920x1080.png", 1920, 1080);

// The generic card back is a real product surface in Discord and the draw room.
await renderWebp(cardBackSvg(), "public/brand/card-back.webp", 750, 1050);

await browser.close();

// Keep the historical systems in the manifest; add the selected identity.
const manifestPath = path.join(kit, "manifest.json");
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
const identity = {
  slug: "foil-standard",
  label: "Foil Standard",
  kicker: "Monochrome archive",
  note: "A dark-and-paper archive with a high-contrast Geist Serif voice and one electric foil edge.",
  rationale:
    "Foil Standard replaces the decorated aqua mark with a two-plane card fold: a paper F over a foil-blue plane, chamfered like a turned card corner. Geist Serif gives the cabinet an editorial voice; Geist Sans and Mono keep the odds, serials and controls precise. The palette is neutral in both themes, so collection art supplies the colour.",
  palette: [
    { name: "Paper", hex: PAPER, role: "page and card planes" },
    { name: "Ink", hex: INK, role: "type and feature fields" },
    { name: "Graphite", hex: GRAPHITE, role: "secondary type" },
    { name: "Rule", hex: RULE, role: "hairline structure" },
    { name: "Foil blue", hex: FOIL, role: "the one signal edge" },
  ],
  foil: { name: "Holo edge", stops: HOLO, role: "the mark edge and one hero rule" },
  typography: {
    display: "Geist Serif 500, tight tracking, sentence case.",
    interface: "Geist Sans for UI and body.",
    data: "Geist Mono for serials, odds, labels and provenance.",
    licensing: "Geist is self-hosted under the SIL Open Font License 1.1.",
    source: "https://vercel.com/font",
  },
  assets: [
    { id: "mark-svg", path: "/brand/kit/foil-standard/mark.svg", width: 256, height: 256, format: "svg", use: "Vector mark master" },
    { id: "glyph-svg", path: "/brand/kit/foil-standard/glyph.svg", width: 200, height: 200, format: "svg", use: "Transparent glyph for UI" },
    { id: "mark-1024", path: "/brand/kit/foil-standard/mark-1024.png", width: 1024, height: 1024, format: "png", use: "Opaque app icon master" },
    { id: "mark-512", path: "/brand/kit/foil-standard/mark-512.png", width: 512, height: 512, format: "png", use: "512px proof" },
    { id: "mark-256", path: "/brand/kit/foil-standard/mark-256.png", width: 256, height: 256, format: "png", use: "256px proof" },
    { id: "avatar-512", path: "/brand/kit/foil-standard/avatar-512.png", width: 512, height: 512, format: "png", use: "Discord application avatar" },
    { id: "wordmark-svg", path: "/brand/kit/wordmarks/foil-standard.svg", width: 1600, height: 400, format: "svg", use: "Vector wordmark master" },
    { id: "wordmark-png", path: "/brand/wordmark.png", width: 1600, height: 400, format: "png", use: "Wordmark on paper" },
    { id: "wordmark-reverse", path: "/brand/wordmark-reverse.png", width: 1600, height: 400, format: "png", use: "Wordmark on ink" },
    { id: "social-og", path: "/brand/social-preview.jpg", width: 1200, height: 630, format: "jpg", use: "Default Open Graph image" },
    { id: "social-og-png", path: "/brand/kit/social/og-1200x630.png", width: 1200, height: 630, format: "png", use: "Social preview master" },
    { id: "social-hero", path: "/brand/kit/social/hero-1920x1080.png", width: 1920, height: 1080, format: "png", use: "Wide hero artwork" },
    { id: "banner-960", path: "/brand/kit/banners/foil-standard-960x540.png", width: 960, height: 540, format: "png", use: "Discord server banner size" },
    { id: "banner-1920", path: "/brand/kit/banners/foil-standard-1920x1080.png", width: 1920, height: 1080, format: "png", use: "Wide banner master" },
    { id: "discord-avatar", path: "/brand/discord-avatar.png", width: 512, height: 512, format: "png", use: "Discord application icon upload" },
    { id: "card-back", path: "/brand/card-back.webp", width: 750, height: 1050, format: "webp", use: "Generic card back" },
  ],
};

const markEntry = {
  slug: "foil-standard",
  label: "Foil Standard",
  note: identity.note,
  svg: "/brand/kit/foil-standard/mark.svg",
  png: "/brand/kit/foil-standard/mark-1024.png",
  avatars: ["/brand/kit/foil-standard/avatar-512.png"],
};
const wordmarkEntry = {
  slug: "foil-standard",
  label: "Foil Standard wordmark",
  svg: "/brand/kit/wordmarks/foil-standard.svg",
  png: "/brand/wordmark.png",
  transparent: "/brand/kit/wordmarks/foil-standard-transparent-1600x400.png",
};
const bannerEntry = {
  slug: "foil-standard",
  label: "Foil Standard banner",
  discord: "/brand/kit/banners/foil-standard-960x540.png",
  social: "/brand/kit/banners/foil-standard-1920x1080.png",
};
const socialEntries = [
  { slug: "foil-standard-og", label: "Foil Standard Open Graph", png: "/brand/kit/social/og-1200x630.png", dimensions: "1200x630" },
  { slug: "foil-standard-hero", label: "Foil Standard hero", png: "/brand/kit/social/hero-1920x1080.png", dimensions: "1920x1080" },
];

const manifest = {
  ...previous,
  schema: 2,
  generated_at: new Date().toISOString(),
  palette: {
    paper: PAPER,
    ink: INK,
    graphite: GRAPHITE,
    rule: RULE,
    foil: FOIL,
    holo: HOLO,
  },
  identity,
  marks: [markEntry, ...(previous.marks ?? []).filter((item) => item.slug !== "foil-standard")],
  wordmarks: [wordmarkEntry, ...(previous.wordmarks ?? []).filter((item) => item.slug !== "foil-standard")],
  banners: [bannerEntry, ...(previous.banners ?? []).filter((item) => item.slug !== "foil-standard")],
  social: [...socialEntries, ...(previous.social ?? []).filter((item) => !item.slug?.startsWith("foil-standard"))],
  systems: [
    {
      slug: "foil-standard",
      index: "00",
      label: "Foil Standard",
      kicker: identity.kicker,
      tagline: "Characters worth keeping.",
      note: identity.note,
      rationale: identity.rationale,
      strengths: [
        "The mark reads as an F at 16px and as a folded card at 512px.",
        "Geist Serif, Sans and Mono give the product one voice across marketing, album and admin.",
        "One foil-blue signal stays legible in light and dark without tinting card art.",
      ],
      watchouts: [
        "The serif carries the display; do not set controls or data in it.",
        "Foil blue is a signal, not a decorative wash.",
        "Keep the top 48px of the Discord banner quiet for the server title.",
      ],
      smallSize: "The paper F over the foil plane survives 16px; the chamfer is the only detail that disappears.",
      bannerLogic: "A quiet ink field with the wordmark low-left and a cropped card edge at right; no text in the top 48px.",
      tokens: { ground: INK, base: PAPER, primary: FOIL, secondary: FOIL_SOFT, accent: GRAPHITE, lightGround: PAPER },
      palette: identity.palette,
      typography: identity.typography,
      assets: identity.assets,
    },
    ...(previous.systems ?? []).filter((item) => item.slug !== "foil-standard"),
  ],
  system_status: {
    owner_selection: "selected",
    applied: previous.system_status?.applied ?? false,
    canonical_working_identity: "foil-standard",
    selected_at: new Date().toISOString(),
    note: "Foil Standard is the selected Foilbury identity. The application icon, cover and description are updated through the Discord application endpoint; the Loftwah guild icon remains unchanged.",
  },
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const selectionPath = path.join(kit, "selection.json");
const previousSelection = fs.existsSync(selectionPath) ? JSON.parse(fs.readFileSync(selectionPath, "utf8")) : {};
const selection = {
  ...previousSelection,
  schema: 2,
  selected_system: "foil-standard",
  decision: "selected",
  authority: "owner-directed",
  decided_at: new Date().toISOString(),
  decided_at_melbourne: new Intl.DateTimeFormat("en-AU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Australia/Melbourne",
  }).format(new Date()),
  rationale:
    "The owner asked for a Vercel-grade monochrome identity with Geist Serif. Foil Standard keeps Foilbury's card-fold idea, replaces the aqua/lime crypto palette with paper, ink and one foil-blue signal, and gives the product a consistent editorial voice from the public shelf to the admin tables.",
  applied: {
    ...(previousSelection.applied ?? {}),
    application_icon: previousSelection.applied?.application_icon?.status === "applied"
      ? previousSelection.applied.application_icon
      : {
          status: "prepared",
          note: "Generated at /brand/discord-avatar.png; apply through PATCH /applications/@me.",
        },
    application_cover_image: previousSelection.applied?.application_cover_image?.status === "applied"
      ? previousSelection.applied.application_cover_image
      : {
          status: "prepared",
          note: "Generated at /brand/kit/banners/foil-standard-1920x1080.png.",
        },
    application_description: previousSelection.applied?.application_description?.status === "applied"
      ? previousSelection.applied.application_description
      : {
          status: "prepared",
          note: "Product copy is updated separately when the application endpoint is applied.",
        },
    guild_icon: {
      status: "not_changed",
      reason: "The Loftwah guild icon belongs to the wider server identity.",
    },
    server_banner: {
      status: "blocked",
      reason: "The guild has no BANNER entitlement (Boost tier 2 is required).",
    },
    application_banner: {
      status: "manual",
      reason: "The bot profile banner is a Developer Portal surface.",
    },
  },
  alternatives_retained: ["signal-fold", "bastion", "aperture"],
  rollback: {
    application_icon: "Restore the previous Discord application icon from the archived Signal Fold asset at /brand/kit/signal-fold/mark-1024.png.",
    assets: "All historical systems remain under /brand/kit/ and the previous masters remain in git history.",
  },
};
fs.writeFileSync(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      identity: "foil-standard",
      out: ["public/brand", "public/brand/kit/foil-standard", "public/brand/kit/social", "public/brand/kit/banners"],
      fonts: Object.fromEntries(Object.entries(fontFiles).map(([name, file]) => [name, path.basename(file)])),
    },
    null,
    2,
  ),
);
