#!/usr/bin/env node
/**
 * Foilbury design-layer generator.
 *
 * Masters live in brand/masters and art/layers. This script rasterises the
 * authored vectors into PNG layers used by the local card renderer and the
 * live web card. It makes no network or provider requests.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const root = process.cwd();
const layerDir = path.join(root, "public/art/layers");
const brandDir = path.join(root, "public/brand");
const masterDir = path.join(root, "brand/masters");
for (const dir of [layerDir, brandDir, masterDir]) fs.mkdirSync(dir, { recursive: true });

const W = 750;
const H = 1050;
const ink = "#141512";
const paper = "#F4F0E6";
const brass = "#B08A52";
const green = "#245C4B";

function svg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

function grain(id = "grain", opacity = 0.18) {
  return `
  <filter id="${id}" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="7" result="noise"/>
    <feColorMatrix type="saturate" values="0" in="noise" result="mono"/>
    <feComponentTransfer in="mono"><feFuncA type="table" tableValues="0 ${opacity}"/></feComponentTransfer>
  </filter>`;
}

function frameSvg(material) {
  const palette = {
    plain: { edge: ink, inner: "#6E6657", glow: "#00000000", accent: brass },
    silver: { edge: "#6F767C", inner: "#E4E9EC", glow: "#C8CDD2", accent: "#8A9399" },
    gold: { edge: "#7C5A25", inner: "#F0CE86", glow: "#D6A54B", accent: "#F6E1AB" },
    diamond: { edge: "#3D6170", inner: "#D7EDF5", glow: "#BFD8E6", accent: "#8FB7C8" },
  }[material];
  const corner = (x, y, sx, sy) => `
    <g transform="translate(${x} ${y}) scale(${sx} ${sy})" fill="none" stroke="${palette.accent}" stroke-width="3">
      <path d="M0 54 V0 H54"/>
      <path d="M12 46 V12 H46" opacity=".55"/>
      <circle cx="18" cy="18" r="2.5" fill="${palette.accent}" stroke="none"/>
    </g>`;
  return svg(
    W,
    H,
    `${grain(`fg-${material}`, 0.13)}
    <rect x="0" y="0" width="${W}" height="${H}" rx="30" fill="none" stroke="${palette.edge}" stroke-width="30"/>
    <rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="18" fill="none" stroke="${palette.inner}" stroke-width="3"/>
    <rect x="30" y="30" width="${W - 60}" height="${H - 60}" rx="12" fill="none" stroke="${palette.edge}" stroke-width="1.2" opacity=".7"/>
    <rect x="0" y="0" width="${W}" height="${H}" filter="url(#fg-${material})" opacity=".5"/>
    ${corner(48, 48, 1, 1)}${corner(W - 48, 48, -1, 1)}${corner(48, H - 48, 1, -1)}${corner(W - 48, H - 48, -1, -1)}
    <path d="M96 ${H - 74} H${W - 96}" stroke="${palette.accent}" stroke-width="1" opacity=".45"/>
    <path d="M${W / 2 - 28} ${H - 62} h56" stroke="${palette.inner}" stroke-width="1" opacity=".5"/>`,
  );
}

function materialSvg(material) {
  if (material === "plain") {
    return svg(
      W,
      H,
      `${grain("paper", 0.28)}
      <rect width="${W}" height="${H}" fill="url(#paperWash)"/>
      <defs>
        <radialGradient id="paperWash" cx=".35" cy=".2" r=".9">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/>
          <stop offset=".58" stop-color="#d9cfbd" stop-opacity=".03"/>
          <stop offset="1" stop-color="#3b3328" stop-opacity=".14"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" filter="url(#paper)" opacity=".8"/>`,
    );
  }
  if (material === "silver") {
    const lines = Array.from({ length: 160 }, (_, i) => {
      const x = i * 5;
      return `<path d="M${x} 0 L${x - 140} ${H}" stroke="${i % 7 === 0 ? "#ffffff" : "#8c979e"}" stroke-width="${i % 13 === 0 ? 1.2 : 0.5}" opacity="${i % 5 === 0 ? 0.3 : 0.12}"/>`;
    }).join("");
    return svg(
      W,
      H,
      `<defs>
        <linearGradient id="silver" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f4f8fa"/><stop offset=".28" stop-color="#8f9ba2"/>
          <stop offset=".52" stop-color="#e9eff2"/><stop offset=".74" stop-color="#7f8a91"/>
          <stop offset="1" stop-color="#d5dde1"/>
        </linearGradient>
        <radialGradient id="sheen" cx=".22" cy=".18" r=".75">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".6"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#silver)" opacity=".34"/>
      ${lines}
      <rect width="${W}" height="${H}" fill="url(#sheen)" opacity=".35"/>`,
    );
  }
  if (material === "gold") {
    const rays = Array.from({ length: 54 }, (_, i) => {
      const x = (i / 53) * W;
      return `<path d="M${W / 2} ${H * 0.38} L${x} ${H}" stroke="${i % 3 === 0 ? "#ffe8b0" : "#7e5718"}" stroke-width="${i % 4 === 0 ? 1.4 : 0.55}" opacity="${i % 4 === 0 ? 0.3 : 0.12}"/>`;
    }).join("");
    return svg(
      W,
      H,
      `<defs>
        <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fbe7b4"/><stop offset=".22" stop-color="#9a6a22"/>
          <stop offset=".42" stop-color="#f7d58c"/><stop offset=".63" stop-color="#7d5216"/>
          <stop offset=".82" stop-color="#e8b95f"/><stop offset="1" stop-color="#fff0c4"/>
        </linearGradient>
        <radialGradient id="goldLight" cx=".3" cy=".2" r=".8">
          <stop offset="0" stop-color="#fff7d9" stop-opacity=".6"/><stop offset="1" stop-color="#fff7d9" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#gold)" opacity=".36"/>
      ${rays}
      <rect width="${W}" height="${H}" fill="url(#goldLight)" opacity=".5"/>
      <circle cx="${W * 0.78}" cy="${H * 0.2}" r="90" fill="#fff4ce" opacity=".12"/>`,
    );
  }
  const facets = [
    "M0 0 L330 0 L210 330 L0 520 Z",
    "M330 0 L750 0 L750 220 L520 360 L210 330 Z",
    "M0 520 L210 330 L520 360 L420 720 L0 1050 Z",
    "M750 220 L750 640 L520 760 L520 360 Z",
    "M420 720 L520 760 L750 640 L750 1050 L0 1050 Z",
    "M210 330 L520 360 L520 760 L420 720 Z",
  ];
  const colours = ["#dff4fb", "#9dc5d6", "#f7fcff", "#7ea9bb", "#c8e5ef", "#eaf8fc"];
  return svg(
    W,
    H,
    `<defs>
      <linearGradient id="dia" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8feff"/><stop offset=".5" stop-color="#8db8c9"/><stop offset="1" stop-color="#e9fbff"/></linearGradient>
      <filter id="soft"><feGaussianBlur stdDeviation="18"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#dia)" opacity=".3"/>
    ${facets.map((d, i) => `<path d="${d}" fill="${colours[i % colours.length]}" opacity="${0.06 + (i % 3) * 0.035}" stroke="#ffffff" stroke-width="1" stroke-opacity=".25"/>`).join("")}
    <path d="M110 0 L420 ${H}" stroke="#ffffff" stroke-width="34" opacity=".12" filter="url(#soft)"/>
    <path d="M600 0 L330 ${H}" stroke="#8fd7ee" stroke-width="20" opacity=".12" filter="url(#soft)"/>`,
  );
}

function effectSvg(effect) {
  if (effect === "holographic") {
    return svg(
      W,
      H,
      `<defs>
        <linearGradient id="holo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ff6e9f" stop-opacity=".7"/>
          <stop offset=".2" stop-color="#ffd166" stop-opacity=".55"/>
          <stop offset=".4" stop-color="#7bf1c8" stop-opacity=".5"/>
          <stop offset=".6" stop-color="#5db8ff" stop-opacity=".55"/>
          <stop offset=".8" stop-color="#b58cff" stop-opacity=".6"/>
          <stop offset="1" stop-color="#ff8ecf" stop-opacity=".65"/>
        </linearGradient>
        <filter id="blur"><feGaussianBlur stdDeviation="22"/></filter>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#holo)" opacity=".16"/>
      <g filter="url(#blur)" opacity=".85">
        <path d="M-100 210 L850 40 L850 310 L-100 540 Z" fill="url(#holo)"/>
        <path d="M-100 620 L850 450 L850 650 L-100 820 Z" fill="url(#holo)" opacity=".7"/>
      </g>
      <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="24" fill="none" stroke="url(#holo)" stroke-width="8" opacity=".65"/>
      <g stroke="#ffffff" stroke-opacity=".2" stroke-width="1">
        ${Array.from({ length: 12 }, (_, i) => `<path d="M${-80 + i * 78} 0 L${120 + i * 78} ${H}"/>`).join("")}
      </g>`,
    );
  }
  return svg(
    W,
    H,
    `<defs>
      <linearGradient id="prism" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#8cf5ff" stop-opacity=".7"/>
        <stop offset=".33" stop-color="#f7ff8c" stop-opacity=".55"/>
        <stop offset=".66" stop-color="#ff8fc9" stop-opacity=".55"/>
        <stop offset="1" stop-color="#b698ff" stop-opacity=".65"/>
      </linearGradient>
      <filter id="blur2"><feGaussianBlur stdDeviation="16"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#prism)" opacity=".14"/>
    <g filter="url(#blur2)" opacity=".8">
      <path d="M-50 760 L800 100 L850 210 L0 880 Z" fill="url(#prism)"/>
      <path d="M-50 220 L800 880 L760 980 L-90 330 Z" fill="url(#prism)" opacity=".7"/>
    </g>
    <rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="24" fill="none" stroke="url(#prism)" stroke-width="7" opacity=".6"/>`,
  );
}

const mark = (fill = ink, card = paper, accent = brass) => `
  <rect width="512" height="512" rx="112" fill="${fill}"/>
  <path d="M148 116 H330 L388 174 V396 H148 Z" fill="${card}"/>
  <path d="M330 116 L388 174 H330 Z" fill="${accent}"/>
  <path d="M206 200 H304 M206 254 H282 M206 308 H304" stroke="${fill}" stroke-width="24" stroke-linecap="square"/>
  <rect x="148" y="116" width="240" height="280" fill="none" stroke="${accent}" stroke-width="3" opacity=".7"/>`;

const markSvg = (fill = ink, card = paper, accent = brass) =>
  svg(512, 512, mark(fill, card, accent));
const markTransparentSvg = (stroke = ink) =>
  svg(512, 512, `<path d="M148 116 H330 L388 174 V396 H148 Z" fill="none" stroke="${stroke}" stroke-width="18"/><path d="M206 200 H304 M206 254 H282 M206 308 H304" stroke="${stroke}" stroke-width="24"/><path d="M330 116 L388 174 H330 Z" fill="${stroke}"/>`);

const wordmarkSvg = (fill = ink, accent = brass) =>
  svg(
    1200,
    300,
    `<text x="24" y="172" font-family="Fraunces" font-size="150" font-weight="600" letter-spacing="10" fill="${fill}">FOILBURY</text>
     <path d="M28 220 H850" stroke="${accent}" stroke-width="3"/>
     <text x="30" y="264" font-family="IBM Plex Mono" font-size="25" letter-spacing="8" fill="${fill}" opacity=".72">COLLECTORS' CABINET</text>
     <path d="M1110 74 L1150 34 L1150 114 L1110 154 Z" fill="${accent}"/>
     <path d="M1096 128 L1136 88 L1136 168 L1096 208 Z" fill="${accent}" opacity=".45"/>`,
  );

const cardBackSvg = svg(
  W,
  H,
  `<defs>
    <pattern id="guilloche" width="120" height="120" patternUnits="userSpaceOnUse">
      <circle cx="60" cy="60" r="52" fill="none" stroke="${brass}" stroke-width=".8" opacity=".35"/>
      <circle cx="0" cy="0" r="52" fill="none" stroke="${brass}" stroke-width=".7" opacity=".22"/>
      <circle cx="120" cy="120" r="52" fill="none" stroke="${brass}" stroke-width=".7" opacity=".22"/>
      <path d="M0 60 H120 M60 0 V120" stroke="${brass}" stroke-width=".35" opacity=".18"/>
    </pattern>
    ${grain("backGrain", 0.18)}
  </defs>
  <rect width="${W}" height="${H}" fill="${ink}"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="url(#guilloche)" opacity=".6"/>
  <rect x="38" y="38" width="${W - 76}" height="${H - 76}" rx="12" fill="none" stroke="${brass}" stroke-width="1.2" opacity=".7"/>
  <rect x="48" y="48" width="${W - 96}" height="${H - 96}" rx="8" fill="none" stroke="${paper}" stroke-width=".7" opacity=".25"/>
  <g transform="translate(${W / 2 - 140} 310) scale(.55)">${mark(ink, paper, brass)}</g>
  <text x="${W / 2}" y="650" text-anchor="middle" font-family="Fraunces" font-size="58" letter-spacing="10" fill="${paper}">FOILBURY</text>
  <text x="${W / 2}" y="700" text-anchor="middle" font-family="IBM Plex Mono" font-size="16" letter-spacing="5" fill="${brass}">CABINET COPY · KEEP CLOSE</text>
  <path d="M210 760 H540" stroke="${brass}" stroke-width="1" opacity=".55"/>
  <rect width="${W}" height="${H}" filter="url(#backGrain)" opacity=".7"/>`,
);

function rasterizeSvg(content, width) {
  const renderer = new Resvg(content, {
    fitTo: { mode: "width", value: width },
    font: {
      fontFiles: [
        path.join(root, "art/fonts/Fraunces.ttf"),
        path.join(root, "art/fonts/Manrope.ttf"),
        path.join(root, "art/fonts/IBMPlexMono-Regular.ttf"),
        path.join(root, "art/fonts/IBMPlexMono-SemiBold.ttf"),
      ],
      loadSystemFonts: false,
      defaultFontFamily: "Manrope",
    },
    background: "rgba(0,0,0,0)",
  });
  return renderer.render().asPng();
}

async function writeSvg(file, content, width) {
  const svgPath = path.join(masterDir, file);
  fs.writeFileSync(svgPath, content);
  const pngPath = path.join(layerDir, file.replace(/\.svg$/, ".png"));
  fs.writeFileSync(pngPath, rasterizeSvg(content, width));
  return pngPath;
}

for (const material of ["plain", "silver", "gold", "diamond"]) {
  await writeSvg(`material-${material}.svg`, materialSvg(material), W, H);
  await writeSvg(`frame-${material}.svg`, frameSvg(material), W, H);
}
for (const effect of ["holographic", "prismatic"]) {
  await writeSvg(`effect-${effect}.svg`, effectSvg(effect), W, H);
}
await writeSvg("card-back.svg", cardBackSvg, W, H);
await writeSvg("mark.svg", markSvg(), 512, 512);
await writeSvg("mark-mono.svg", markTransparentSvg(paper), 512, 512);
await writeSvg("wordmark.svg", wordmarkSvg(), 1200, 300);

// Brand exports
const markBuffer = Buffer.from(markSvg());
const monoBuffer = Buffer.from(markTransparentSvg(paper));
for (const [size, name] of [
  [16, "favicon-16.png"],
  [32, "favicon-32.png"],
  [48, "favicon-48.png"],
  [180, "apple-touch-icon.png"],
  [192, "icon-192.png"],
  [512, "icon-512.png"],
  [512, "discord-avatar.png"],
]) {
  await sharp(markBuffer).resize(size, size).png().toFile(path.join(brandDir, name));
}
// Maskable: mark inside an ink safe area
const maskable = svg(512, 512, `<rect width="512" height="512" fill="${ink}"/><g transform="translate(86 86) scale(.664)">${mark(ink, paper, brass)}</g>`);
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile(path.join(brandDir, "icon-512-maskable.png"));
await sharp(Buffer.from(maskable)).resize(192, 192).png().toFile(path.join(brandDir, "icon-192-maskable.png"));
await sharp(rasterizeSvg(wordmarkSvg(), 1200)).resize(1200, 300).png().toFile(path.join(brandDir, "wordmark.png"));
await sharp(rasterizeSvg(wordmarkSvg(paper, brass), 1200)).resize(1200, 300).png().toFile(path.join(brandDir, "wordmark-reverse.png"));
await sharp(monoBuffer).resize(512, 512).png().toFile(path.join(brandDir, "mark-mono.png"));
await sharp(fs.readFileSync(path.join(layerDir, "card-back.png"))).resize(1200, 1680).webp({ quality: 88 }).toFile(path.join(brandDir, "card-back.webp"));

// Social preview uses the authored card back until a real card render is available.
await sharp({
  create: { width: 1200, height: 630, channels: 4, background: paper },
})
  .composite([
    { input: Buffer.from(svg(1200, 630, `<rect width="1200" height="630" fill="${paper}"/><rect x="0" y="0" width="18" height="630" fill="${green}"/>`)) },
    { input: await sharp(path.join(layerDir, "card-back.png")).resize(354, 496).png().toBuffer(), left: 742, top: 70 },
    { input: await sharp(rasterizeSvg(wordmarkSvg(), 820)).resize(820, 205).png().toBuffer(), left: 84, top: 110 },
    {
      input: rasterizeSvg(
        svg(820, 180, `<text x="88" y="58" font-family="Manrope" font-weight="600" font-size="34" fill="${ink}">A collector's cabinet for characters worth keeping.</text><text x="88" y="116" font-family="IBM Plex Mono" font-size="19" letter-spacing="4" fill="${green}">EARN · COLLECT · TRADE · KEEP</text>`),
        820,
      ),
      left: 0,
      top: 280,
    },
  ])
  .jpeg({ quality: 90 })
  .toFile(path.join(brandDir, "social-preview.jpg"));

console.log(JSON.stringify({ layers: fs.readdirSync(layerDir).length, brand: fs.readdirSync(brandDir).length }, null, 2));
