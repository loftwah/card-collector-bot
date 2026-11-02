#!/usr/bin/env node
/**
 * Deterministic Foilbury card compositor.
 *
 * Layers: background -> subject -> material -> frame -> effect -> exact text.
 * All artwork is authored or imported; no CSS tint is presented as a finish.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const W = 750;
const H = 1050;
const root = process.cwd();
const layerDir = path.join(root, "public/art/layers");
const fontFiles = [
  path.join(root, "art/fonts/Fraunces.ttf"),
  path.join(root, "art/fonts/Manrope.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-Regular.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-SemiBold.ttf"),
];

export async function composeCard(input) {
  const {
    subjectPath,
    backgroundPath,
    material = "plain",
    effect = "none",
    name = "Untitled",
    subtitle = "",
    setName = "Cabinet",
    serial = "",
    className = "",
    rarity = "",
    outputPath,
  } = input;

  const background = await sharp(backgroundPath)
    .resize(W, H, { fit: "cover", position: "attention" })
    .modulate({ brightness: 0.72, saturation: 0.85 })
    .blur(1.2)
    .toBuffer();

  const subjectMeta = await sharp(subjectPath).metadata();
  const isCutout = Boolean(subjectMeta.hasAlpha);
  let subjectLayer;
  if (isCutout) {
    const trimmed = await sharp(subjectPath).trim({ threshold: 12 }).png().toBuffer();
    subjectLayer = await sharp(trimmed)
      .resize(650, 690, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta = await sharp(subjectLayer).metadata();
    subjectLayer = await sharp({
      create: { width: meta.width ?? 650, height: (meta.height ?? 690) + 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: subjectLayer, left: 0, top: 30 }])
      .png()
      .toBuffer();
  } else if (subjectMeta.width === subjectMeta.height) {
    // Square avatars from Protocol 11 carry a circular subject on a white field.
    // A medallion mask honours that authored shape and removes the white corners.
    const size = 560;
    const panel = await sharp(subjectPath).resize(size, size, { fit: "cover", position: "attention" }).png().toBuffer();
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="#fff"/></svg>`,
    );
    const cut = await sharp(panel).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    const backing = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="#101a17" opacity=".76"/><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 8}" fill="none" stroke="#D9BF8B" stroke-width="2" opacity=".75"/></svg>`,
    );
    subjectLayer = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: backing, left: 0, top: 0 }, { input: cut, left: 0, top: 0 }])
      .png()
      .toBuffer();
  } else {
    const panelW = 574;
    const panelH = 704;
    const panel = await sharp(subjectPath)
      .resize(panelW, panelH, { fit: "cover", position: "top" })
      .png()
      .toBuffer();
    const mask = Buffer.from(
      `<svg width="${panelW}" height="${panelH}" xmlns="http://www.w3.org/2000/svg"><path d="M0 ${panelH} V${Math.round(panelH * 0.28)} Q0 0 ${Math.round(panelH * 0.28)} 0 H${Math.round(panelW * 0.72)} Q${panelW} 0 ${panelW} ${Math.round(panelH * 0.28)} V${panelH} Z" fill="#fff"/></svg>`,
    );
    const cut = await sharp(panel).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    subjectLayer = await sharp({
      create: { width: panelW + 8, height: panelH + 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: cut, left: 4, top: 4 }])
      .png()
      .toBuffer();
  }

  const base = await sharp({
    create: { width: W, height: H, channels: 4, background: "#141512" },
  })
    .composite([
      { input: background, left: 0, top: 0 },
      {
        input: Buffer.from(
          `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141512" stop-opacity=".42"/><stop offset=".5" stop-color="#141512" stop-opacity=".18"/><stop offset="1" stop-color="#141512" stop-opacity=".8"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#v)"/></svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  const subjectMeta2 = await sharp(subjectLayer).metadata();
  const subjectLeft = Math.round((W - (subjectMeta2.width ?? 650)) / 2);
  const subjectTop = isCutout ? 224 : subjectMeta.width === subjectMeta.height ? 220 : 186;
  const shadow = Buffer.from(
    `<svg width="${W}" height="160" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${W / 2}" cy="80" rx="250" ry="42" fill="#000" opacity=".45" filter="url(#b)"/><defs><filter id="b"><feGaussianBlur stdDeviation="28"/></filter></defs></svg>`,
  );
  const withSubject = await sharp(base)
    .composite([
      { input: shadow, left: 0, top: isCutout ? 860 : 820 },
      { input: subjectLayer, left: subjectLeft, top: subjectTop },
    ])
    .png()
    .toBuffer();

  const materialLayer = path.join(layerDir, `material-${material}.png`);
  const frameLayer = path.join(layerDir, `frame-${material}.png`);
  const effectLayer = effect && effect !== "none" ? path.join(layerDir, `effect-${effect}.png`) : null;
  if (!fs.existsSync(materialLayer) || !fs.existsSync(frameLayer)) {
    throw new Error(`Missing material or frame layer for ${material}`);
  }
  if (effectLayer && !fs.existsSync(effectLayer)) throw new Error(`Missing effect layer for ${effect}`);

  const materialBlend = material === "silver" ? "overlay" : material === "diamond" ? "screen" : "soft-light";
  const tint = {
    plain: { colour: "#8c7a58", opacity: 0.06 },
    silver: { colour: "#b9d0da", opacity: 0.16 },
    gold: { colour: "#d6a54b", opacity: 0.2 },
    diamond: { colour: "#9fdcf0", opacity: 0.18 },
  }[material] ?? { colour: "#ffffff", opacity: 0 };
  const withMaterial = await sharp(withSubject)
    .composite([
      { input: await sharp(materialLayer).resize(W, H).png().toBuffer(), blend: materialBlend, left: 0, top: 0 },
      {
        input: Buffer.from(
          `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="grade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tint.colour}" stop-opacity="${tint.opacity}"/><stop offset=".55" stop-color="${tint.colour}" stop-opacity="0"/><stop offset="1" stop-color="${tint.colour}" stop-opacity="${tint.opacity * 0.8}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#grade)"/></svg>`,
        ),
        blend: "overlay",
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const withFrame = await sharp(withMaterial)
    .composite([{ input: await sharp(frameLayer).resize(W, H).png().toBuffer(), blend: "over", left: 0, top: 0 }])
    .png()
    .toBuffer();
  const withEffect = effectLayer
    ? await sharp(withFrame)
        .composite([{ input: await sharp(effectLayer).resize(W, H).png().toBuffer(), blend: "screen", left: 0, top: 0 }])
        .png()
        .toBuffer()
    : withFrame;

  const textSvg = cardTextSvg({ name, subtitle, setName, serial, className, rarity, material, effect });
  const textPng = new Resvg(textSvg, {
    fitTo: { mode: "width", value: W },
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Manrope" },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();

  const final = await sharp(withEffect)
    .composite([{ input: textPng, left: 0, top: 0 }])
    .png()
    .toBuffer();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (outputPath.endsWith(".webp")) {
    await sharp(final).webp({ quality: 90, effort: 5 }).toFile(outputPath);
  } else {
    await sharp(final).png({ compressionLevel: 9 }).toFile(outputPath);
  }
  return { width: W, height: H, bytes: fs.statSync(outputPath).size, outputPath };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapName(name) {
  const words = String(name).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > 20 && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

function cardTextSvg({ name, subtitle, setName, serial, className, rarity, material, effect }) {
  const lines = wrapName(name);
  const nameSize = lines.length > 1 ? 46 : 54;
  const nameY = 900 - (lines.length - 1) * 48;
  const nameMarkup = lines
    .map((line, index) => `<tspan x="64" dy="${index === 0 ? 0 : nameSize + 8}">${escapeXml(line)}</tspan>`)
    .join("");
  const materialLabel = `${material.toUpperCase()}${effect && effect !== "none" ? ` · ${effect.toUpperCase()}` : ""}`;
  const meta = [setName, className, rarity].filter(Boolean).map(escapeXml).join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#141512" stop-opacity="0"/>
        <stop offset=".45" stop-color="#141512" stop-opacity=".55"/>
        <stop offset="1" stop-color="#141512" stop-opacity=".94"/>
      </linearGradient>
    </defs>
    <rect x="0" y="720" width="${W}" height="330" fill="url(#shade)"/>
    <text x="64" y="116" font-family="IBM Plex Mono" font-size="16" letter-spacing="3.2" fill="#D9BF8B">${escapeXml(setName.toUpperCase())}</text>
    <text x="${W - 64}" y="116" text-anchor="end" font-family="IBM Plex Mono" font-size="14" letter-spacing="2.2" fill="#F4F0E6" opacity=".78">${escapeXml(materialLabel)}</text>
    <path d="M64 134 H260" stroke="#B08A52" stroke-width="1.2" opacity=".8"/>
    <text x="64" y="${nameY}" font-family="Fraunces" font-weight="600" font-size="${nameSize}" fill="#F4F0E6">${nameMarkup}</text>
    ${subtitle ? `<text x="64" y="${nameY + (lines.length > 1 ? 52 : 40)}" font-family="Manrope" font-size="19" fill="#F4F0E6" opacity=".82">${escapeXml(subtitle)}</text>` : ""}
    <text x="64" y="${nameY + (lines.length > 1 ? 96 : 82)}" font-family="IBM Plex Mono" font-size="13" letter-spacing="1.8" fill="#D9BF8B">${meta.toUpperCase()}</text>
    <path d="M64 986 H686" stroke="#F4F0E6" stroke-width=".7" opacity=".22"/>
    <text x="64" y="1016" font-family="IBM Plex Mono" font-size="11" letter-spacing="4" fill="#F4F0E6" opacity=".55">FOILBURY</text>
    <text x="${W - 64}" y="1016" text-anchor="end" font-family="IBM Plex Mono" font-size="12" letter-spacing="1.2" fill="#F4F0E6" opacity=".76">${escapeXml(serial)}</text>
  </svg>`;
}

// Optional CLI: node art/compose.mjs '<json>' (used for focused visual checks)
if (process.argv[1] && process.argv[1].endsWith("compose.mjs") && process.argv[2]) {
  const input = JSON.parse(process.argv[2]);
  const result = await composeCard(input);
  console.log(JSON.stringify(result));
}
