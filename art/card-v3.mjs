#!/usr/bin/env node
/**
 * Foilbury card v3 proof.
 *
 * A full-bleed, subject-breakout card with a designed back. The image layers
 * are AI scene + AI subject + AI holo; the frame, nameplate. field note, stats,
 * provenance and back record are code. This is a proof of the v3 anatomy in
 * docs/CARD_ANATOMY.md, not a replacement for the shared composer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, ".foilbury/evidence/card-v3");
const outDir = path.join(root, "public/art/proofs");
const FINISH = (process.env.V3_FINISH ?? "holographic").toLowerCase();
const PLAIN = FINISH === "plain";
const suffix = PLAIN ? "-plain" : "";
const finishTitle = PLAIN ? "Plain" : "Holographic";
const fonts = [
  path.join(root, "art/fonts/Fraunces.ttf"),
  path.join(root, "art/fonts/Manrope.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-Regular.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-SemiBold.ttf"),
];

const W = 750;
const H = 1050;
const PAPER = "#FAFAF8";
const INK = "#0A0A0A";
const GRAPHITE = "#5B5B57";
const FOIL = "#1F5EFF";
const CREAM = "#F4F0E6";

function svgPng(svg, width = W) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: "Manrope" },
  });
  return resvg.render().asPng();
}

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const copy = {
  name: "TUX",
  role: "Root access",
  collection: "FIGHTER",
  classLine: "HERO · TECH",
  rarity: "RARE",
  finish: finishTitle.toUpperCase(),
  printCode: "FB-F-005",
  quote: "Every opening is a permissions bug.",
  bio: "A systems-minded fighter who treats the arena like a terminal and every opening like a permissions bug.",
  provenance: "PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT",
};

async function markPng() {
  return sharp(path.join(root, "public/art/collections/fighter.svg"))
    .resize(128, 128)
    .png()
    .toBuffer();
}

function frontBaseSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0a0a0a" stop-opacity="0.84"/>
        <stop offset="1" stop-color="#0a0a0a" stop-opacity="0.96"/>
      </linearGradient>
    </defs>
    <rect x="0" y="788" width="${W}" height="262" fill="url(#panel)"/>
    <rect x="0" y="786" width="${W}" height="2" fill="${FOIL}"/>
    <rect x="36" y="36" width="398" height="232" fill="#0a0a0a" fill-opacity="0.86" stroke="${CREAM}" stroke-width="1"/>
    <rect x="36" y="36" width="6" height="232" fill="${FOIL}"/>
    <rect x="558" y="36" width="156" height="112" fill="${PAPER}" fill-opacity="0.94"/>
    <rect x="558" y="36" width="156" height="4" fill="${FOIL}"/>
  </svg>`;
}

function frontTextSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="foilLine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#8BE9FF"/>
        <stop offset=".35" stop-color="${FOIL}"/>
        <stop offset=".7" stop-color="#B18CFF"/>
        <stop offset="1" stop-color="#E9FF8A"/>
      </linearGradient>
    </defs>

    <!-- class capsule -->
    <rect x="64" y="60" width="154" height="28" fill="${FOIL}"/>
    <text x="76" y="79" font-family="IBM Plex Mono" font-size="12" letter-spacing="2" fill="${CREAM}">${esc(copy.classLine)}</text>

    <!-- nameplate -->
    <text x="64" y="174" font-family="Fraunces" font-weight="600" font-size="94" letter-spacing="-3" fill="${CREAM}">${esc(copy.name)}</text>
    <text x="66" y="212" font-family="Manrope" font-weight="500" font-size="25" fill="${CREAM}">${esc(copy.role)}</text>
    <text x="66" y="244" font-family="IBM Plex Mono" font-size="11" letter-spacing="3" fill="${CREAM}" fill-opacity="0.82">SIGNAL KEEPER · ${esc(copy.collection)}</text>

    <!-- rarity / finish -->
    <text x="574" y="72" font-family="IBM Plex Mono" font-size="10" letter-spacing="2" fill="${GRAPHITE}">RARITY</text>
    <text x="574" y="106" font-family="Fraunces" font-weight="600" font-size="34" fill="${INK}">${esc(copy.rarity)}</text>
    <text x="574" y="128" font-family="IBM Plex Mono" font-size="12" letter-spacing="1.2" fill="${GRAPHITE}">${esc(copy.finish)}</text>
    <text x="574" y="144" font-family="IBM Plex Mono" font-size="9" letter-spacing="1" fill="${GRAPHITE}">${esc(copy.printCode)}</text>


    <!-- field note -->
    <text x="40" y="824" font-family="IBM Plex Mono" font-size="10" letter-spacing="3" fill="#A3A39E">FIELD NOTE</text>
    <text x="40" y="858" font-family="Fraunces" font-style="italic" font-size="23" fill="${CREAM}">${esc(copy.quote)}</text>

    <!-- field record -->
    <g font-family="IBM Plex Mono" font-size="9" letter-spacing="1.6" fill="#A3A39E">
      <text x="40" y="918">ROLE</text>
      <text x="190" y="918">SET</text>
      <text x="340" y="918">RARITY</text>
      <text x="488" y="918">FINISH</text>
    </g>
    <g font-family="Manrope" font-size="17" fill="${CREAM}">
      <text x="40" y="942">Root access</text>
      <text x="190" y="942">Fighter</text>
      <text x="340" y="942">Rare</text>
      <text x="488" y="942">${esc(finishTitle)}</text>
    </g>
    <line x1="40" y1="968" x2="710" y2="968" stroke="#5A5A56" stroke-width="1"/>
    <text x="40" y="1002" font-family="IBM Plex Mono" font-size="11" letter-spacing="1" fill="${CREAM}">${esc(copy.printCode)}</text>
    <text x="190" y="1002" font-family="IBM Plex Mono" font-size="8" letter-spacing="0.8" fill="#A3A39E">PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT</text>
    <text x="618" y="1002" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.5" fill="${CREAM}">FOILBURY</text>

    <!-- frame -->
    <rect x="8" y="8" width="734" height="1034" fill="none" stroke="${INK}" stroke-width="8"/>
    <rect x="16" y="16" width="718" height="1018" fill="none" stroke="${PLAIN ? "#8a8a84" : "url(#foilLine)"}" stroke-width="2"/>
    <g stroke="${CREAM}" stroke-width="2" fill="none">
      <path d="M24 58V24h34"/>
      <path d="M726 58V24h-34"/>
      <path d="M24 992v34h34"/>
      <path d="M726 992v34h-34"/>
    </g>

  </svg>`;
}

function backSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="backHolo" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#8BE9FF"/>
        <stop offset=".4" stop-color="${FOIL}"/>
        <stop offset=".7" stop-color="#B18CFF"/>
        <stop offset="1" stop-color="#E9FF8A"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${PAPER}"/>
    <rect x="0" y="0" width="${W}" height="6" fill="${INK}"/>
    <rect x="0" y="6" width="${W}" height="18" fill="${PLAIN ? "#b9b9b2" : "url(#backHolo)"}" fill-opacity="${PLAIN ? "0.5" : "0.28"}"/>
    <rect x="24" y="54" width="702" height="1" fill="#E4E4DF"/>

    <!-- header -->
    <text x="26" y="42" font-family="IBM Plex Mono" font-size="10" letter-spacing="3" fill="${GRAPHITE}">CARD RECORD · ${esc(copy.collection)}</text>
    <text x="724" y="42" text-anchor="end" font-family="IBM Plex Mono" font-size="10" letter-spacing="2" fill="${INK}">${esc(copy.printCode)}</text>

    <!-- portrait plate -->
    <rect x="40" y="86" width="210" height="260" fill="${INK}"/>
    <rect x="40" y="86" width="210" height="260" fill="none" stroke="${INK}" stroke-width="1"/>
    <text x="40" y="370" font-family="IBM Plex Mono" font-size="8" letter-spacing="1.6" fill="${GRAPHITE}">SIGNAL KEEPER · ORIGINAL ART</text>

    <!-- name block -->
    <text x="282" y="138" font-family="Fraunces" font-weight="600" font-size="64" letter-spacing="-2" fill="${INK}">${esc(copy.name)}</text>
    <text x="284" y="170" font-family="Manrope" font-weight="500" font-size="21" fill="${GRAPHITE}">${esc(copy.role)}</text>
    <line x1="284" y1="188" x2="710" y2="188" stroke="#E4E4DF" stroke-width="1"/>
    <text x="284" y="218" font-family="Fraunces" font-style="italic" font-size="19" fill="${INK}">${esc(copy.quote)}</text>

    <!-- bio -->
    <text x="284" y="258" font-family="Manrope" font-size="15" fill="${GRAPHITE}">A systems-minded fighter who treats the arena</text>
    <text x="284" y="280" font-family="Manrope" font-size="15" fill="${GRAPHITE}">like a terminal and every opening like a</text>
    <text x="284" y="302" font-family="Manrope" font-size="15" fill="${GRAPHITE}">permissions bug.</text>

    <!-- field record -->
    <rect x="40" y="420" width="670" height="230" fill="#F2F2EF"/>
    <rect x="40" y="420" width="670" height="2" fill="${INK}"/>
    <g font-family="IBM Plex Mono" font-size="9" letter-spacing="1.6" fill="${GRAPHITE}">
      <text x="60" y="452">RARITY</text><text x="250" y="452">FINISH</text><text x="470" y="452">SET</text>
      <text x="60" y="518">EDITION</text><text x="250" y="518">AUDIENCE</text><text x="470" y="518">PRINT CODE</text>
    </g>
    <g font-family="Manrope" font-size="18" fill="${INK}">
      <text x="60" y="476">Rare</text><text x="250" y="476">${esc(finishTitle)}</text><text x="470" y="476">Fighter</text>
      <text x="60" y="542">Source edition</text><text x="250" y="542">Public showcase</text><text x="470" y="542">${esc(copy.printCode)}</text>
    </g>
    <line x1="60" y1="566" x2="690" y2="566" stroke="#D8D8D2" stroke-width="1"/>
    <text x="60" y="596" font-family="IBM Plex Mono" font-size="9" letter-spacing="1.5" fill="${GRAPHITE}">CORE SET · FIGHTER</text>
    <text x="690" y="596" text-anchor="end" font-family="IBM Plex Mono" font-size="9" letter-spacing="1.5" fill="${GRAPHITE}">FB-F-005</text>

    <!-- provenance -->
    <text x="40" y="704" font-family="IBM Plex Mono" font-size="10" letter-spacing="2.4" fill="${GRAPHITE}">PROVENANCE</text>
    <rect x="40" y="720" width="670" height="64" fill="none" stroke="#C9C9C3" stroke-width="1"/>
    <text x="58" y="748" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.2" fill="${INK}">PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT</text>
    <text x="58" y="770" font-family="Manrope" font-size="12" fill="${GRAPHITE}">Original Foilbury character. Card design and type are Foilbury originals.</text>

    <!-- credits / footer -->
    <text x="40" y="838" font-family="IBM Plex Mono" font-size="9" letter-spacing="1" fill="${GRAPHITE}">ART · TUX SIGNAL-KEEPER STUDY · COMPOSED FROM SCENE, SUBJECT, FRAME, ${PLAIN ? "MATERIAL" : "HOLO"} AND TYPE LAYERS</text>
    <text x="40" y="858" font-family="IBM Plex Mono" font-size="9" letter-spacing="1" fill="${GRAPHITE}">REVIEWED · NOT OFFICIAL THIRD-PARTY ARTWORK · NO INVENTED SERIAL ON A SHARED BACK</text>
    <line x1="40" y1="900" x2="710" y2="900" stroke="#E4E4DF" stroke-width="1"/>
    <text x="40" y="944" font-family="IBM Plex Mono" font-size="10" letter-spacing="2" fill="${INK}">SHARED RENDER · ${esc(copy.printCode)}</text>
    <text x="710" y="944" text-anchor="end" font-family="IBM Plex Mono" font-size="10" letter-spacing="2" fill="${GRAPHITE}">FOILBURY</text>
    <text x="40" y="1002" font-family="Fraunces" font-style="italic" font-size="18" fill="${GRAPHITE}">Characters worth keeping.</text>

    <!-- edge -->
    <rect x="8" y="8" width="734" height="1034" fill="none" stroke="${INK}" stroke-width="6"/>
    <rect x="16" y="16" width="718" height="1018" fill="none" stroke="${PLAIN ? "#8a8a84" : "url(#backHolo)"}" stroke-width="2"/>
    <g stroke="${INK}" stroke-width="2" fill="none">
      <path d="M24 58V24h34"/><path d="M726 58V24h-34"/>
      <path d="M24 992v34h34"/><path d="M726 992v34h-34"/>
    </g>
  </svg>`;
}

async function holoMask(strong, seal = true) {
  return svgPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="none"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="white" stroke-width="${strong ? 28 : 18}"/>
  </svg>`);
}

async function buildFront() {
  const scene = await sharp(path.join(evidence, "tux-v3-scene.png"))
    .resize(W, H, { fit: "cover", position: "centre" })
    .modulate({ brightness: 0.72, saturation: 0.92 })
    .blur(0.5)
    .png()
    .toBuffer();
  const subject = await sharp(path.join(evidence, "tux-v3-subject-alpha.png"))
    .resize({ height: 720 })
    .png()
    .toBuffer();
  const subjectMeta = await sharp(subject).metadata();
  const subjectWidth = subjectMeta.width ?? 420;
  const subjectLeft = W - subjectWidth - 24;
  const subjectTop = 842 - (subjectMeta.height ?? 720);

  const frontBase = svgPng(frontBaseSvg());
  const frontText = svgPng(frontTextSvg());
  const base = await sharp(scene)
    .composite([
      { input: frontBase, left: 0, top: 0 },
      { input: subject, left: subjectLeft, top: subjectTop },
    ])
    .png()
    .toBuffer();

  const parts = [{ input: frontText, left: 0, top: 0 }];
  if (!PLAIN) {
    const mask = await holoMask(true);
    const holo = await sharp(path.join(root, "public/art/layers/ai/neon-holo.png"))
      .resize(W, H)
      .composite([{ input: mask, blend: "dest-in" }])
      .ensureAlpha(0.34)
      .png()
      .toBuffer();
    parts.push({ input: holo, left: 0, top: 0, blend: "screen" });
  }

  const final = await sharp(base).composite(parts).png().toBuffer();

  await sharp(final)
    .webp({ quality: 92, effort: 5 })
    .toFile(path.join(outDir, `tux-v3${suffix}-front.webp`));
  await sharp(final)
    .resize(1500, 2100)
    .png()
    .toFile(path.join(outDir, `tux-v3${suffix}-front-master.png`));
  await sharp(final)
    .resize(400, 560)
    .webp({ quality: 90 })
    .toFile(path.join(evidence, `tux-v3${suffix}-front-400.webp`));
  await sharp(final)
    .resize(214, 300)
    .png()
    .toFile(path.join(evidence, `tux-v3${suffix}-front-214.png`));
  await sharp(final)
    .resize(128, 179)
    .png()
    .toFile(path.join(evidence, `tux-v3${suffix}-front-128.png`));
  await sharp(final)
    .png()
    .toFile(path.join(evidence, `tux-v3${suffix}-front-full.png`));
}

async function buildBack() {
  const subject = await sharp(path.join(evidence, "tux-v3-subject-alpha.png"))
    .resize(204, 254, { fit: "cover", position: "top" })
    .png()
    .toBuffer();
  const mark = await markPng();
  const base = svgPng(backSvg());
  const plate = await sharp(path.join(evidence, "tux-v3-scene.png"))
    .resize(210, 260, { fit: "cover", position: "centre" })
    .modulate({ brightness: 0.86 })
    .png()
    .toBuffer();
  const withImages = await sharp(base)
    .composite([
      { input: plate, left: 40, top: 86 },
      { input: subject, left: 43, top: 89 },
      { input: mark, left: 618, top: 910, width: 56, height: 56 },
    ])
    .png()
    .toBuffer();
  const parts = [];
  if (!PLAIN) {
    const mask = await holoMask(false, false);
    const holo = await sharp(path.join(root, "public/art/layers/ai/neon-holo.png"))
      .resize(W, H)
      .composite([{ input: mask, blend: "dest-in" }])
      .ensureAlpha(0.2)
      .png()
      .toBuffer();
    parts.push({ input: holo, left: 0, top: 0, blend: "screen" });
  }
  const final = parts.length
    ? await sharp(withImages).composite(parts).png().toBuffer()
    : withImages;
  await sharp(final)
    .webp({ quality: 92, effort: 5 })
    .toFile(path.join(outDir, `tux-v3${suffix}-back.webp`));
  await sharp(final)
    .resize(1500, 2100)
    .png()
    .toFile(path.join(outDir, `tux-v3${suffix}-back-master.png`));
  await sharp(final)
    .resize(400, 560)
    .webp({ quality: 90 })
    .toFile(path.join(evidence, `tux-v3${suffix}-back-400.webp`));
  await sharp(final)
    .resize(214, 300)
    .png()
    .toFile(path.join(evidence, `tux-v3${suffix}-back-214.png`));
  await sharp(final)
    .resize(128, 179)
    .png()
    .toFile(path.join(evidence, `tux-v3${suffix}-back-128.png`));
  await sharp(final)
    .png()
    .toFile(path.join(evidence, `tux-v3${suffix}-back-full.png`));
}

await mkdir(outDir, { recursive: true });
await buildFront();
await buildBack();
console.log(`wrote tux-v3${suffix} front/back proofs`);
