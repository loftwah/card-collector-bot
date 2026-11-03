#!/usr/bin/env node
/**
 * Deterministic original collection art for the launch catalogue.
 *
 * These are deliberately labelled original Foilbury interpretations. They are
 * not official logos, character likenesses or licensed artwork. The generator
 * produces editable source layers (subject / background / mark / cover / back)
 * so the normal compositor and render pipeline stay authoritative.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const root = process.cwd();
const FONT_FILES = [
  path.join(root, "art/fonts/Fraunces.ttf"),
  path.join(root, "art/fonts/Manrope.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-Regular.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-SemiBold.ttf"),
];

function wrapText(value, maxChars) {
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

function textBlock({ value, x, y, maxChars, lineHeight, size, fill, opacity = 0.85, font = "Manrope, sans-serif", maxLines = 99, ellipsis = false }) {
  const allLines = wrapText(value, maxChars);
  const lines = allLines.slice(0, maxLines);
  if (ellipsis && allLines.length > maxLines && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?]?$/, "")}…`;
  }
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" font-family="${font}" font-size="${size}" fill="${fill}" opacity="${opacity}">${escapeXml(line)}</text>`)
    .join("");
}

function clip(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hashSeed(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function palette(input) {
  const colors = Array.isArray(input) && input.length >= 3 ? input : ["#17233f", "#e4572e", "#f4e3c1"];
  return { deep: colors[0], accent: colors[1], light: colors[2] };
}

export function motifSvg(motif, colors, width, height, seed) {
  const rand = mulberry32(hashSeed(`${motif}:${seed}`));
  const parts = [];
  const line = colors.accent;
  const pale = colors.light;
  if (motif === "court-lines" || motif === "arcs") {
    parts.push(`<path d="M ${width * 0.5} ${height * 1.02} L ${width * 0.5} ${height * 0.2}" stroke="${line}" stroke-width="${width * 0.006}" opacity=".5"/>`);
    parts.push(`<circle cx="${width * 0.5}" cy="${height * 0.56}" r="${width * 0.23}" fill="none" stroke="${pale}" stroke-width="${width * 0.004}" opacity=".38"/>`);
    parts.push(`<path d="M ${width * 0.04} ${height * 0.38} Q ${width * 0.5} ${height * 0.12} ${width * 0.96} ${height * 0.38}" fill="none" stroke="${line}" stroke-width="${width * 0.008}" opacity=".55"/>`);
  } else if (motif === "halftone" || motif === "dots") {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        const r = 2 + rand() * 9;
        parts.push(`<circle cx="${(x + 0.5) * (width / 12)}" cy="${(y + 0.5) * (height / 16)}" r="${r}" fill="${x % 3 === 0 ? line : pale}" opacity="${0.08 + rand() * 0.18}"/>`);
      }
    }
  } else if (motif === "rays") {
    for (let i = 0; i < 26; i += 1) {
      const angle = (i / 26) * Math.PI * 2 + rand() * 0.1;
      const x = width * 0.5 + Math.cos(angle) * width;
      const y = height * 0.46 + Math.sin(angle) * height;
      parts.push(`<path d="M ${width * 0.5} ${height * 0.46} L ${x} ${y}" stroke="${i % 2 ? line : pale}" stroke-width="${2 + rand() * 5}" opacity=".14"/>`);
    }
  } else if (motif === "waves") {
    for (let i = 0; i < 9; i += 1) {
      const y = height * (0.18 + i * 0.085);
      parts.push(`<path d="M 0 ${y} Q ${width * 0.25} ${y - 70} ${width * 0.5} ${y} T ${width} ${y}" fill="none" stroke="${i % 2 ? line : pale}" stroke-width="${3 + (i % 3) * 2}" opacity=".2"/>`);
    }
  } else if (motif === "grid" || motif === "tiles") {
    const step = width / 11;
    for (let x = 0; x < 11; x += 1) parts.push(`<path d="M ${x * step} 0 V ${height}" stroke="${pale}" stroke-width="1.4" opacity=".13"/>`);
    for (let y = 0; y < 18; y += 1) parts.push(`<path d="M 0 ${y * (height / 18)} H ${width}" stroke="${pale}" stroke-width="1.4" opacity=".13"/>`);
    for (let i = 0; i < 8; i += 1) {
      parts.push(`<rect x="${rand() * width * 0.8}" y="${rand() * height * 0.7}" width="${width * (0.08 + rand() * 0.16)}" height="${width * (0.03 + rand() * 0.1)}" fill="${line}" opacity=".16"/>`);
    }
  } else if (motif === "stars" || motif === "sparkle") {
    for (let i = 0; i < 34; i += 1) {
      const x = rand() * width;
      const y = rand() * height;
      const r = 2 + rand() * 7;
      parts.push(`<path d="M ${x} ${y - r} L ${x + r * 0.28} ${y - r * 0.28} L ${x + r} ${y} L ${x + r * 0.28} ${y + r * 0.28} L ${x} ${y + r} L ${x - r * 0.28} ${y + r * 0.28} L ${x - r} ${y} L ${x - r * 0.28} ${y - r * 0.28} Z" fill="${i % 3 ? pale : line}" opacity="${0.2 + rand() * 0.45}"/>`);
    }
  } else if (motif === "stripes") {
    for (let i = -12; i < 22; i += 1) {
      const x1 = i * 90;
      const x2 = x1 - height * 0.5;
      if (x1 < -width && x2 < -width) continue;
      if (x1 > width * 2 && x2 > width * 2) continue;
      parts.push(`<line x1="${x1}" y1="0" x2="${x2}" y2="${height}" stroke="${i % 3 ? line : pale}" stroke-width="${8 + ((i % 4) + 4) % 4 * 5}" opacity=".11"/>`);
    }
  } else if (motif === "circuit") {
    for (let i = 0; i < 12; i += 1) {
      const x = rand() * width;
      const y = rand() * height;
      const len = 60 + rand() * 220;
      parts.push(`<path d="M ${x} ${y} H ${x + len} V ${y + len * 0.55}" fill="none" stroke="${line}" stroke-width="3" opacity=".3"/>`);
      parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${pale}" opacity=".5"/>`);
    }
  } else if (motif === "petals") {
    for (let i = 0; i < 16; i += 1) {
      const x = rand() * width;
      const y = rand() * height;
      const r = 26 + rand() * 90;
      parts.push(`<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.42}" fill="none" stroke="${i % 2 ? line : pale}" stroke-width="3" opacity=".18" transform="rotate(${rand() * 180} ${x} ${y})"/>`);
    }
  } else if (motif === "tape") {
    for (let i = 0; i < 14; i += 1) {
      const x = rand() * width;
      const y = rand() * height;
      parts.push(`<rect x="${x}" y="${y}" width="${100 + rand() * 260}" height="${18 + rand() * 34}" fill="${i % 2 ? line : pale}" opacity=".13" transform="rotate(${-18 + rand() * 36} ${x} ${y})"/>`);
    }
  } else if (motif === "bubbles") {
    for (let i = 0; i < 22; i += 1) {
      const x = rand() * width;
      const y = rand() * height;
      const r = 18 + rand() * 120;
      parts.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${i % 2 ? pale : line}" stroke-width="2.5" opacity=".18"/>`);
    }
  } else if (motif === "skyline") {
    for (let i = 0; i < 18; i += 1) {
      const w = width / 18;
      const h = height * (0.08 + rand() * 0.34);
      parts.push(`<rect x="${i * w}" y="${height - h}" width="${w * 0.82}" height="${h}" fill="${i % 3 ? line : pale}" opacity=".12"/>`);
    }
  } else {
    for (let i = 0; i < 24; i += 1) {
      parts.push(`<circle cx="${rand() * width}" cy="${rand() * height}" r="${10 + rand() * 60}" fill="${i % 2 ? line : pale}" opacity=".1"/>`);
    }
  }
  return parts.join("");
}

function subjectSvg({ name, initials, palette: colors, motif, seed }) {
  const w = 1200;
  const h = 1600;
  const c = palette(colors);
  const rand = mulberry32(hashSeed(`subject:${seed}`));
  const ringOffset = -30 + rand() * 60;
  // Deliberate development fallback: a neutral silhouette, never oversized
  // initials. Initials read as unrelated words or symbols at card size.
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0" stop-color="${c.deep}"/>
        <stop offset="0.55" stop-color="${c.accent}" stop-opacity=".55"/>
        <stop offset="1" stop-color="${c.deep}"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="38%" r="55%">
        <stop offset="0" stop-color="${c.light}" stop-opacity=".35"/>
        <stop offset="1" stop-color="${c.light}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${motifSvg(motif, c, w, h, seed)}
    <rect width="${w}" height="${h}" fill="url(#glow)"/>
    <circle cx="600" cy="660" r="330" fill="${c.deep}" opacity=".4"/>
    <circle cx="600" cy="660" r="330" fill="none" stroke="${c.light}" stroke-width="5" opacity=".5"/>
    <circle cx="${600 + ringOffset}" cy="660" r="280" fill="none" stroke="${c.accent}" stroke-width="3" opacity=".65" stroke-dasharray="18 14"/>
    <path d="M 210 1600 Q 280 1130 600 1090 Q 920 1130 990 1600 Z" fill="${c.deep}" opacity=".55"/>
    <path d="M 280 1600 Q 340 1180 600 1145 Q 860 1180 920 1600 Z" fill="none" stroke="${c.light}" stroke-width="3" opacity=".28"/>
    <circle cx="600" cy="610" r="168" fill="${c.accent}" opacity=".22"/>
    <path d="M 432 826 Q 432 640 600 640 Q 768 640 768 826 Q 700 900 600 900 Q 500 900 432 826 Z" fill="${c.light}" opacity=".2"/>
    <circle cx="600" cy="735" r="82" fill="${c.light}" opacity=".26"/>
    <text x="600" y="1330" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="22" letter-spacing="8" fill="${c.light}" opacity=".55">ART PENDING</text>
    <text x="600" y="1370" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="18" letter-spacing="5" fill="${c.light}" opacity=".38">${escapeXml(initials)}</text>
    <rect x="70" y="70" width="1060" height="1460" fill="none" stroke="${c.light}" stroke-width="2" opacity=".28"/>
    <rect x="96" y="96" width="1008" height="1408" fill="none" stroke="${c.light}" stroke-width="1" opacity=".18"/>
  </svg>`;
}

function backgroundSvg({ name, palette: colors, motif, seed }) {
  const w = 1600;
  const h = 2000;
  const c = palette(colors);
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c.deep}"/>
        <stop offset="0.5" stop-color="${c.deep}"/>
        <stop offset="1" stop-color="${c.accent}" stop-opacity=".72"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    ${motifSvg(motif, c, w, h, `${name}:${seed}`)}
    <rect width="${w}" height="${h}" fill="${c.deep}" opacity=".35"/>
  </svg>`;
}

function markSvg({ initials, palette: colors, motif, name }) {
  const c = palette(colors);
  return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <rect x="10" y="10" width="492" height="492" rx="52" fill="${c.deep}"/>
    <rect x="28" y="28" width="456" height="456" rx="40" fill="none" stroke="${c.light}" stroke-width="3" opacity=".55"/>
    ${motifSvg(motif, c, 512, 512, name)}
    <text x="256" y="320" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="190" font-weight="560" fill="${c.light}">${escapeXml(initials)}</text>
    <text x="256" y="410" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="20" letter-spacing="8" fill="${c.light}" opacity=".65">FOILBURY</text>
  </svg>`;
}

function coverSvg({ name, description, initials, palette: colors, motif, sourceWork }) {
  const c = palette(colors);
  const titleLines = wrapText(name, 24).slice(0, 3);
  const titleSize = titleLines.length >= 3 ? 54 : titleLines.length > 1 ? 64 : name.length > 18 ? 78 : 92;
  const titleLineHeight = titleSize + 8;
  const titleY = 320;
  const titleMarkup = titleLines
    .map((line, index) => `<text x="110" y="${titleY + index * titleLineHeight}" font-family="Fraunces, Georgia, serif" font-size="${titleSize}" font-weight="560" fill="${c.light}">${escapeXml(line)}</text>`)
    .join("");
  const descriptionY = titleY + (titleLines.length - 1) * titleLineHeight + 72;
  return `<svg width="1600" height="900" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c.deep}"/>
        <stop offset="0.65" stop-color="${c.accent}" stop-opacity=".8"/>
        <stop offset="1" stop-color="${c.deep}"/>
      </linearGradient>
    </defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    ${motifSvg(motif, c, 1600, 900, name)}
    <rect width="1600" height="900" fill="${c.deep}" opacity=".18"/>
    <rect x="70" y="70" width="1460" height="760" fill="none" stroke="${c.light}" stroke-width="3" opacity=".5"/>
    <text x="110" y="245" font-family="IBM Plex Mono, monospace" font-size="26" letter-spacing="10" fill="${c.light}" opacity=".75">${escapeXml(String(sourceWork ?? "FOILBURY COLLECTION").replace(/[^\x20-\x7E]/g, "").replace(/\(\s*\)/g, "").trim())}</text>
    ${titleMarkup}
    ${textBlock({ value: description, x: 110, y: descriptionY, maxChars: 52, lineHeight: 42, size: 28, fill: c.light, opacity: 0.82 })}
    <circle cx="1370" cy="720" r="118" fill="${c.deep}" opacity=".62"/>
    <circle cx="1370" cy="720" r="102" fill="none" stroke="${c.light}" stroke-width="3" opacity=".6"/>
    <text x="1370" y="775" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="92" fill="${c.light}">${escapeXml(initials)}</text>
  </svg>`;
}

function backSvg({ name, subtitle, bio, attributes, collectionName, collectionDescription, initials, palette: colors, motif, sourceWork, artCredit }) {
  const c = palette(colors);
  const titleLines = wrapText(name, 18).slice(0, 3);
  const titleSize = titleLines.length >= 3 ? 44 : titleLines.length > 1 ? 52 : 58;
  const titleLineHeight = titleSize + 6;
  const titleY = 190;
  const titleMarkup = titleLines
    .map((line, index) => `<text x="70" y="${titleY + index * titleLineHeight}" font-family="Fraunces, Georgia, serif" font-size="${titleSize}" font-weight="560" fill="${c.light}">${escapeXml(line)}</text>`)
    .join("");
  const subtitleY = titleY + (titleLines.length - 1) * titleLineHeight + 34;
  const bioY = subtitleY + 44;
  const bioLineCount = Math.min(wrapText(bio ?? "", 40).length, 6);
  const attrY = bioY + bioLineCount * 30 + 28;
  const attrLines = (attributes ?? [])
    .slice(0, 3)
    .map((attr, index) => `<text x="70" y="${attrY + index * 40}" font-family="IBM Plex Mono, monospace" font-size="18" letter-spacing="1.6" fill="${c.light}" opacity=".76">${escapeXml(String(attr.label ?? "").toUpperCase())} · ${escapeXml(String(attr.value ?? ""))}</text>`)
    .join("");
  return `<svg width="750" height="1050" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c.deep}"/>
        <stop offset="1" stop-color="${c.accent}" stop-opacity=".55"/>
      </linearGradient>
    </defs>
    <rect width="750" height="1050" fill="url(#bg)"/>
    ${motifSvg(motif, c, 750, 1050, name)}
    <rect width="750" height="1050" fill="#0b0d0c" opacity=".72"/>
    <rect x="34" y="34" width="682" height="982" fill="none" stroke="${c.light}" stroke-width="2" opacity=".55"/>
    <text x="70" y="104" font-family="IBM Plex Mono, monospace" font-size="16" letter-spacing="5" fill="${c.light}" opacity=".72">${escapeXml(clip(collectionName, 42).toUpperCase())}</text>
    ${titleMarkup}
    <text x="70" y="${subtitleY}" font-family="Manrope, sans-serif" font-size="21" fill="${c.light}" opacity=".78">${escapeXml(clip(subtitle ?? "", 52))}</text>
    ${textBlock({ value: bio ?? "", x: 70, y: bioY, maxChars: 40, lineHeight: 30, size: 21, fill: c.light, opacity: 0.88, maxLines: 6, ellipsis: true })}
    ${attrLines}
    <path d="M70 768 H680" stroke="${c.light}" stroke-width="1" opacity=".18"/>
    <text x="70" y="804" font-family="IBM Plex Mono, monospace" font-size="15" letter-spacing="4" fill="${c.light}" opacity=".52">ABOUT THIS WORLD</text>
    ${textBlock({ value: collectionDescription ?? "", x: 70, y: 836, maxChars: 70, lineHeight: 24, size: 15, fill: c.light, opacity: 0.62, maxLines: 2, ellipsis: true })}
    ${artCredit ? textBlock({ value: artCredit, x: 70, y: 920, maxChars: 58, lineHeight: 14, size: 10, fill: c.light, opacity: 0.46, maxLines: 2, ellipsis: true }) : ""}
    <text x="70" y="1002" font-family="IBM Plex Mono, monospace" font-size="12" letter-spacing="4" fill="${c.light}" opacity=".5">FOILBURY · MEMBER EDITION</text>
    <circle cx="650" cy="930" r="42" fill="#0b0d0c" opacity=".62"/>
    <circle cx="650" cy="930" r="35" fill="none" stroke="${c.light}" stroke-width="2" opacity=".55"/>
    <text x="650" y="944" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-size="30" fill="${c.light}">${escapeXml(initials)}</text>
  </svg>`;
}

async function render(svg, outputPath) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Manrope" },
  });
  const png = resvg.render().asPng();
  await sharp(png).removeAlpha().png({ compressionLevel: 9 }).toFile(outputPath);
  return outputPath;
}

export async function generateCollectionArt({ collection, cards, outputDir, sourcedDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const collectionColors = collection.palette ?? ["#17233f", "#e4572e", "#f4e3c1"];
  const collectionInitials = collection.initials ?? collection.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  const markSource = markSvg({ initials: collectionInitials, palette: collectionColors, motif: collection.motif ?? "grid", name: collection.slug });
  const mark = await render(markSource, path.join(outputDir, "mark.png"));
  const coverSource = coverSvg({
    name: collection.name,
    description: collection.description,
    initials: collectionInitials,
    palette: collectionColors,
    motif: collection.motif ?? "grid",
    sourceWork: collection.source_work,
  });
  const cover = await render(coverSource, path.join(outputDir, "cover.png"));
  const sourcedCollectionDir = sourcedDir ? path.join(sourcedDir, collection.slug) : null;
  const cardArt = [];
  for (const card of cards) {
    const colors = card.art?.palette ?? collectionColors;
    const motif = card.art?.motif ?? collection.motif ?? "grid";
    const seed = card.slug;
    const sourcedSubject = sourcedCollectionDir ? path.join(sourcedCollectionDir, `${card.slug}-subject.png`) : null;
    const sourcedBackground = sourcedCollectionDir ? path.join(sourcedCollectionDir, `${card.slug}-background.png`) : null;
    const hasSourcedArt = Boolean(sourcedSubject && sourcedBackground && fs.existsSync(sourcedSubject) && fs.existsSync(sourcedBackground));
    let subject;
    let background;
    if (hasSourcedArt) {
      subject = path.join(outputDir, `${card.slug}-subject.png`);
      background = path.join(outputDir, `${card.slug}-background.png`);
      fs.copyFileSync(sourcedSubject, subject);
      fs.copyFileSync(sourcedBackground, background);
    } else {
      subject = await render(
        subjectSvg({ name: card.name, initials: card.art?.initials ?? card.name.slice(0, 2).toUpperCase(), palette: colors, motif, seed }),
        path.join(outputDir, `${card.slug}-subject.png`),
      );
      background = await render(
        backgroundSvg({ name: card.name, palette: colors, motif, seed }),
        path.join(outputDir, `${card.slug}-background.png`),
      );
    }
    const back = await render(
      backSvg({
        name: card.name,
        subtitle: card.subtitle,
        bio: card.bio,
        attributes: card.attributes,
        collectionName: collection.name,
        collectionDescription: collection.description,
        // The reverse badge identifies the collection, not the character. This
        // avoids character initials reading as unrelated words or symbols.
        initials: collectionInitials,
        palette: colors,
        motif,
        sourceWork: collection.source_work,
        artCredit: card.art?.source?.credit ?? card.credit,
      }),
      path.join(outputDir, `${card.slug}-back.png`),
    );
    cardArt.push({ card, subject, background, back, sourced: hasSourcedArt });
  }
  return { mark, cover, cards: cardArt };
}
