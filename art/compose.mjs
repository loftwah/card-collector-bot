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
    markPath = "",
    outputPath,
  } = input;

  if (!backgroundPath) {
    throw new Error("A card needs a background layer; refusing to compose an undefined field.");
  }

  const background = await sharp(backgroundPath)
    .resize(W, H, { fit: "cover", position: "attention" })
    .modulate({ brightness: 0.72, saturation: 0.85 })
    .blur(1.2)
    .toBuffer();

  const subjectMeta = await sharp(subjectPath).metadata();
  const isCutout = Boolean(subjectMeta.hasAlpha);
  const composition = normaliseComposition(input.composition);
  const mode =
    composition.mode ??
    (subjectMeta.width === subjectMeta.height && !isCutout ? "medallion" : "contain");
  const zoom = Math.min(1.6, Math.max(0.6, Number(composition.zoom ?? 1)));
  const offsetX = Math.min(20, Math.max(-20, Number(composition.offsetX ?? 0)));
  const offsetY = Math.min(20, Math.max(-20, Number(composition.offsetY ?? 0)));

  /* The same safe areas as the web card: art is composed inside the upper
     window, text lives below it. A composition can move within its window but
     can never paint over the title, meta or serial. */
  const artWindow = { x: 30, y: 34, width: 690, height: 756 };
  const canvasHeight = 800;

  let source = await sharp(subjectPath).png().toBuffer();
  if (isCutout) {
    source = await sharp(source).trim({ threshold: 12 }).png().toBuffer();
  }
  const sourceMeta = await sharp(source).metadata();
  let layer;
  let layerWidth;
  let layerHeight;
  if (mode === "medallion") {
    const size = Math.round(560 * zoom);
    const square = await sharp(source)
      .resize(size, size, { fit: "cover", position: "attention" })
      .png()
      .toBuffer();
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="#fff"/></svg>`,
    );
    const cut = await sharp(square)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
    const backing = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="#101a17" opacity=".76"/><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 8}" fill="none" stroke="#D9BF8B" stroke-width="2" opacity=".75"/></svg>`,
    );
    layer = await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: backing, left: 0, top: 0 },
        { input: cut, left: 0, top: 0 },
      ])
      .png()
      .toBuffer();
    layerWidth = size;
    layerHeight = size;
  } else if (mode === "fill") {
    layerWidth = Math.round(artWindow.width * zoom);
    layerHeight = Math.round(artWindow.height * zoom);
    layer = await sharp(source)
      .resize(layerWidth, layerHeight, { fit: "cover", position: "attention" })
      .png()
      .toBuffer();
  } else {
    layer = await sharp(source)
      .resize({
        width: Math.round(artWindow.width * zoom),
        height: Math.round(artWindow.height * zoom),
        fit: "inside",
        withoutEnlargement: false,
      })
      .png()
      .toBuffer();
    const sized = await sharp(layer).metadata();
    layerWidth = sized.width ?? artWindow.width;
    layerHeight = sized.height ?? artWindow.height;
  }

  const baseLeft = artWindow.x + Math.round((artWindow.width - layerWidth) / 2);
  const baseTop =
    isCutout && mode === "contain"
      ? artWindow.y + artWindow.height - layerHeight
      : artWindow.y + Math.round((artWindow.height - layerHeight) / 2);
  const requestedLeft = baseLeft + Math.round((offsetX / 100) * artWindow.width);
  const requestedTop = baseTop + Math.round((offsetY / 100) * artWindow.height);
  // Keep the original positioning for layers that fit. If a zoomed layer is
  // larger than the canvas, retain its intended centre and crop the overflow.
  const left = layerWidth > W ? requestedLeft : clamp(requestedLeft, 0, W - layerWidth);
  const top = layerHeight > canvasHeight ? requestedTop : clamp(requestedTop, 0, canvasHeight - layerHeight);
  const clippedLeft = Math.max(0, left);
  const clippedTop = Math.max(0, top);
  const clippedRight = Math.min(W, left + layerWidth);
  const clippedBottom = Math.min(canvasHeight, top + layerHeight);
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) {
    throw new Error("Artwork does not intersect the card art canvas.");
  }
  const clippedLayer = layerWidth > W || layerHeight > canvasHeight
    ? await sharp(layer).extract({
        left: clippedLeft - left,
        top: clippedTop - top,
        width: clippedRight - clippedLeft,
        height: clippedBottom - clippedTop,
      }).png().toBuffer()
    : layer;

  const shadow = Buffer.from(
    `<svg width="${W}" height="200" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${W / 2}" cy="100" rx="250" ry="42" fill="#000" opacity=".45" filter="url(#b)"/><defs><filter id="b"><feGaussianBlur stdDeviation="28"/></filter></defs></svg>`,
  );
  const shadowTop = Math.min(canvasHeight - 140, top + layerHeight - 70);
  const artCanvas = await sharp({
    create: {
      width: W,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: shadow, left: 0, top: Math.max(0, shadowTop) },
      { input: clippedLayer, left: clippedLeft, top: clippedTop },
    ])
    .png()
    .toBuffer();

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

  const withSubject = await sharp(base)
    .composite([{ input: artCanvas, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const materialLayer = path.join(layerDir, `material-${material}.png`);
  const frameLayer = path.join(layerDir, `frame-${material}.png`);
  const effectLayer =
    effect && effect !== "none" ? path.join(layerDir, `effect-${effect}.png`) : null;
  if (!fs.existsSync(materialLayer) || !fs.existsSync(frameLayer)) {
    throw new Error(`Missing material or frame layer for ${material}`);
  }
  if (effectLayer && !fs.existsSync(effectLayer))
    throw new Error(`Missing effect layer for ${effect}`);

  const materialBlend =
    material === "silver" ? "overlay" : material === "diamond" ? "screen" : "soft-light";
  const tint = {
    plain: { colour: "#8c7a58", opacity: 0.06 },
    silver: { colour: "#b9d0da", opacity: 0.16 },
    gold: { colour: "#d6a54b", opacity: 0.2 },
    diamond: { colour: "#9fdcf0", opacity: 0.18 },
  }[material] ?? { colour: "#ffffff", opacity: 0 };
  const withMaterial = await sharp(withSubject)
    .composite([
      {
        input: await sharp(materialLayer).resize(W, H).png().toBuffer(),
        blend: materialBlend,
        left: 0,
        top: 0,
      },
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
    .composite([
      {
        input: await sharp(frameLayer).resize(W, H).png().toBuffer(),
        blend: "over",
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  const withEffect = effectLayer
    ? await sharp(withFrame)
        .composite([
          {
            input: await sharp(effectLayer).resize(W, H).png().toBuffer(),
            blend: "screen",
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer()
    : withFrame;

  const textSvg = cardTextSvg({
    name,
    subtitle,
    setName,
    serial,
    className,
    rarity,
    material,
    effect,
    markData: await markDataUri(markPath, input.markBuffer, input.markMime),
  });
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

  if (input.returnBytes) {
    const buffer = await sharp(final).webp({ quality: 90, effort: 5 }).toBuffer();
    return { width: W, height: H, bytes: buffer.length, buffer };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (outputPath.endsWith(".webp")) {
    await sharp(final).webp({ quality: 90, effort: 5 }).toFile(outputPath);
  } else {
    await sharp(final).png({ compressionLevel: 9 }).toFile(outputPath);
  }
  return { width: W, height: H, bytes: fs.statSync(outputPath).size, outputPath };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normaliseComposition(value) {
  if (!value || typeof value !== "object") return {};
  return {
    mode: ["contain", "fill", "medallion"].includes(value.mode) ? value.mode : undefined,
    zoom: Number.isFinite(Number(value.zoom)) ? Number(value.zoom) : 1,
    offsetX: Number.isFinite(Number(value.offsetX)) ? Number(value.offsetX) : 0,
    offsetY: Number.isFinite(Number(value.offsetY)) ? Number(value.offsetY) : 0,
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function markDataUri(markPath, markBuffer, markMime) {
  try {
    if (!markBuffer && (!markPath || !fs.existsSync(markPath))) return "";
    const ext = markBuffer ? (markMime === 'image/svg+xml' ? 'svg' : 'png') : path.extname(markPath).replace(".", "").toLowerCase();
    const source = markBuffer ?? markPath;
    if (ext === "svg") {
      return `data:image/svg+xml;base64,${(markBuffer ?? fs.readFileSync(markPath)).toString("base64")}`;
    }
    // Collection marks are often supplied as black artwork on a white field.
    // Knock out near-white pixels so the supplied square does not become a
    // white sticker on every card. Preserve dark pixels and antialiasing.
    const image = sharp(source)
      .resize(128, 128, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const corner = (x, y) => {
      const index = (y * info.width + x) * 4;
      return (
        data[index] >= 238 &&
        data[index + 1] >= 238 &&
        data[index + 2] >= 238 &&
        data[index + 3] > 200
      );
    };
    const whiteField =
      corner(0, 0) &&
      corner(info.width - 1, 0) &&
      corner(0, info.height - 1) &&
      corner(info.width - 1, info.height - 1);
    if (whiteField) {
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] >= 238 && data[index + 1] >= 238 && data[index + 2] >= 238) {
          data[index + 3] = 0;
        }
      }
    }
    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return "";
  }
}

function truncate(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
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
  // Long names get three lines at a smaller size rather than clipping.
  return lines.slice(0, 3);
}

function cardTextSvg({
  name,
  subtitle,
  setName,
  serial,
  className,
  rarity,
  material,
  effect,
  markData,
}) {
  const lines = wrapName(name);
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const nameSize = lines.length >= 3 ? 40 : longest > 20 ? 40 : lines.length > 1 ? 46 : 54;
  const lineHeight = nameSize + 8;
  const nameY = 900 - (lines.length - 1) * lineHeight;
  const nameMarkup = lines
    .map(
      (line, index) =>
        `<tspan x="64" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  const lastBaseline = nameY + (lines.length - 1) * lineHeight;
  const subtitleY = lastBaseline + 34;
  const metaY = subtitleY + 32;
  const materialLabel = `${material.toUpperCase()}${effect && effect !== "none" ? ` · ${effect.toUpperCase()}` : ""}`;
  const meta = [setName, className, rarity]
    .filter(Boolean)
    .map((value) => escapeXml(truncate(value, 52)))
    .join(" · ");
  const headerX = markData ? 136 : 64;
  const markMarkup = markData
    ? `<svg x="64" y="50" width="58" height="58" viewBox="0 0 58 58"><rect width="58" height="58" fill="#07110F" opacity=".82"/><image href="${markData}" x="4" y="4" width="50" height="50" preserveAspectRatio="xMidYMid meet"/></svg>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#141512" stop-opacity="0"/>
        <stop offset=".45" stop-color="#141512" stop-opacity=".55"/>
        <stop offset="1" stop-color="#141512" stop-opacity=".94"/>
      </linearGradient>
    </defs>
    <rect x="0" y="748" width="${W}" height="302" fill="url(#shade)"/>
    ${markMarkup}
    <text x="${headerX}" y="${markData ? 84 : 116}" font-family="IBM Plex Mono" font-size="16" letter-spacing="3.2" fill="#D9BF8B">${escapeXml(setName.toUpperCase())}</text>
    <text x="${W - 64}" y="${markData ? 84 : 116}" text-anchor="end" font-family="IBM Plex Mono" font-size="14" letter-spacing="2.2" fill="#F4F0E6" opacity=".78">${escapeXml(materialLabel)}</text>
    <path d="M64 ${markData ? 110 : 134} H260" stroke="#B08A52" stroke-width="1.2" opacity=".8"/>
    <text x="64" y="${nameY}" font-family="Fraunces" font-weight="600" font-size="${nameSize}" fill="#F4F0E6">${nameMarkup}</text>
    ${subtitle ? `<text x="64" y="${subtitleY}" font-family="Manrope" font-size="19" fill="#F4F0E6" opacity=".82">${escapeXml(truncate(subtitle, 44))}</text>` : ""}
    <text x="64" y="${metaY}" font-family="IBM Plex Mono" font-size="13" letter-spacing="1.8" fill="#D9BF8B">${meta.toUpperCase()}</text>
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

/**
 * Applies the same authored finish materials to a designed card back. The back
 * source already carries its own layout and editorial copy; this only adds the
 * collectible material treatment, never a second random outcome.
 */
export async function composeCardBack(input) {
  const { backPath, material = "plain", effect = "none", outputPath } = input;
  const materialLayer = path.join(layerDir, `material-${material}.png`);
  const frameLayer = path.join(layerDir, `frame-${material}.png`);
  if (!fs.existsSync(materialLayer) || !fs.existsSync(frameLayer)) {
    throw new Error(`Missing back material or frame layer for ${material}`);
  }
  const base = await sharp(backPath).resize(W, H, { fit: "cover" }).png().toBuffer();
  const blend =
    material === "silver" ? "overlay" : material === "diamond" ? "screen" : "soft-light";
  const opacity = material === "plain" ? 0.18 : 0.38;
  const layers = [
    { input: await sharp(materialLayer).resize(W, H).png().toBuffer(), blend, left: 0, top: 0 },
    {
      input: await sharp(frameLayer).resize(W, H).png().toBuffer(),
      blend: "over",
      left: 0,
      top: 0,
    },
  ];
  if (effect && effect !== "none") {
    const effectLayer = path.join(layerDir, `effect-${effect}.png`);
    if (fs.existsSync(effectLayer)) {
      layers.push({
        input: await sharp(effectLayer).resize(W, H).ensureAlpha(opacity).png().toBuffer(),
        blend: "screen",
        left: 0,
        top: 0,
      });
    }
  }
  if (input.returnBytes) return sharp(base).composite(layers).webp({ quality: 88, effort: 5 }).toBuffer();
  await sharp(base).composite(layers).webp({ quality: 88, effort: 5 }).toFile(outputPath);
  return outputPath;
}
