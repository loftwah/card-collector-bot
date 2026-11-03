#!/usr/bin/env node
/**
 * Generate the three owner-selectable Foilbury identity systems.
 *
 * This is additive to scripts/brand/generate-brand-kit.mjs. It reuses the
 * reviewed mark geometry, recolours it per system, and builds purpose-made
 * 16:9 banners plus circular-crop icon variants. Every raster is a deterministic
 * Chromium capture of local SVG. No model, paid provider or third-party art is
 * involved.
 *
 *   node scripts/brand/generate-brand-systems.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const outRoot = path.join("public", "brand", "kit", "systems");
const manifestPath = path.join("public", "brand", "kit", "manifest.json");
fs.mkdirSync(outRoot, { recursive: true });

const systems = [
  {
    slug: "signal-fold",
    index: "01",
    label: "Signal Fold",
    kicker: "Precision field",
    tagline: "Folded planes, filed precisely.",
    note: "The reviewed Signal Fold geometry, completed as a system: carbon field, bone card planes, electric aqua signal and one lime edge.",
    rationale:
      "Signal Fold is the closest to the current working identity, but it is not a recolour. The icon is a tight circular-crop cut of the folded-card mark; the banner is a measured field of card edges crossing a grid, with no stretched avatar and no embedded type. It reads as a cabinet instrument rather than a generic game badge.",
    strengths: [
      "The F-like cut-card silhouette survives 32px without microtype.",
      "Highest contrast of the three on a dark Discord field.",
      "Icon and banner share the same offset-plane logic, so the pair feels authored together.",
    ],
    watchouts: [
      "Closest to the incumbent identity; the owner may want a sharper break.",
      "Aqua and lime are strong signals and need discipline outside the mark.",
      "The fine field grid is deliberately absent at thumbnail size.",
    ],
    smallSize:
      "The mark reduces to a blocky F silhouette. The one lime edge is the only colour detail required at 32px.",
    bannerLogic:
      "A horizontal fold of card edges with a single notch, held by a quiet 48px top band. No logo or text is embedded.",
    palette: {
      ground: "#07110f",
      base: "#eff5f1",
      primary: "#2ce3d3",
      secondary: "#c9f25f",
      accent: "#044e4a",
      quiet: "#8fb7b0",
      lightGround: "#eff5f1",
      lightBase: "#07110f",
      lightPrimary: "#00776e",
      lightSecondary: "#5f7f10",
      lightAccent: "#044e4a",
    },
    swatches: [
      { name: "Carbon", hex: "#07110f", role: "field and banner ground" },
      { name: "Bone", hex: "#eff5f1", role: "card planes and light type" },
      { name: "Electric aqua", hex: "#2ce3d3", role: "primary signal" },
      { name: "Signal lime", hex: "#c9f25f", role: "one high-energy edge" },
      { name: "Deep current", hex: "#044e4a", role: "quiet structural plane" },
    ],
    contrast: [
      { pair: "Bone on carbon", fg: "#eff5f1", bg: "#07110f" },
      { pair: "Electric aqua on carbon", fg: "#2ce3d3", bg: "#07110f" },
      { pair: "Signal lime on carbon", fg: "#c9f25f", bg: "#07110f" },
    ],
    typography: {
      display: "Manrope 780, tight tracking, uppercase for decisions only.",
      interface: "Geist Sans for UI; Geist Mono for dimensions, serials and provenance.",
      licensing: "Manrope and Geist are self-hosted under the SIL Open Font License 1.1.",
    },
  },
  {
    slug: "bastion",
    index: "02",
    label: "Bastion",
    kicker: "Architectural weight",
    tagline: "A cabinet built to outlast the collection.",
    note: "A heavy architectural F, recast as a cabinet wall in oxblood, plaster and brass.",
    rationale:
      "Bastion treats the identity as furniture rather than software: plaster mass, brass seams and an oxblood field. The reviewed block geometry is kept, but the system is carried by a monumental wall in the banner instead of a repeated logo. It is the most formal option and the clearest break from the current aqua field.",
    strengths: [
      "Strongest silhouette at 32px; every edge is a broad plane.",
      "Warm archival palette is clearly distinct from the current working identity.",
      "No hairline detail is required for recognition or compression.",
    ],
    watchouts: [
      "Oxblood is heavy; member surfaces need the light variant for balance.",
      "Brass must stay a seam, never a gloss or a metallic gradient.",
      "The banner carries more visual weight than the other two; test it behind the server title.",
    ],
    smallSize:
      "Three heavy horizontal bars and a solid vertical stem remain unambiguous in a circular crop. No fine detail is required.",
    bannerLogic:
      "A masonry wall of offset plaster courses with brass piers, cropped at the right edge. The top 48px stays flat oxblood.",
    palette: {
      ground: "#2a1214",
      base: "#efe2ca",
      primary: "#c99a4b",
      secondary: "#e0b878",
      accent: "#8f3a2f",
      quiet: "#a08b76",
      lightGround: "#efe2ca",
      lightBase: "#2a1214",
      lightPrimary: "#7a4f1f",
      lightSecondary: "#8f3a2f",
      lightAccent: "#5e2a22",
    },
    swatches: [
      { name: "Oxblood", hex: "#2a1214", role: "field and banner ground" },
      { name: "Plaster", hex: "#efe2ca", role: "structural bars and lite type" },
      { name: "Brass", hex: "#c99a4b", role: "seams and one plinth line" },
      { name: "Brick", hex: "#8f3a2f", role: "single inset accent" },
      { name: "Stone", hex: "#a08b76", role: "quiet secondary detail" },
    ],
    contrast: [
      { pair: "Plaster on oxblood", fg: "#efe2ca", bg: "#2a1214" },
      { pair: "Brass on oxblood", fg: "#c99a4b", bg: "#2a1214" },
      { pair: "Oxblood on plaster", fg: "#2a1214", bg: "#efe2ca" },
    ],
    typography: {
      display: "Manrope 780, wide negative space, uppercase for decisions only.",
      interface: "Geist Sans for UI; Geist Mono for catalogue labels and provenance.",
      licensing: "Manrope and Geist are self-hosted under the SIL Open Font License 1.1.",
    },
  },
  {
    slug: "aperture",
    index: "03",
    label: "Aperture",
    kicker: "Optical night",
    tagline: "A lens for the card you keep.",
    note: "The circular card window and three foil planes, moved into a midnight blueprint palette with one vermilion signal.",
    rationale:
      "Aperture is the most collectible of the three: a circular card window with three foil planes, held in a midnight blueprint field with a vermilion accent. It is the only direction whose geometry is already native to Discord's circular crop. The banner is a large cropped lens with a quiet top band, not an enlarged avatar.",
    strengths: [
      "Native to the circular avatar crop; the ring defines the edge.",
      "Distinct from Signal Fold's F and Bastion's architecture.",
      "One warm accent cuts the night field without a glow.",
    ],
    watchouts: [
      "The most detailed geometry; inspect the exported 32px proof, not only the vector.",
      "Vermilion is an accent, never a generic warning or success colour.",
      "The large banner lens needs clear space around the centre hole.",
    ],
    smallSize:
      "The outer ring, three wedge planes and open centre survive at 32px. The central hole keeps the silhouette from becoming a solid dot.",
    bannerLogic:
      "A large lens cropped by the right edge, built from the same three wedge planes as the icon. The left field carries only quiet arc echoes.",
    palette: {
      ground: "#0c1626",
      base: "#e7edf3",
      primary: "#7ea8c4",
      secondary: "#e4573f",
      accent: "#9bc3d9",
      quiet: "#6c849b",
      lightGround: "#e9eef4",
      lightBase: "#0c1626",
      lightPrimary: "#3f6f91",
      lightSecondary: "#b93b28",
      lightAccent: "#5d8fae",
    },
    swatches: [
      { name: "Midnight", hex: "#0c1626", role: "field and banner ground" },
      { name: "Frost", hex: "#e7edf3", role: "upper foil plane and lite type" },
      { name: "Blueprint", hex: "#7ea8c4", role: "ring and secondary plane" },
      { name: "Vermilion", hex: "#e4573f", role: "one warm signal plane" },
      { name: "Pale steel", hex: "#9bc3d9", role: "third plane and quiet detail" },
    ],
    contrast: [
      { pair: "Frost on midnight", fg: "#e7edf3", bg: "#0c1626" },
      { pair: "Vermilion on midnight", fg: "#e4573f", bg: "#0c1626" },
      { pair: "Midnight on frost", fg: "#0c1626", bg: "#e7edf3" },
    ],
    typography: {
      display: "Manrope 780, optical spacing, uppercase for decisions only.",
      interface: "Geist Sans for UI; Geist Mono for catalogue labels and provenance.",
      licensing: "Manrope and Geist are self-hosted under the SIL Open Font License 1.1.",
    },
  },
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function paletteFor(system, mode) {
  const p = system.palette;
  if (mode === "light") {
    return {
      ground: p.lightGround,
      base: p.lightBase,
      primary: p.lightPrimary,
      secondary: p.lightSecondary,
      accent: p.lightAccent,
      quiet: p.quiet,
      hole: p.lightGround,
      overlayOpacity: "1",
    };
  }
  if (mode === "mono-dark") {
    return {
      ground: "none",
      base: "#07110f",
      primary: "#07110f",
      secondary: "#07110f",
      accent: "#07110f",
      quiet: "#07110f",
      hole: "#07110f",
      overlayOpacity: "1",
    };
  }
  if (mode === "mono-light") {
    return {
      ground: "none",
      base: "#eff5f1",
      primary: "#eff5f1",
      secondary: "#eff5f1",
      accent: "#eff5f1",
      quiet: "#eff5f1",
      hole: "#eff5f1",
      overlayOpacity: "1",
    };
  }
  return {
    ground: p.ground,
    base: p.base,
    primary: p.primary,
    secondary: p.secondary,
    accent: p.accent,
    quiet: p.quiet,
    hole: p.ground,
    overlayOpacity: "0.72",
  };
}

function geometry(system, c) {
  if (system.slug === "signal-fold") {
    return `
    <path d="M48 52h160v38H96v30h82v38H96v58H48z" fill="${c.base}"/>
    <path d="M150 52h58v38h-58z" fill="${c.primary}"/>
    <path d="M150 120h58v38h-58z" fill="${c.secondary}"/>
    <path d="M48 176h102v-38H48z" fill="${c.primary}" opacity="${c.overlayOpacity}"/>`;
  }
  if (system.slug === "bastion") {
    return `
    <path d="M44 40h168v44H44z" fill="${c.base}"/>
    <path d="M44 106h112v44H44z" fill="${c.base}"/>
    <path d="M44 172h168v44H44z" fill="${c.secondary}"/>
    <path d="M176 106h36v44h-36z" fill="${c.accent}"/>
    <path d="M44 40h36v176H44z" fill="${c.primary}"/>`;
  }
  return `
    <circle cx="128" cy="128" r="92" fill="none" stroke="${c.primary}" stroke-width="18"/>
    <path d="M128 36a92 92 0 0 1 78 49l-78 43z" fill="${c.base}"/>
    <path d="M206 174a92 92 0 0 1-78 46v-95z" fill="${c.secondary}"/>
    <path d="M50 174a92 92 0 0 1 0-92l78 46z" fill="${c.accent}"/>
    <circle cx="128" cy="128" r="24" fill="${c.hole}" stroke="${c.base}" stroke-width="8"/>`;
}

function markSvg(system, mode = "default", background = true) {
  const c = paletteFor(system, mode);
  const field = background && c.ground !== "none" ? `<rect width="256" height="256" fill="${c.ground}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Foilbury ${escapeXml(system.label)} mark">${field}${geometry(system, c)}</svg>`;
}

function iconSvg(system, mode = "default", background = true) {
  const c = paletteFor(system, mode);
  const scale = 1.55;
  const offset = (512 - 256 * scale) / 2;
  const field = background && c.ground !== "none" ? `<rect width="512" height="512" fill="${c.ground}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Foilbury ${escapeXml(system.label)} app icon">${field}<g transform="translate(${offset} ${offset}) scale(${scale})">${geometry(system, c)}</g></svg>`;
}

function pointOnCircle(cx, cy, radius, degrees) {
  const angle = (degrees * Math.PI) / 180;
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

function annularBlade(cx, cy, inner, outer, start, end) {
  const [x1, y1] = pointOnCircle(cx, cy, inner, start);
  const [x2, y2] = pointOnCircle(cx, cy, outer, start);
  const [x3, y3] = pointOnCircle(cx, cy, outer, end);
  const [x4, y4] = pointOnCircle(cx, cy, inner, end);
  const large = Math.abs(end - start) > 180 ? 1 : 0;
  const outward = end > start ? 1 : 0;
  const inward = end > start ? 0 : 1;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}A${outer} ${outer} 0 ${large} ${outward} ${x3.toFixed(2)} ${y3.toFixed(2)}L${x4.toFixed(2)} ${y4.toFixed(2)}A${inner} ${inner} 0 ${large} ${inward} ${x1.toFixed(2)} ${y1.toFixed(2)}Z`;
}

function bannerSvg(system) {
  if (system.slug === "signal-fold") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" role="img" aria-label="Foilbury Signal Fold banner">
      <rect width="1920" height="1080" fill="#07110f"/>
      <defs>
        <pattern id="field" width="96" height="96" patternUnits="userSpaceOnUse">
          <path d="M96 0H0V96" fill="none" stroke="#2ce3d3" stroke-width="1" opacity=".16"/>
        </pattern>
        <mask id="quiet-top"><rect x="0" y="96" width="1920" height="984" fill="#fff"/></mask>
      </defs>
      <rect x="0" y="96" width="1920" height="984" fill="url(#field)" mask="url(#quiet-top)" opacity=".7"/>
      <path d="M140 448h1640" stroke="#2ce3d3" stroke-width="2" opacity=".36"/>
      <path d="M140 448v36M1780 448v36" stroke="#2ce3d3" stroke-width="1" opacity=".3"/>
      <g>
        <path d="M140 520H860V880H140Z" fill="#eff5f1"/>
        <path d="M860 520 1760 448V808L860 880Z" fill="#044e4a"/>
        <path d="M860 520V880" stroke="#2ce3d3" stroke-width="14"/>
        <path d="M1760 448V808" stroke="#c9f25f" stroke-width="14"/>
        <rect x="260" y="604" width="320" height="168" fill="#07110f"/>
        <rect x="580" y="604" width="28" height="168" fill="#2ce3d3"/>
        <rect x="260" y="792" width="200" height="10" fill="#2ce3d3" opacity=".8"/>
        <path d="M960 560h640M960 604h540M960 648h600M960 692h420" stroke="#eff5f1" stroke-width="2" opacity=".16"/>
        <rect x="960" y="740" width="240" height="12" fill="#c9f25f"/>
        <path d="M1560 760h120" stroke="#eff5f1" stroke-width="2" opacity=".32"/>
      </g>
      <g opacity=".45">
        <path d="M140 972h180" stroke="#eff5f1" stroke-width="2"/>
        <path d="M1600 972h180" stroke="#eff5f1" stroke-width="2"/>
        <path d="M320 960v24M1600 960v24" stroke="#eff5f1" stroke-width="2"/>
      </g>
    </svg>`;
  }

  if (system.slug === "bastion") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" role="img" aria-label="Foilbury Bastion banner">
      <rect width="1920" height="1080" fill="#2a1214"/>
      <defs>
        <mask id="quiet-top"><rect x="0" y="96" width="1920" height="984" fill="#fff"/></mask>
      </defs>
      <g mask="url(#quiet-top)">
        <path d="M300 96v680M460 96v680M620 96v680" stroke="#efe2ca" stroke-width="1" opacity=".12"/>
        <rect x="1240" y="96" width="680" height="984" fill="#35181a"/>
        <rect x="1240" y="96" width="1" height="984" fill="#c99a4b" opacity=".5"/>
        <rect x="1300" y="176" width="58" height="904" fill="#c99a4b"/>
        <rect x="1380" y="176" width="420" height="132" fill="#efe2ca"/>
        <rect x="1380" y="340" width="304" height="132" fill="#efe2ca"/>
        <rect x="1380" y="504" width="420" height="132" fill="#c99a4b"/>
        <rect x="1380" y="668" width="224" height="132" fill="#efe2ca"/>
        <rect x="1636" y="668" width="164" height="132" fill="#8f3a2f"/>
        <rect x="1380" y="832" width="420" height="132" fill="#efe2ca"/>
        <rect x="1380" y="994" width="420" height="86" fill="#2a1214"/>
        <rect x="140" y="736" width="760" height="16" fill="#c99a4b"/>
        <rect x="140" y="776" width="460" height="128" fill="#efe2ca"/>
        <rect x="632" y="776" width="128" height="128" fill="#8f3a2f"/>
        <rect x="140" y="936" width="300" height="14" fill="#efe2ca" opacity=".32"/>
      </g>
    </svg>`;
  }

  const lens = annularBlade(1460, 660, 180, 500, -110, -20);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" role="img" aria-label="Foilbury Aperture banner">
    <rect width="1920" height="1080" fill="#0c1626"/>
    <defs>
      <mask id="quiet-top"><rect x="0" y="96" width="1920" height="984" fill="#fff"/></mask>
    </defs>
    <g mask="url(#quiet-top)">
      <g fill="none" stroke="#7ea8c4" opacity=".16">
        <circle cx="300" cy="660" r="150" stroke-width="1"/>
        <circle cx="300" cy="660" r="230" stroke-width="1"/>
        <circle cx="300" cy="660" r="310" stroke-width="1"/>
      </g>
      <circle cx="1460" cy="660" r="500" fill="#101f33"/>
      <circle cx="1460" cy="660" r="500" fill="none" stroke="#7ea8c4" stroke-width="10" opacity=".55"/>
      <path d="${lens}" fill="#e7edf3"/>
      <path d="${annularBlade(1460, 660, 180, 500, 10, 100)}" fill="#9bc3d9"/>
      <path d="${annularBlade(1460, 660, 180, 500, 130, 220)}" fill="#e4573f"/>
      <circle cx="1460" cy="660" r="150" fill="none" stroke="#7ea8c4" stroke-width="2" opacity=".45"/>
      <circle cx="1460" cy="660" r="110" fill="#0c1626" stroke="#e7edf3" stroke-width="14"/>
      <circle cx="1460" cy="660" r="48" fill="none" stroke="#7ea8c4" stroke-width="3" opacity=".7"/>
      <path d="M0 900h440" stroke="#e4573f" stroke-width="8"/>
      <path d="M140 952h220" stroke="#7ea8c4" stroke-width="2" opacity=".5"/>
      <path d="M0 660h940" stroke="#7ea8c4" stroke-width="1" opacity=".18"/>
    </g>
  </svg>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function renderPng(svg, file, width, height, transparent = false) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;background:${transparent ? "transparent" : "#07110f"}}
    svg{display:block;width:${width}px;height:${height}px}
  </style></head><body>${svg}</body></html>`;
  fs.mkdirSync(path.dirname(path.join(outRoot, file)), { recursive: true });
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: path.join(outRoot, file), omitBackground: transparent });
}

function assetRecord(id, file, width, height, format, use) {
  const full = path.join(outRoot, file);
  const proofIds = new Set(["icon-512", "icon-128", "icon-64", "icon-32"]);
  const scope = id.startsWith("banner")
    ? id === "banner-960"
      ? "Server banner — entitlement required"
      : "Server banner source"
    : id === "mark-svg"
      ? "Reference vector"
      : proofIds.has(id)
        ? "Proof only"
        : "Application avatar";
  return {
    id,
    path: `/brand/kit/systems/${file}`,
    width,
    height,
    format,
    bytes: fs.statSync(full).size,
    use,
    scope,
  };
}

const manifestSystems = [];
for (const system of systems) {
  const dir = path.join(system.slug);
  fs.mkdirSync(path.join(outRoot, dir), { recursive: true });
  const folder = `${system.slug}`;
  const assets = [];

  const mark = markSvg(system);
  fs.writeFileSync(path.join(outRoot, dir, "mark.svg"), mark);
  assets.push(assetRecord("mark-svg", `${folder}/mark.svg`, 256, 256, "svg", "Vector mark master"));

  const icon = iconSvg(system);
  fs.writeFileSync(path.join(outRoot, dir, "icon.svg"), icon);
  assets.push(assetRecord("icon-svg", `${folder}/icon.svg`, 512, 512, "svg", "Vector app icon master"));

  const iconLight = iconSvg(system, "light");
  fs.writeFileSync(path.join(outRoot, dir, "icon-light.svg"), iconLight);
  assets.push(
    assetRecord("icon-light-svg", `${folder}/icon-light.svg`, 512, 512, "svg", "Vector positive-on-light icon"),
  );

  const iconTransparent = iconSvg(system, "default", false);
  fs.writeFileSync(path.join(outRoot, dir, "icon-transparent.svg"), iconTransparent);
  assets.push(
    assetRecord(
      "icon-transparent-svg",
      `${folder}/icon-transparent.svg`,
      512,
      512,
      "svg",
      "Vector transparent icon",
    ),
  );

  const iconMonoDark = iconSvg(system, "mono-dark", false);
  fs.writeFileSync(path.join(outRoot, dir, "icon-mono-dark.svg"), iconMonoDark);
  assets.push(
    assetRecord("icon-mono-dark-svg", `${folder}/icon-mono-dark.svg`, 512, 512, "svg", "Monochrome dark vector"),
  );

  const iconMonoLight = iconSvg(system, "mono-light", false);
  fs.writeFileSync(path.join(outRoot, dir, "icon-mono-light.svg"), iconMonoLight);
  assets.push(
    assetRecord("icon-mono-light-svg", `${folder}/icon-mono-light.svg`, 512, 512, "svg", "Monochrome light vector"),
  );

  await renderPng(icon, `${folder}/icon-1024.png`, 1024, 1024);
  assets.push(assetRecord("icon-1024", `${folder}/icon-1024.png`, 1024, 1024, "png", "Opaque app icon master"));
  await renderPng(icon, `${folder}/icon-512.png`, 512, 512);
  assets.push(assetRecord("icon-512", `${folder}/icon-512.png`, 512, 512, "png", "512px circular-crop proof"));
  await renderPng(icon, `${folder}/icon-128.png`, 128, 128);
  assets.push(assetRecord("icon-128", `${folder}/icon-128.png`, 128, 128, "png", "128px proof"));
  await renderPng(icon, `${folder}/icon-64.png`, 64, 64);
  assets.push(assetRecord("icon-64", `${folder}/icon-64.png`, 64, 64, "png", "Exact 64px proof"));
  await renderPng(icon, `${folder}/icon-32.png`, 32, 32);
  assets.push(assetRecord("icon-32", `${folder}/icon-32.png`, 32, 32, "png", "Exact 32px proof"));

  await renderPng(iconLight, `${folder}/icon-light-1024.png`, 1024, 1024);
  assets.push(
    assetRecord("icon-light-1024", `${folder}/icon-light-1024.png`, 1024, 1024, "png", "Positive variant on light ground"),
  );
  await renderPng(iconTransparent, `${folder}/icon-transparent-1024.png`, 1024, 1024, true);
  assets.push(
    assetRecord(
      "icon-transparent-1024",
      `${folder}/icon-transparent-1024.png`,
      1024,
      1024,
      "png",
      "Transparent opaque-colour variant",
    ),
  );
  await renderPng(iconMonoDark, `${folder}/icon-mono-dark-1024.png`, 1024, 1024, true);
  assets.push(
    assetRecord(
      "icon-mono-dark-1024",
      `${folder}/icon-mono-dark-1024.png`,
      1024,
      1024,
      "png",
      "Monochrome dark variant",
    ),
  );
  await renderPng(iconMonoLight, `${folder}/icon-mono-light-1024.png`, 1024, 1024, true);
  assets.push(
    assetRecord(
      "icon-mono-light-1024",
      `${folder}/icon-mono-light-1024.png`,
      1024,
      1024,
      "png",
      "Monochrome light variant",
    ),
  );

  const banner = bannerSvg(system);
  fs.writeFileSync(path.join(outRoot, dir, "banner.svg"), banner);
  assets.push(assetRecord("banner-svg", `${folder}/banner.svg`, 1920, 1080, "svg", "Vector banner master"));
  await renderPng(banner, `${folder}/banner-1920x1080.png`, 1920, 1080);
  assets.push(
    assetRecord("banner-1920", `${folder}/banner-1920x1080.png`, 1920, 1080, "png", "High-resolution banner master"),
  );
  await renderPng(banner, `${folder}/banner-960x540.png`, 960, 540);
  assets.push(
    assetRecord("banner-960", `${folder}/banner-960x540.png`, 960, 540, "png", "Discord server banner size"),
  );

  manifestSystems.push({
    slug: system.slug,
    index: system.index,
    label: system.label,
    kicker: system.kicker,
    tagline: system.tagline,
    note: system.note,
    rationale: system.rationale,
    strengths: system.strengths,
    watchouts: system.watchouts,
    smallSize: system.smallSize,
    bannerLogic: system.bannerLogic,
    tokens: {
      ground: system.palette.ground,
      base: system.palette.base,
      primary: system.palette.primary,
      secondary: system.palette.secondary,
      accent: system.palette.accent,
      lightGround: system.palette.lightGround,
    },
    palette: system.swatches,
    contrast: system.contrast.map((item) => {
      const lum = (hex) => {
        const channels = hex
          .slice(1)
          .match(/../g)
          .map((value) => parseInt(value, 16) / 255)
          .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const a = lum(item.fg);
      const b = lum(item.bg);
      return { ...item, ratio: Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)) };
    }),
    typography: system.typography,
    assets,
  });
}

await browser.close();

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.systems = manifestSystems;
manifest.system_status = {
  owner_selection: "pending",
  applied: false,
  canonical_working_identity: "signal-fold",
  generated_at: new Date().toISOString(),
  note:
    "Three complete systems are presented for owner selection. No Discord application avatar, guild icon or server banner was changed. The incumbent Signal Fold working identity remains in place until explicit owner approval.",
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify(
    {
      ok: true,
      outRoot,
      systems: manifestSystems.map((system) => ({
        slug: system.slug,
        assets: system.assets.length,
        iconBytes: system.assets.find((asset) => asset.id === "icon-1024")?.bytes,
        banner960Bytes: system.assets.find((asset) => asset.id === "banner-960")?.bytes,
      })),
    },
    null,
    2,
  ),
);
