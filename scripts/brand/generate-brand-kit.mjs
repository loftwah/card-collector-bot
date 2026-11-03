#!/usr/bin/env node
/**
 * Generate the reviewed Foilbury core identity options and Discord-ready kit.
 *
 * The marks are original geometric SVGs. PNG renditions are captured in real
 * Chromium with the self-hosted Manrope face so wordmarks do not silently fall
 * back to a system font. Nothing here uses paid generation or third-party art.
 *
 *   node scripts/brand/generate-brand-kit.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const outRoot = path.join("public", "brand", "kit");
fs.mkdirSync(outRoot, { recursive: true });

const ink = "#07110f";
const paper = "#eff5f1";
const aqua = "#00c8b8";
const aquaBright = "#2ce3d3";
const ice = "#c8f4ee";
const lime = "#c9f25f";
const deep = "#044e4a";

const marks = {
  "signal-fold": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Foilbury Signal Fold mark">
    <rect width="256" height="256" fill="${ink}"/>
    <path d="M48 52h160v38H96v30h82v38H96v58H48z" fill="${paper}"/>
    <path d="M150 52h58v38h-58z" fill="${aqua}"/>
    <path d="M150 120h58v38h-58z" fill="${lime}"/>
    <path d="M48 176h102v-38H48z" fill="${aquaBright}" opacity=".72"/>
  </svg>`,
  bastion: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Foilbury Bastion mark">
    <rect width="256" height="256" fill="${deep}"/>
    <path d="M44 40h168v44H44z" fill="${paper}"/>
    <path d="M44 106h112v44H44z" fill="${paper}"/>
    <path d="M44 172h168v44H44z" fill="${lime}"/>
    <path d="M176 106h36v44h-36z" fill="${aquaBright}"/>
    <path d="M44 40h36v176H44z" fill="${aqua}"/>
  </svg>`,
  aperture: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Foilbury Aperture mark">
    <rect width="256" height="256" fill="${ink}"/>
    <circle cx="128" cy="128" r="92" fill="none" stroke="${aqua}" stroke-width="18"/>
    <path d="M128 36a92 92 0 0 1 78 49l-78 43z" fill="${paper}"/>
    <path d="M206 174a92 92 0 0 1-78 46v-95z" fill="${lime}"/>
    <path d="M50 174a92 92 0 0 1 0-92l78 46z" fill="${aquaBright}"/>
    <circle cx="128" cy="128" r="24" fill="${ink}" stroke="${paper}" stroke-width="8"/>
  </svg>`,
  index: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Foilbury Index mark">
    <rect width="256" height="256" fill="${paper}"/>
    <path d="M28 28h200v200H28z" fill="none" stroke="${ink}" stroke-width="12"/>
    <path d="M68 64h124v32H68z" fill="${ink}"/>
    <path d="M68 112h76v32H68z" fill="${ink}"/>
    <path d="M68 160h124v32H68z" fill="${aqua}"/>
    <path d="M148 112h44v32h-44z" fill="${lime}"/>
    <path d="M28 28h72v72H28z" fill="${aquaBright}"/>
  </svg>`,
};

const palettes = {
  current: { bg: deep, fg: paper, accent: aquaBright, second: lime },
  ice: { bg: ice, fg: ink, accent: deep, second: aqua },
  signal: { bg: aqua, fg: ink, accent: ink, second: lime },
  carbon: { bg: ink, fg: paper, accent: lime, second: aquaBright },
};

function markSvg(name, palette = "current", background = true) {
  const p = palettes[palette] ?? palettes.current;
  let body = marks[name] ?? marks["signal-fold"];
  // Re-colour the reviewed masters by replacing the core fills only. The
  // geometry is unchanged, so this is a palette rendition, not a new mark.
  body = body
    .replaceAll(ink, p.bg === ink ? p.fg : p.bg)
    .replaceAll(paper, p.fg)
    .replaceAll(aquaBright, p.accent)
    .replaceAll(aqua, p.accent)
    .replaceAll(lime, p.second)
    .replaceAll(deep, p.bg);
  if (!background) body = body.replace(/<rect width="256" height="256"[^>]*\/>/, "");
  return body;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function wordmarkSvg(text = "FOILBURY", color = ink, accent = aqua) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 400">
    <rect x="24" y="110" width="180" height="180" fill="${accent}"/>
    <path d="M68 150h108v26H98v22h54v26H98v50H68z" fill="${color}"/>
    <text x="250" y="262" font-family="Manrope, sans-serif" font-weight="800" font-size="178" letter-spacing="-8" fill="${color}">${escapeXml(text)}</text>
    <text x="256" y="316" font-family="ui-monospace, monospace" font-size="20" letter-spacing="9" fill="${color}" opacity=".7">A COLLECTOR'S CABINET</text>
  </svg>`;
}

function embedMark(mark) {
  return mark.replace("<svg ", '<svg width="256" height="256" ');
}

function avatarSvg(mark, palette, label) {
  const p = palettes[palette];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${p.bg}"/>
    <circle cx="256" cy="230" r="170" fill="none" stroke="${p.accent}" stroke-width="3" opacity=".45"/>
    <g transform="translate(128 92)">${embedMark(markSvg(mark, palette, false))}</g>
    <rect x="0" y="430" width="512" height="82" fill="${p.fg}" opacity=".08"/>
    <text x="256" y="474" text-anchor="middle" font-family="Manrope, sans-serif" font-weight="800" font-size="28" letter-spacing="10" fill="${p.fg}">${escapeXml(label)}</text>
  </svg>`;
}

function bannerSvg(option) {
  const p = palettes[option.palette];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
    ${option.reverse ? `<rect width="960" height="540" fill="${p.bg}"/>` : `<rect width="960" height="540" fill="${p.bg}"/>`}
    <path d="M0 0h960v540H0z" fill="url(#grid)" opacity=".22"/>
    <defs>
      <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
        <path d="M48 0H0V48" fill="none" stroke="${p.accent}" stroke-width="1"/>
      </pattern>
    </defs>
    <g transform="translate(56 84) scale(0.8)">${embedMark(markSvg(option.mark, option.palette, false))}</g>
    <text x="310" y="220" font-family="Manrope, sans-serif" font-weight="800" font-size="104" letter-spacing="-6" fill="${p.fg}">FOILBURY</text>
    <text x="316" y="276" font-family="Manrope, sans-serif" font-weight="650" font-size="24" letter-spacing="0.5" fill="${p.fg}" opacity=".82">A collector's cabinet for</text>
    <text x="316" y="308" font-family="Manrope, sans-serif" font-weight="650" font-size="24" letter-spacing="0.5" fill="${p.fg}" opacity=".82">characters worth keeping.</text>
    <rect x="316" y="338" width="210" height="9" fill="${p.accent}"/>
    <rect x="538" y="338" width="96" height="9" fill="${p.second}"/>
    <text x="316" y="408" font-family="ui-monospace, monospace" font-size="14" letter-spacing="5" fill="${p.fg}" opacity=".62">FREE TO PLAY · MEMBER ALBUM</text>
    <text x="316" y="432" font-family="ui-monospace, monospace" font-size="14" letter-spacing="5" fill="${p.fg}" opacity=".62">ORIGINAL WORLDS</text>
    <text x="900" y="490" text-anchor="end" font-family="ui-monospace, monospace" font-size="13" letter-spacing="3" fill="${p.fg}" opacity=".55">FOILBURY.LOFTWAH.COM</text>
  </svg>`;
}

const options = [
  { slug: "signal-fold", mark: "signal-fold", label: "Signal Fold", note: "Stacked planes and a folded foil edge. The most direct expression of a card being handled." },
  { slug: "bastion", mark: "bastion", label: "Bastion", note: "A heavy architectural F. Reads clearly at 32px and holds up as a server stamp." },
  { slug: "aperture", mark: "aperture", label: "Aperture", note: "A circular card aperture with three foil planes. Softer, more collectible, still geometric." },
  { slug: "index", mark: "index", label: "Index", note: "A catalogue index with a cropped corner. The most editorial of the four." },
];

const manifest = { generated_at: new Date().toISOString(), palette: { ink, paper, aqua, aquaBright, ice, lime, deep }, marks: [], avatars: [], banners: [], wordmarks: [], social: [] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const manropeBase64 = fs.readFileSync(path.join("public", "fonts", "manrope-latin.woff2")).toString("base64");

async function renderPng(svg, file, width, height, transparent = false, background = ink) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manropeBase64}') format('woff2');font-weight:200 800}
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? "transparent" : background}}
    svg{display:block;width:${width}px;height:${height}px}
  </style></head><body>${svg}</body></html>`;
  fs.mkdirSync(path.dirname(path.join(outRoot, file)), { recursive: true });
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(outRoot, file), omitBackground: transparent });
}

for (const option of options) {
  const dir = path.join(option.slug);
  fs.mkdirSync(path.join(outRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(outRoot, dir, "mark.svg"), marks[option.mark]);
  await renderPng(marks[option.mark], path.join(dir, "mark-1024.png"), 1024, 1024);
  await renderPng(marks[option.mark], path.join(dir, "mark-512.png"), 512, 512);
  await renderPng(marks[option.mark], path.join(dir, "mark-256.png"), 256, 256);
  for (const palette of ["current", "ice", "signal", "carbon"]) {
    await renderPng(avatarSvg(option.mark, palette, "FOILBURY"), path.join(dir, `avatar-${palette}-512.png`), 512, 512);
  }
  manifest.marks.push({ slug: option.slug, label: option.label, note: option.note, svg: `/brand/kit/${option.slug}/mark.svg`, png: `/brand/kit/${option.slug}/mark-1024.png`, avatars: ["current", "ice", "signal", "carbon"].map((palette) => `/brand/kit/${option.slug}/avatar-${palette}-512.png`) });
}

const bannerOptions = [
  { slug: "grid-signal", mark: "signal-fold", palette: "carbon", label: "Grid Signal" },
  { slug: "aqua-field", mark: "bastion", palette: "signal", label: "Aqua Field" },
  { slug: "ice-cabinet", mark: "index", palette: "ice", label: "Ice Cabinet" },
  { slug: "aperture-night", mark: "aperture", palette: "current", label: "Aperture Night" },
];
for (const option of bannerOptions) {
  await renderPng(bannerSvg(option), path.join("banners", `${option.slug}-960x540.png`), 960, 540);
  await renderPng(bannerSvg(option), path.join("banners", `${option.slug}-1920x1080.png`), 1920, 1080);
  manifest.banners.push({ slug: option.slug, label: option.label, discord: `/brand/kit/banners/${option.slug}-960x540.png`, social: `/brand/kit/banners/${option.slug}-1920x1080.png` });
}

const wordmarks = [
  { slug: "signal", text: "FOILBURY", color: ink, accent: aqua, label: "Signal wordmark" },
  { slug: "reverse", text: "FOILBURY", color: paper, accent: aquaBright, label: "Reverse wordmark" },
  { slug: "lime", text: "FOILBURY", color: ink, accent: lime, label: "Signal Lime wordmark" },
  { slug: "editorial", text: "Foilbury", color: ink, accent: deep, label: "Editorial wordmark" },
];
for (const option of wordmarks) {
  const svg = wordmarkSvg(option.text, option.color, option.accent);
  fs.mkdirSync(path.join(outRoot, "wordmarks"), { recursive: true });
  fs.writeFileSync(path.join(outRoot, "wordmarks", `${option.slug}.svg`), svg);
  const previewBg = option.slug === "reverse" ? ink : paper;
  await renderPng(svg, path.join("wordmarks", `${option.slug}-1600x400.png`), 1600, 400, false, previewBg);
  await renderPng(svg, path.join("wordmarks", `${option.slug}-transparent-1600x400.png`), 1600, 400, true);
  manifest.wordmarks.push({ slug: option.slug, label: option.label, svg: `/brand/kit/wordmarks/${option.slug}.svg`, png: `/brand/kit/wordmarks/${option.slug}-1600x400.png`, transparent: `/brand/kit/wordmarks/${option.slug}-transparent-1600x400.png` });
}

const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${ink}"/>
  <path d="M0 0h1200v630H0z" fill="url(#g)" opacity=".3"/>
  <defs><pattern id="g" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="${aqua}" stroke-width="1"/></pattern></defs>
  <g transform="translate(76 86) scale(0.82)">${embedMark(markSvg("signal-fold", "carbon", false))}</g>
  <text x="360" y="232" font-family="Manrope, sans-serif" font-weight="800" font-size="122" letter-spacing="-7" fill="${paper}">FOILBURY</text>
  <text x="366" y="302" font-family="Manrope, sans-serif" font-weight="650" font-size="32" fill="${ice}">Characters worth keeping.</text>
  <rect x="366" y="342" width="300" height="12" fill="${aqua}"/>
  <rect x="678" y="342" width="130" height="12" fill="${lime}"/>
  <text x="366" y="430" font-family="ui-monospace, monospace" font-size="19" letter-spacing="5" fill="${paper}" opacity=".7">FREE TO PLAY · MEMBER ALBUM · ORIGINAL WORLDS</text>
  <text x="366" y="520" font-family="ui-monospace, monospace" font-size="20" letter-spacing="3" fill="${aqua}">foilbury.loftwah.com</text>
</svg>`;
await renderPng(ogSvg, "social/og-1200x630.png", 1200, 630);
await renderPng(ogSvg, "social/hero-1920x1080.png", 1920, 1080);
manifest.social.push({ slug: "og", label: "Open Graph / social preview", png: "/brand/kit/social/og-1200x630.png", dimensions: "1200x630" });
manifest.social.push({ slug: "hero", label: "Website / social hero", png: "/brand/kit/social/hero-1920x1080.png", dimensions: "1920x1080" });

await browser.close();
// The three owner-selectable systems are generated by
// generate-brand-systems.mjs. Preserve them when the base kit is regenerated,
// otherwise `pnpm brand:generate` would silently remove the selection board's
// manifest entries.
const manifestPath = path.join(outRoot, "manifest.json");
if (fs.existsSync(manifestPath)) {
  const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (previous.systems) manifest.systems = previous.systems;
  if (previous.system_status) manifest.system_status = previous.system_status;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, outRoot, marks: manifest.marks.length, avatars: manifest.marks.length * 4, banners: manifest.banners.length * 2, wordmarks: manifest.wordmarks.length * 3, social: manifest.social.length }, null, 2));
