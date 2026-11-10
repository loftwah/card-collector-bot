#!/usr/bin/env node
/**
 * Compose Foil Standard Open Graph and banner variants from the real mark,
 * wordmark and colours. These are brand assets, not character art: the mark,
 * type and rules are authored, and no card render is used as identity.
 *
 * Run: node art/brand-variants.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public/brand/variants");
const fonts = [
  path.join(root, ".foilbury/brand-fonts/GeistSerifVF.ttf"),
  path.join(root, ".foilbury/brand-fonts/GeistSansVF.ttf"),
  path.join(root, ".foilbury/brand-fonts/GeistMonoVF.ttf"),
];

const PAPER = "#FAFAF8";
const PANEL = "#FFFFFF";
const INK = "#0A0A0A";
const GRAPHITE = "#5B5B57";
const RULE = "#E4E4DF";
const FOIL = "#1F5EFF";

const glyph = (x, y, size, fill, shadow = FOIL) => `
  <g transform="translate(${x} ${y}) scale(${size / 200})">
    <path d="M56 48h108l12 12v28H96v28h64v40H96v60H56z" transform="translate(12 12)" fill="${shadow}"/>
    <path d="M56 48h108l12 12v28H96v28h64v40H96v60H56z" fill="${fill}"/>
  </g>`;

function cardPlane(
  x,
  y,
  w,
  h,
  { fill = PANEL, rule = RULE, edge = FOIL, mark = false, markFill = INK } = {},
) {
  const hh = Math.round((h * 7) / 5);
  void hh;
  return `
    <g transform="translate(${x} ${y})">
      <rect width="${w}" height="${h}" fill="${fill}" stroke="${rule}" stroke-width="1.5"/>
      <rect x="0" y="0" width="4" height="${h}" fill="${edge}"/>
      ${mark ? glyph(w / 2 - w * 0.19, h / 2 - w * 0.19, w * 0.38, markFill) : ""}
    </g>`;
}

function ogPaper() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect x="0" y="0" width="1200" height="1" fill="${RULE}"/>
  <rect x="0" y="629" width="1200" height="1" fill="${RULE}"/>
  ${glyph(72, 58, 54, INK)}
  <text x="140" y="96" font-family="Geist Serif VF" font-size="30" fill="${INK}">Foilbury</text>
  <text x="72" y="236" font-family="Geist Serif VF" font-size="86" letter-spacing="-3" fill="${INK}">Characters</text>
  <text x="72" y="322" font-family="Geist Serif VF" font-size="86" letter-spacing="-3" fill="${INK}">worth keeping.</text>
  <text x="72" y="382" font-family="Geist" font-size="25" fill="${GRAPHITE}">A free collectible-card cabinet for original worlds.</text>
  <rect x="72" y="424" width="260" height="4" fill="${FOIL}"/>
  <text x="72" y="520" font-family="Geist Mono" font-size="15" letter-spacing="4" fill="${GRAPHITE}">FREE TO PLAY · PUBLIC SHELF · MEMBER ALBUM</text>
  <text x="72" y="556" font-family="Geist Mono" font-size="17" letter-spacing="1" fill="${INK}">foilbury.loftwah.com</text>
  <g transform="translate(806 74) rotate(-6 140 196)">
    ${cardPlane(0, 0, 280, 392, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(846 62) rotate(4 140 196)">
    ${cardPlane(0, 0, 280, 392, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(820 92) rotate(-1 140 196)">
    ${cardPlane(0, 0, 280, 392, { fill: PANEL, mark: true })}
    <text x="34" y="330" font-family="Geist Mono" font-size="11" letter-spacing="3" fill="${GRAPHITE}">PUBLIC SHELF · 001</text>
    <rect x="34" y="350" width="58" height="3" fill="${FOIL}"/>
  </g>
</svg>`;
}

function ogInk() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${INK}"/>
  ${glyph(72, 58, 54, PAPER)}
  <text x="140" y="96" font-family="Geist Serif VF" font-size="30" fill="${PAPER}">Foilbury</text>
  <text x="72" y="236" font-family="Geist Serif VF" font-size="86" letter-spacing="-3" fill="${PAPER}">Characters</text>
  <text x="72" y="322" font-family="Geist Serif VF" font-size="86" letter-spacing="-3" fill="${PAPER}">worth keeping.</text>
  <text x="72" y="382" font-family="Geist" font-size="25" fill="#A3A39E">A free collectible-card cabinet for original worlds.</text>
  <rect x="72" y="424" width="260" height="4" fill="${FOIL}"/>
  <text x="72" y="520" font-family="Geist Mono" font-size="15" letter-spacing="4" fill="#A3A39E">FREE TO PLAY · PUBLIC SHELF · MEMBER ALBUM</text>
  <text x="72" y="556" font-family="Geist Mono" font-size="17" letter-spacing="1" fill="${PAPER}">foilbury.loftwah.com</text>
  <g transform="translate(806 74) rotate(-6 140 196)">
    ${cardPlane(0, 0, 280, 392, { fill: "#141414", rule: "#2A2A2A", edge: RULE })}
  </g>
  <g transform="translate(846 62) rotate(4 140 196)">
    ${cardPlane(0, 0, 280, 392, { fill: "#141414", rule: "#2A2A2A", edge: RULE })}
  </g>
  <g transform="translate(820 92) rotate(-1 140 196)">
    ${cardPlane(0, 0, 280, 392, { fill: "#111111", rule: "#2A2A2A", mark: true, markFill: PAPER })}
    <text x="34" y="330" font-family="Geist Mono" font-size="11" letter-spacing="3" fill="#A3A39E">PUBLIC SHELF · 001</text>
    <rect x="34" y="350" width="58" height="3" fill="${FOIL}"/>
  </g>
</svg>`;
}

function ogIndex() {
  const cards = [];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = 628 + col * 132;
      const y = 84 + row * 234;
      const active = row === 0 && col === 2;
      cards.push(
        cardPlane(x, y, 104, 146, {
          fill: active ? PANEL : "none",
          edge: active ? FOIL : RULE,
          rule: active ? RULE : RULE,
          mark: active,
        }),
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <g stroke="${RULE}" stroke-width="1">
    <line x1="0" y1="80" x2="1200" y2="80"/>
    <line x1="0" y1="550" x2="1200" y2="550"/>
    <line x1="584" y1="0" x2="584" y2="630"/>
  </g>
  ${glyph(72, 30, 36, INK)}
  <text x="120" y="58" font-family="Geist Mono" font-size="14" letter-spacing="4" fill="${GRAPHITE}">FOILBURY · PUBLIC SHELF</text>
  <text x="72" y="214" font-family="Geist Serif VF" font-size="64" letter-spacing="-2" fill="${INK}">Characters</text>
  <text x="72" y="282" font-family="Geist Serif VF" font-size="64" letter-spacing="-2" fill="${INK}">worth keeping.</text>
  <text x="72" y="338" font-family="Geist" font-size="22" fill="${GRAPHITE}">A free collectible-card cabinet</text>
  <text x="72" y="368" font-family="Geist" font-size="22" fill="${GRAPHITE}">for original worlds.</text>
  <rect x="72" y="410" width="180" height="4" fill="${FOIL}"/>
  <text x="72" y="596" font-family="Geist Mono" font-size="16" letter-spacing="1" fill="${INK}">foilbury.loftwah.com</text>
  ${cards.join("\n")}
</svg>`;
}

function bannerInk() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${INK}"/>
  ${glyph(120, 108, 96, PAPER)}
  <text x="240" y="176" font-family="Geist Serif VF" font-size="54" fill="${PAPER}">Foilbury</text>
  <text x="120" y="470" font-family="Geist Serif VF" font-size="136" letter-spacing="-5" fill="${PAPER}">Characters</text>
  <text x="120" y="606" font-family="Geist Serif VF" font-size="136" letter-spacing="-5" fill="${PAPER}">worth keeping.</text>
  <text x="120" y="704" font-family="Geist" font-size="38" fill="#A3A39E">A free collectible-card cabinet for original worlds.</text>
  <rect x="120" y="772" width="420" height="6" fill="${FOIL}"/>
  <text x="120" y="900" font-family="Geist Mono" font-size="22" letter-spacing="7" fill="#A3A39E">FREE TO PLAY · PUBLIC SHELF · MEMBER ALBUM</text>
  <text x="120" y="956" font-family="Geist Mono" font-size="26" letter-spacing="2" fill="${PAPER}">foilbury.loftwah.com</text>
  <g transform="translate(1290 120) rotate(-6 210 294)">
    ${cardPlane(0, 0, 420, 588, { fill: "#141414", rule: "#2A2A2A", edge: RULE })}
  </g>
  <g transform="translate(1350 100) rotate(4 210 294)">
    ${cardPlane(0, 0, 420, 588, { fill: "#141414", rule: "#2A2A2A", edge: RULE })}
  </g>
  <g transform="translate(1310 156) rotate(-1 210 294)">
    ${cardPlane(0, 0, 420, 588, { fill: "#111111", rule: "#2A2A2A", mark: true, markFill: PAPER })}
    <text x="52" y="500" font-family="Geist Mono" font-size="17" letter-spacing="5" fill="#A3A39E">PUBLIC SHELF · 001</text>
    <rect x="52" y="530" width="88" height="5" fill="${FOIL}"/>
  </g>
</svg>`;
}

function bannerPaper() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${PAPER}"/>
  ${glyph(120, 108, 96, INK)}
  <text x="240" y="176" font-family="Geist Serif VF" font-size="54" fill="${INK}">Foilbury</text>
  <text x="120" y="470" font-family="Geist Serif VF" font-size="136" letter-spacing="-5" fill="${INK}">Characters</text>
  <text x="120" y="606" font-family="Geist Serif VF" font-size="136" letter-spacing="-5" fill="${INK}">worth keeping.</text>
  <text x="120" y="704" font-family="Geist" font-size="38" fill="${GRAPHITE}">A free collectible-card cabinet for original worlds.</text>
  <rect x="120" y="772" width="420" height="6" fill="${FOIL}"/>
  <text x="120" y="900" font-family="Geist Mono" font-size="22" letter-spacing="7" fill="${GRAPHITE}">FREE TO PLAY · PUBLIC SHELF · MEMBER ALBUM</text>
  <text x="120" y="956" font-family="Geist Mono" font-size="26" letter-spacing="2" fill="${INK}">foilbury.loftwah.com</text>
  <g transform="translate(1290 120) rotate(-6 210 294)">
    ${cardPlane(0, 0, 420, 588, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(1350 100) rotate(4 210 294)">
    ${cardPlane(0, 0, 420, 588, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(1310 156) rotate(-1 210 294)">
    ${cardPlane(0, 0, 420, 588, { fill: PANEL, mark: true })}
    <text x="52" y="500" font-family="Geist Mono" font-size="17" letter-spacing="5" fill="${GRAPHITE}">PUBLIC SHELF · 001</text>
    <rect x="52" y="530" width="88" height="5" fill="${FOIL}"/>
  </g>
</svg>`;
}

function shareSquare() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <rect width="1080" height="1080" fill="${PAPER}"/>
  ${glyph(72, 64, 64, INK)}
  <text x="168" y="116" font-family="Geist Serif VF" font-size="34" fill="${INK}">Foilbury</text>
  <text x="72" y="356" font-family="Geist Serif VF" font-size="96" letter-spacing="-4" fill="${INK}">Characters</text>
  <text x="72" y="452" font-family="Geist Serif VF" font-size="96" letter-spacing="-4" fill="${INK}">worth keeping.</text>
  <text x="72" y="520" font-family="Geist" font-size="28" fill="${GRAPHITE}">A free collectible-card cabinet</text>
  <text x="72" y="556" font-family="Geist" font-size="28" fill="${GRAPHITE}">for original worlds.</text>
  <rect x="72" y="606" width="260" height="5" fill="${FOIL}"/>
  <text x="72" y="1000" font-family="Geist Mono" font-size="16" letter-spacing="4" fill="${GRAPHITE}">FREE TO PLAY · FOILBURY.LOFTWAH.COM</text>
  <g transform="translate(700 620) rotate(-6 160 224)">
    ${cardPlane(0, 0, 320, 448, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(650 660) rotate(2 160 224)">
    ${cardPlane(0, 0, 320, 448, { fill: PANEL, mark: true })}
    <text x="38" y="380" font-family="Geist Mono" font-size="13" letter-spacing="4" fill="${GRAPHITE}">PUBLIC SHELF</text>
    <rect x="38" y="402" width="70" height="4" fill="${FOIL}"/>
  </g>
</svg>`;
}

function sharePortrait() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <rect width="1080" height="1350" fill="${INK}"/>
  ${glyph(72, 72, 64, PAPER)}
  <text x="168" y="124" font-family="Geist Serif VF" font-size="34" fill="${PAPER}">Foilbury</text>
  <text x="72" y="360" font-family="Geist Serif VF" font-size="100" letter-spacing="-4" fill="${PAPER}">Characters</text>
  <text x="72" y="460" font-family="Geist Serif VF" font-size="100" letter-spacing="-4" fill="${PAPER}">worth keeping.</text>
  <text x="72" y="530" font-family="Geist" font-size="28" fill="#A3A39E">A free collectible-card cabinet for original worlds.</text>
  <rect x="72" y="580" width="260" height="5" fill="${FOIL}"/>
  <g transform="translate(290 700) rotate(-1 250 350)">
    ${cardPlane(0, 0, 500, 700, { fill: "#111111", rule: "#2A2A2A", mark: true, markFill: PAPER })}
    <text x="60" y="600" font-family="Geist Mono" font-size="18" letter-spacing="5" fill="#A3A39E">PUBLIC SHELF · 001</text>
    <rect x="60" y="628" width="90" height="5" fill="${FOIL}"/>
  </g>
  <text x="72" y="1280" font-family="Geist Mono" font-size="18" letter-spacing="4" fill="#A3A39E">FREE TO PLAY · FOILBURY.LOFTWAH.COM</text>
</svg>`;
}

function shareStory() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <rect width="1080" height="1920" fill="${PAPER}"/>
  ${glyph(72, 80, 64, INK)}
  <text x="168" y="132" font-family="Geist Serif VF" font-size="34" fill="${INK}">Foilbury</text>
  <text x="72" y="460" font-family="Geist Serif VF" font-size="128" letter-spacing="-6" fill="${INK}">Characters</text>
  <text x="72" y="594" font-family="Geist Serif VF" font-size="128" letter-spacing="-6" fill="${INK}">worth</text>
  <text x="72" y="728" font-family="Geist Serif VF" font-size="128" letter-spacing="-6" fill="${INK}">keeping.</text>
  <text x="72" y="812" font-family="Geist" font-size="32" fill="${GRAPHITE}">A free collectible-card cabinet</text>
  <text x="72" y="856" font-family="Geist" font-size="32" fill="${GRAPHITE}">for original worlds.</text>
  <rect x="72" y="916" width="300" height="6" fill="${FOIL}"/>
  <g transform="translate(88 1130) rotate(-7 170 238)">
    ${cardPlane(0, 0, 340, 476, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(360 1100) rotate(3 170 238)">
    ${cardPlane(0, 0, 340, 476, { fill: PAPER, edge: RULE })}
  </g>
  <g transform="translate(300 1160) rotate(-1 170 238)">
    ${cardPlane(0, 0, 340, 476, { fill: PANEL, mark: true })}
    <text x="40" y="404" font-family="Geist Mono" font-size="13" letter-spacing="4" fill="${GRAPHITE}">PUBLIC SHELF</text>
    <rect x="40" y="428" width="74" height="4" fill="${FOIL}"/>
  </g>
  <text x="72" y="1820" font-family="Geist Mono" font-size="18" letter-spacing="4" fill="${GRAPHITE}">FREE TO PLAY · FOILBURY.LOFTWAH.COM</text>
</svg>`;
}

function iconSquare(bg, fg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${bg}"/>
  ${glyph(106, 106, 300, fg)}
</svg>`;
}

function render(name, width, height, svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: "Geist" },
  });
  const png = resvg.render().asPng();
  return { name, width, height, png };
}

await mkdir(outDir, { recursive: true });
const outputs = [
  render("og-paper", 1200, 630, ogPaper()),
  render("og-ink", 1200, 630, ogInk()),
  render("og-index", 1200, 630, ogIndex()),
  render("banner-paper", 1920, 1080, bannerPaper()),
  render("banner-ink", 1920, 1080, bannerInk()),
  render("share-square-1080", 1080, 1080, shareSquare()),
  render("share-portrait-1080x1350", 1080, 1350, sharePortrait()),
  render("share-story-1080x1920", 1080, 1920, shareStory()),
  render("icon-paper-512", 512, 512, iconSquare(PAPER, INK)),
  render("icon-ink-512", 512, 512, iconSquare(INK, PAPER)),
];

for (const output of outputs) {
  await writeFile(path.join(outDir, `${output.name}.png`), output.png);
  console.log(`${output.name}.png · ${output.width}x${output.height} · ${output.png.length} bytes`);
}
