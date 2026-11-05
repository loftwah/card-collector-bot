#!/usr/bin/env node
// Reproducible vector outlines and destination-sized icons for the local
// Foilbury colophon candidate. No network calls and no source-art changes.
import fs from "node:fs";
import path from "node:path";
import { create } from "fontkitten";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { createHash } from "node:crypto";

const output = "public/brand/kit/colophon";
fs.mkdirSync(output, { recursive: true });
const original = create(fs.readFileSync("public/fonts/Fraunces.ttf"));
if (original.isCollection) throw new Error("Expected the bundled Fraunces font, not a collection");
const font = original.getVariation({ wght: 600, opsz: 72, SOFT: 30, WONK: 0 });
function shapes(text, tracking = 0) {
  let x = 0,
    minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  const parts = [];
  for (const character of text) {
    const g = font.glyphForCodePoint(character.codePointAt(0));
    parts.push({ g, x });
    minX = Math.min(minX, x + g.bbox.minX);
    maxX = Math.max(maxX, x + g.bbox.maxX);
    minY = Math.min(minY, g.bbox.minY);
    maxY = Math.max(maxY, g.bbox.maxY);
    x += g.advanceWidth + tracking;
  }
  return { parts, minX, maxX, minY, maxY };
}
function paths(parts) {
  return parts
    .map(({ g, x }) => `<path transform="translate(${x} 0)" d="${g.path.toSVG()}"/>`)
    .join("");
}
const monogram = shapes("F");
const word = shapes("Foilbury", 30);
function iconSvg({ background = true, maskable = false, ink = "#f7f5ef" } = {}) {
  // A serif monogram on a 5:7 card with a second card visible behind it.
  // The letter is knocked out in transparent exports, not painted with a
  // guessed background colour. Maskable exports inset the whole emblem.
  const scale = Math.min(
    180 / (monogram.maxX - monogram.minX),
    250 / (monogram.maxY - monogram.minY),
  );
  const cx = (monogram.minX + monogram.maxX) / 2,
    cy = (monogram.minY + monogram.maxY) / 2;
  const knockout = `<g transform="translate(${256 - cx * scale} ${262 + cy * scale}) scale(${scale} -${scale})">${paths(monogram.parts)}</g>`;
  const cards = `<rect x="126" y="82" width="248" height="347" rx="10" transform="rotate(-9 250 255)"/><rect x="139" y="82" width="248" height="347" rx="10"/>`;
  const mask = `<mask id="letter" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="white"/><g fill="black">${knockout}</g></mask>`;
  const emblem = background
    ? `<rect x="126" y="82" width="248" height="347" rx="10" fill="#84978a" transform="rotate(-9 250 255)"/><rect x="139" y="82" width="248" height="347" rx="10" fill="${ink}"/><g fill="#27332e">${knockout}</g>`
    : `<g fill="${ink}" mask="url(#letter)">${cards}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Foilbury"><title>Foilbury card colophon</title>${mask}${background ? `<rect width="512" height="512" ${maskable ? "" : 'rx="36"'} fill="#27332e"/>` : ""}<g${maskable ? ' transform="translate(51.2 51.2) scale(.8)"' : ""}>${emblem}</g></svg>\n`;
}
function wordSvg(ink = "currentColor") {
  let pad = 40,
    w = word.maxX - word.minX + pad * 2,
    h = word.maxY - word.minY + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false"><g fill="${ink}" transform="translate(${pad - word.minX} ${pad + word.maxY}) scale(1 -1)">${paths(word.parts)}</g></svg>\n`;
}
const sources = {
  "mark.svg": iconSvg(),
  "mark-transparent.svg": iconSvg({ background: false, ink: "#27332e" }),
  "mark-reverse.svg": iconSvg({ background: false, ink: "#f7f5ef" }),
  "maskable.svg": iconSvg({ maskable: true }),
  "wordmark.svg": wordSvg(),
  "wordmark-ink.svg": wordSvg("#27332e"),
  "wordmark-reverse.svg": wordSvg("#f7f5ef"),
};
const manropeSource = create(fs.readFileSync("public/fonts/Manrope.ttf"));
if (manropeSource.isCollection) throw new Error("Expected the bundled Manrope font");
function socialLine(face, text, x, y, height, colour) {
  let advance = 0,
    minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  const parts = [];
  for (const character of text) {
    const glyph = face.glyphForCodePoint(character.codePointAt(0));
    if (glyph.path.commands.length) {
      parts.push({ g: glyph, x: advance });
      minX = Math.min(minX, advance + glyph.bbox.minX);
      maxX = Math.max(maxX, advance + glyph.bbox.maxX);
      minY = Math.min(minY, glyph.bbox.minY);
      maxY = Math.max(maxY, glyph.bbox.maxY);
    }
    advance += glyph.advanceWidth;
  }
  const scale = height / (maxY - minY);
  return `<g fill="${colour}" transform="translate(${x - minX * scale} ${y + maxY * scale}) scale(${scale} -${scale})">${paths(parts)}</g>`;
}
const innerSvg = (svg) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const socialMark = (suffix) =>
  innerSvg(sources["mark.svg"])
    .replace('id="letter"', `id="social-letter-${suffix}"`)
    .replaceAll("url(#letter)", `url(#social-letter-${suffix})`);
const wordWidth = word.maxX - word.minX + 80;
const wordHeight = word.maxY - word.minY + 80;
const socialTitle = manropeSource.getVariation({ wght: 700 });
const socialBody = manropeSource.getVariation({ wght: 500 });
sources["social-master.svg"] =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><title>Foilbury: a home for your cards</title><rect width="1200" height="630" fill="#f2efe8"/><g aria-hidden="true"><rect x="-126" y="110" width="280" height="392" rx="13" fill="#d8e2d7" transform="rotate(-10 14 306)"/><rect x="1040" y="108" width="280" height="392" rx="13" fill="#e5d5c9" transform="rotate(11 1180 304)"/></g><svg x="380" y="82" width="230" height="60" viewBox="0 0 ${wordWidth} ${wordHeight}">${innerSvg(sources["wordmark-ink.svg"])}</svg><svg x="300" y="75" width="64" height="64" viewBox="0 0 512 512">${socialMark("header")}</svg>${socialLine(socialTitle, "A home for", 300, 230, 64, "#27332e")}${socialLine(socialTitle, "your cards.", 300, 320, 64, "#27332e")}<g transform="translate(235 50) scale(.75)" aria-hidden="true"><rect x="714" y="206" width="150" height="210" rx="8" fill="#b6c6ba" transform="rotate(-11 789 311)"/><rect x="728" y="199" width="150" height="210" rx="8" fill="#d0bcae" transform="rotate(9 803 304)"/><rect x="721" y="198" width="150" height="210" rx="8" fill="#27332e"/><svg x="746" y="252" width="100" height="100" viewBox="0 0 512 512">${socialMark("card")}</svg></g><path d="M300 491 H900" stroke="#b7c0b6" stroke-width="1"/>${socialLine(socialBody, "Free to play", 300, 528, 28, "#52615a")}</svg>\n`;
for (const [name, body] of Object.entries(sources)) fs.writeFileSync(path.join(output, name), body);
const raster = async (svg, size, name) => {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  await sharp(png).resize(size, size).png().toFile(path.join(output, name));
};
for (const [name, size] of [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["favicon-48.png", 48],
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["discord-avatar-1024.png", 1024],
])
  await raster(sources["mark.svg"], size, name);
for (const size of [192, 512])
  await raster(sources["maskable.svg"], size, `icon-${size}-maskable.png`);
fs.writeFileSync(
  path.join(output, "social-preview.png"),
  new Resvg(sources["social-master.svg"]).render().asPng(),
);
const files = fs
  .readdirSync(output)
  .filter((n) => n !== "manifest.json")
  .sort();
const manifest = {
  schema: 1,
  status: "local-candidate",
  decision: "agent-authored; not owner approval",
  font: "Fraunces, The Fraunces Project Authors, SIL Open Font License 1.1",
  font_source: "public/fonts/Fraunces.ttf",
  social_font: "Manrope, The Manrope Project Authors, SIL Open Font License 1.1",
  social_font_source: "public/fonts/Manrope.ttf",
  social_note:
    "Vector-only provisional social image; no character artwork or invented card contents.",
  generator: "scripts/brand/generate-colophon.mjs",
  settings: {
    wght: 600,
    opsz: 72,
    SOFT: 30,
    WONK: 0,
    monogram: "F on 5:7 card with second card",
    wordmarkTracking: 30,
    background: "#27332e",
    foreground: "#f7f5ef",
  },
  files: files.map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(fs.readFileSync(path.join(output, name)))
      .digest("hex"),
  })),
};
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
