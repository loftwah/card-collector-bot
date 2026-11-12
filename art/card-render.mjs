/**
 * Foilbury card renderer, card language v2.
 *
 * One 5:7 object. Layers: scene -> subject -> material -> livery frame ->
 * exact type. The master is 1500x2100 (2x the 750x1050 web object). Text is
 * authored at 750x1050 and rendered at 2x, so it stays sharp at 400px.
 *
 * Collection identity is data-driven: src/data/collection-livery.json holds
 * the palette, motif and plate treatment; src/data/collection-themes.json
 * holds the shared family geometry. There is no per-collection code branch.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const root = process.cwd();
const W = 750;
const H = 1050;
const S = 2;

const FONTS = [
  "Fraunces-SemiBold",
  "Fraunces-Bold",
  "Fraunces-Black",
  "Fraunces-Text",
  "Manrope-Regular",
  "Manrope-Medium",
  "Manrope-SemiBold",
  "Manrope-Bold",
  "Manrope-ExtraBold",
].map((name) => path.join(root, "art/fonts/card", `${name}.ttf`));
FONTS.push(
  path.join(root, "art/fonts/IBMPlexMono-Regular.ttf"),
  path.join(root, "art/fonts/IBMPlexMono-SemiBold.ttf"),
);

const FD = '"Fraunces Display"';
const FT = '"Fraunces Text"';
const MS = '"Manrope Card"';
const PM = '"IBM Plex Mono"';

const MATERIALS = {
  plain: {
    label: "PLAIN",
    a: "#f2e8d6",
    b: "#cdbda2",
    c: "#9a886d",
    d: "#fffaf0",
    e: "#6a5b45",
    swatch: "#efe4d1",
    swatch2: "#cbbb9f",
    spec: 0.04,
  },
  silver: {
    label: "SILVER",
    a: "#f4fbff",
    b: "#c8d5dc",
    c: "#69767e",
    d: "#e4eef4",
    e: "#2f383e",
    swatch: "#e9f1f5",
    swatch2: "#93a2ab",
    spec: 0.38,
  },
  gold: {
    label: "GOLD",
    a: "#ffe9a3",
    b: "#e0af3f",
    c: "#9a6413",
    d: "#f7cf74",
    e: "#523405",
    swatch: "#ffe6a3",
    swatch2: "#b47c22",
    spec: 0.46,
  },
  diamond: {
    label: "HOLOGRAPHIC",
    a: "#9df0ff",
    b: "#ff9de0",
    c: "#6de0b0",
    d: "#f4ff9d",
    e: "#8d7bff",
    swatch: "#9df0ff",
    swatch2: "#e3a1ff",
    spec: 0.5,
  },
};

/* The catalogue uses `diamond` as the stored material key for holographic. */
function materialKey(value) {
  return value === "holo" || value === "diamond" ? "diamond" : value;
}

export function hasLivery(slug) {
  return Boolean(readLivery()[slug]);
}

let liveryCache = null;
function readLivery() {
  if (!liveryCache) {
    liveryCache = JSON.parse(
      fs.readFileSync(path.join(root, "src/data/collection-livery.json"), "utf8"),
    );
  }
  return liveryCache;
}

const THEME_DEFAULTS = {
  archive: {
    family: "archive",
    motif: "heart",
    plinth: "paper",
    display: "fraunces",
    ground: "#1b1418",
    paper: "#f5e9dc",
    paper2: "#eedcc8",
    ink: "#2a1f2b",
    accent: "#b4462f",
    accent2: "#7dab88",
    key: "#ffd9ad",
  },
  stage: {
    family: "stage",
    motif: "star",
    plinth: "dark",
    display: "manrope",
    ground: "#0b1022",
    paper: "#f7f2e8",
    paper2: "#e9e1d4",
    ink: "#0f1428",
    accent: "#38d6d0",
    accent2: "#f05a9e",
    key: "#a8f0ff",
  },
  manga: {
    family: "manga",
    motif: "bolt",
    plinth: "paper",
    display: "manrope",
    ground: "#171317",
    paper: "#f4eddc",
    paper2: "#e9dfca",
    ink: "#141014",
    accent: "#d9482f",
    accent2: "#f2c94c",
    key: "#ffd9a8",
  },
  broadcast: {
    family: "broadcast",
    motif: "signal",
    plinth: "dark",
    display: "manrope",
    ground: "#0a0f16",
    paper: "#f7f3e8",
    paper2: "#e8e0d2",
    ink: "#0b0f14",
    accent: "#f0b429",
    accent2: "#d9482f",
    key: "#ffd9a8",
  },
};

function liveryFor(slug, themeName) {
  const entry = readLivery()[slug] ?? {};
  const family = entry.family ?? entry.theme ?? themeName ?? "archive";
  const defaults = THEME_DEFAULTS[family] ?? THEME_DEFAULTS.archive;
  return {
    ...defaults,
    ...entry,
    family: defaults.family,
    slug,
    themeName: family,
  };
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(text, { size, maxWidth, factor = 0.52, maxLines = 2 }) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length * size * factor > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
  return kept;
}

function fitName(name, { maxWidth, basis = 84, min = 46, maxLines = 2, factor = 0.5 }) {
  let size = basis;
  let lines = wrap(name, { size, maxWidth, factor, maxLines });
  // A two-line title is set smaller than a one-line title; it is a title
  // block, not two full-size lines that collide with the collection line.
  if (lines.length > 1) size = Math.min(size, 64);
  lines = wrap(name, { size, maxWidth, factor, maxLines });
  while (
    size > min &&
    (lines.length > maxLines || lines.some((line) => line.length * size * factor > maxWidth))
  ) {
    size -= 2;
    lines = wrap(name, { size, maxWidth, factor, maxLines });
  }
  return { size, lines };
}

function dataUri(buffer, mime = "image/png") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function backgroundLayer(backgroundPath, box, { grade = 1 } = {}) {
  const bw = Math.round(box.w * S);
  const bh = Math.round(box.h * S);
  const buffer = await sharp(backgroundPath)
    .resize(bw, bh, { fit: "cover", position: "attention" })
    .modulate({ brightness: 0.92, saturation: 1.02 })
    .linear(grade, -(128 * grade) + 128)
    .png()
    .toBuffer();
  return { buffer, width: bw, height: bh };
}

/**
 * The subject is always the real sourced art. This only removes the white
 * matte fringe, un-premultiplies the anti-aliased edge and composes an authored
 * contact shadow and key light. The likeness is not altered.
 */
async function subjectLayer(subjectPath, targetHeight, { key, shadow = 0.5, rim = 0.32 } = {}) {
  const trimmed = await sharp(subjectPath).trim({ threshold: 12 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const height = Math.round(targetHeight * S);
  const width = Math.round((meta.width / meta.height) * height);
  const resized = await sharp(trimmed).resize({ height, width, fit: "fill" }).png().toBuffer();
  const raw = await sharp(resized).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const px = (x, y) => (y * info.width + x) * 4;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = px(x, y);
      if (data[i + 3] === 0) continue;
      if (data[i] < 225 || data[i + 1] < 225 || data[i + 2] < 225) continue;
      let touching = false;
      for (let dy = -1; dy <= 1 && !touching; dy += 1) {
        for (let dx = -1; dx <= 1 && !touching; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
          if (data[px(nx, ny) + 3] < 40) touching = true;
        }
      }
      if (touching) data[i + 3] = 0;
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a > 0 && a < 1) {
      for (let c = 0; c < 3; c += 1) {
        data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c] - 255 * (1 - a)) / a)));
      }
    }
  }
  const base = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  // A one-pixel ink contour hides the last of the white cutout matte and
  // seats the subject in the scene without redrawing the character.
  const outlineData = Buffer.from(data);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = px(x, y);
      if (outlineData[i + 3] !== 0) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy += 1) {
        for (let dx = -1; dx <= 1 && !edge; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) continue;
          if (data[px(nx, ny) + 3] > 180) edge = true;
        }
      }
      if (edge) {
        outlineData[i] = 32;
        outlineData[i + 1] = 22;
        outlineData[i + 2] = 30;
        outlineData[i + 3] = 150;
      }
    }
  }
  const outline = await sharp(outlineData, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();

  const pad = 90;
  const cw = width + pad * 2;
  const ch = height + pad * 2;
  const placed = await sharp({
    create: { width: cw, height: ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: base, left: pad, top: pad }])
    .png()
    .toBuffer();
  const glow = await sharp(placed).blur(34).tint(key).linear(1, -52).png().toBuffer();
  const shadowSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><ellipse cx="${cw / 2}" cy="${ch - pad - 6}" rx="${width * 0.4}" ry="${height * 0.03}" fill="#000" opacity="${shadow}" filter="url(#b)"/><defs><filter id="b" x="-40%" y="-500%" width="180%" height="1100%"><feGaussianBlur stdDeviation="22"/></filter></defs></svg>`,
  );
  const layer = await sharp({
    create: { width: cw, height: ch, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: shadowSvg, left: 0, top: 0 },
      { input: glow, left: 0, top: 0, blend: "over" },
      { input: outline, left: pad, top: pad, blend: "over" },
      { input: base, left: pad, top: pad },
    ])
    .png()
    .toBuffer();
  return { buffer: layer, width: cw, height: ch, pad, artWidth: width, artHeight: height };
}

async function markData(markPath, markBuffer, markMime, crop) {
  let bytes =
    markBuffer ?? (markPath && fs.existsSync(markPath) ? fs.readFileSync(markPath) : null);
  if (!bytes) return { uri: "", aspect: 1 };
  if (crop) {
    const meta = await sharp(bytes).metadata();
    bytes = await sharp(bytes)
      .extract({
        left: Math.round((meta.width ?? 0) * crop.x),
        top: Math.round((meta.height ?? 0) * crop.y),
        width: Math.round((meta.width ?? 0) * crop.w),
        height: Math.round((meta.height ?? 0) * crop.h),
      })
      .toBuffer();
  }
  const meta = await sharp(bytes).metadata();
  return {
    uri: dataUri(bytes, markMime ?? "image/png"),
    aspect: meta.width && meta.height ? meta.width / meta.height : 1,
  };
}

function metalDefs(material) {
  const m = MATERIALS[material];
  return `
  <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${m.a}"/><stop offset=".16" stop-color="${m.b}"/>
    <stop offset=".31" stop-color="${m.c}"/><stop offset=".47" stop-color="${m.d}"/>
    <stop offset=".62" stop-color="${m.b}"/><stop offset=".78" stop-color="${m.e}"/>
    <stop offset="1" stop-color="${m.a}"/>
  </linearGradient>
  <linearGradient id="metalFlat" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${m.b}"/><stop offset=".35" stop-color="${m.d}"/>
    <stop offset=".7" stop-color="${m.a}"/><stop offset="1" stop-color="${m.c}"/>
  </linearGradient>
  <linearGradient id="metalSheen" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/>
    <stop offset=".42" stop-color="#fff" stop-opacity="${m.spec}"/>
    <stop offset=".52" stop-color="#fff" stop-opacity="0"/>
    <stop offset=".74" stop-color="#fff" stop-opacity="${m.spec * 0.6}"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>`;
}

function edgeFrame(material, { radius = 14, width = 15 } = {}) {
  const m = MATERIALS[material];
  if (material === "plain") {
    return `
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${radius}" fill="none" stroke="#d6c6ae" stroke-width="${width}"/>
    <rect x="${width - 1}" y="${width - 1}" width="${W - (width - 1) * 2}" height="${H - (width - 1) * 2}" rx="${Math.max(2, radius - 3)}" fill="none" stroke="#fffaf0" stroke-opacity=".6" stroke-width="1.1"/>
    <rect x="${width + 0.8}" y="${width + 0.8}" width="${W - (width + 0.8) * 2}" height="${H - (width + 0.8) * 2}" rx="${Math.max(2, radius - 3)}" fill="none" stroke="#7b6a50" stroke-opacity=".55" stroke-width="1.2"/>
    <rect x="0.6" y="0.6" width="${W - 1.2}" height="${H - 1.2}" rx="${radius}" fill="none" stroke="#5d5140" stroke-opacity=".4" stroke-width="1"/>`;
  }
  const bands =
    material === "diamond"
      ? { dark: "#4b5fa0", mid: "url(#prism)", light: "#f2ffd0", hi: "#ffffff" }
      : { dark: m.e, mid: m.c, light: m.b, hi: m.d };
  return `
  ${material === "diamond" ? `<linearGradient id="prism" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8be9ff"/><stop offset=".18" stop-color="#b18cff"/><stop offset=".34" stop-color="#ff9de0"/><stop offset=".5" stop-color="#ffe98a"/><stop offset=".66" stop-color="#8bffc9"/><stop offset=".82" stop-color="#8fb0ff"/><stop offset="1" stop-color="#f0ff9d"/></linearGradient>` : ""}
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="${radius}" fill="none" stroke="${bands.dark}" stroke-width="${width + 1}" stroke-opacity=".9"/>
  <rect x="${1 + (width + 1) / 2 - width / 2}" y="${1 + (width + 1) / 2 - width / 2}" width="${W - (width + 1)}" height="${H - (width + 1)}" rx="${Math.max(3, radius - 2)}" fill="none" stroke="${bands.mid}" stroke-width="${width}" opacity=".95"/>
  <rect x="${1 + width * 0.62}" y="${1 + width * 0.62}" width="${W - 2 - width * 1.24}" height="${H - 2 - width * 1.24}" rx="${Math.max(3, radius - 2)}" fill="none" stroke="${bands.light}" stroke-width="${width * 0.42}" opacity=".85"/>
  <rect x="${2 + width * 0.92}" y="${2 + width * 0.92}" width="${W - 4 - width * 1.84}" height="${H - 4 - width * 1.84}" rx="${Math.max(3, radius - 3)}" fill="none" stroke="${bands.hi}" stroke-width="1.3" opacity=".95"/>
  <rect x="${width + 1.6}" y="${width + 1.6}" width="${W - (width + 1.6) * 2}" height="${H - (width + 1.6) * 2}" rx="${Math.max(3, radius - 3)}" fill="none" stroke="#000" stroke-opacity=".42" stroke-width="1.2"/>
  <rect x="0.6" y="0.6" width="${W - 1.2}" height="${H - 1.2}" rx="${radius}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="1.2"/>
  <mask id="edgeMask">
    <rect x="0" y="0" width="${W}" height="${H}" rx="${radius}" fill="#fff"/>
    <rect x="${width + 2}" y="${width + 2}" width="${W - (width + 2) * 2}" height="${H - (width + 2) * 2}" rx="${Math.max(3, radius - 3)}" fill="#000"/>
  </mask>
  <g mask="url(#edgeMask)"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#metalSheen)"/></g>`;
}

function motif(kind, x, y, r, fill, opacity = 1) {
  if (kind === "heart") {
    return `<g transform="translate(${x} ${y}) scale(${r / 10})" fill="${fill}" opacity="${opacity}"><path d="M0 8.4 C-9 1.4 -10 -3.6 -6.8 -6.4 C-3.8 -9 -0.8 -7.2 0 -4.6 C0.8 -7.2 3.8 -9 6.8 -6.4 C10 -3.6 9 1.4 0 8.4Z"/></g>`;
  }
  if (kind === "star") {
    return `<g transform="translate(${x} ${y})" fill="${fill}" opacity="${opacity}"><path d="M0 ${-r} C ${r * 0.1} ${-r * 0.24} ${r * 0.24} ${-r * 0.1} ${r} 0 C ${r * 0.24} ${r * 0.1} ${r * 0.1} ${r * 0.24} 0 ${r} C ${-r * 0.1} ${r * 0.24} ${-r * 0.24} ${r * 0.1} ${-r} 0 C ${-r * 0.24} ${-r * 0.1} ${-r * 0.1} ${-r * 0.24} 0 ${-r}Z"/><circle cx="${r * 0.72}" cy="${-r * 0.72}" r="${r * 0.14}"/></g>`;
  }
  if (kind === "claw") {
    return `<g transform="translate(${x} ${y}) rotate(-18)" fill="none" stroke="${fill}" stroke-width="${Math.max(1.4, r * 0.2)}" stroke-linecap="round" opacity="${opacity}">
      <path d="M${-r * 0.9} ${r * 0.55} Q${-r * 0.2} ${-r * 0.2} ${r * 0.45} ${-r * 0.85}"/>
      <path d="M${-r * 0.45} ${r * 0.85} Q${r * 0.15} ${r * 0.1} ${r * 0.8} ${-r * 0.5}"/>
      <path d="M${r * 0.05} ${r * 1.0} Q${r * 0.55} ${r * 0.45} ${r * 0.95} ${-r * 0.05}"/>
    </g>`;
  }
  if (kind === "bolt") {
    return `<g transform="translate(${x} ${y}) scale(${r / 12})" fill="${fill}" opacity="${opacity}"><path d="M2 -12 L-7 2 H-1 L-3 12 L7 -3 H1Z"/></g>`;
  }
  if (kind === "signal") {
    return `<g transform="translate(${x} ${y})" fill="none" stroke="${fill}" stroke-width="${Math.max(1, r * 0.18)}" opacity="${opacity}"><path d="M${-r} ${r * 0.35} A ${r} ${r} 0 0 1 ${r} ${r * 0.35}"/><path d="M${-r * 0.66} ${r * 0.58} A ${r * 0.66} ${r * 0.66} 0 0 1 ${r * 0.66} ${r * 0.58}"/><circle cx="0" cy="${r * 0.7}" r="${r * 0.12}" fill="${fill}" stroke="none"/></g>`;
  }
  return `<g transform="translate(${x} ${y})" stroke="${fill}" stroke-width="${Math.max(1, r * 0.14)}" opacity="${opacity}"><path d="M${-r} ${r * 0.4} L${r * 0.4} ${-r}"/><path d="M${-r} ${r * 0.78} L${r * 0.78} ${-r}"/><rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" fill="none"/></g>`;
}

function seal(material, theme, { x, y, size }) {
  const r = size / 2;
  const foil = material !== "plain";
  return `<g>
    <circle cx="${x}" cy="${y}" r="${r}" fill="${theme.paper}" stroke="${foil ? "url(#metalFlat)" : theme.ink}" stroke-opacity="${foil ? 1 : 0.45}" stroke-width="${size * 0.055}"/>
    <circle cx="${x}" cy="${y}" r="${r - size * 0.1}" fill="none" stroke="${theme.ink}" stroke-opacity=".22" stroke-width=".8"/>
    ${motif(theme.motif, x, y, r * 0.44, foil ? "url(#metalFlat)" : theme.ink, foil ? 1 : 0.55)}
  </g>`;
}

function foilRule(x1, y, x2, material, thickness = 1.4) {
  return `<rect x="${x1}" y="${y}" width="${x2 - x1}" height="${thickness}" fill="url(#metalFlat)"/>
  <rect x="${x1}" y="${y + thickness}" width="${x2 - x1}" height=".8" fill="#000" opacity=".28"/>`;
}

function embossRule(x1, y, x2, colour) {
  return `<rect x="${x1}" y="${y}" width="${x2 - x1}" height="1" fill="${colour}" opacity=".28"/>
  <rect x="${x1}" y="${y + 1}" width="${x2 - x1}" height="1" fill="#fff" opacity=".5"/>`;
}

function finishLabel(material, theme, size = 15.4) {
  const m = MATERIALS[material];
  const label = material === "diamond" ? "HOLOGRAPHIC" : m.label;
  const r = size * 0.49;
  return `<g transform="translate(0 0)">
    <circle cx="${r}" cy="0" r="${r}" fill="${m.swatch}" stroke="${m.swatch2}" stroke-width="1"/>
    <circle cx="${r * 0.68}" cy="${-r * 0.34}" r="${r * 0.45}" fill="${m.a}" opacity=".9"/>
    <text x="${r * 2 + 6}" y="${size * 0.35}" font-family=${PM} font-size="${size}" font-weight="600" letter-spacing="1.4" fill="${theme.ink}">${esc(label)}</text>
  </g>`;
}

function markPlate(theme, { x, y, height, plate = "paper" }) {
  if (theme.badge === "round" || (theme.markAspect > 0.92 && theme.markAspect < 1.08)) {
    return `<g transform="translate(${x} ${y})"><circle cx="${height / 2}" cy="${height / 2}" r="${height / 2}" fill="${theme.paper}" stroke="url(#metalFlat)" stroke-width="2.4"/><image href="${theme.markUri}" x="3" y="3" width="${height - 6}" height="${height - 6}" preserveAspectRatio="xMidYMid meet"/></g>`;
  }
  const width = Math.min(250, Math.max(height, height * theme.markAspect));
  const fill = plate === "dark" ? theme.ink : theme.paper;
  return `<g transform="translate(${x} ${y})"><rect width="${width}" height="${height}" rx="2" fill="${fill}"/><image href="${theme.markUri}" x="6" y="6" width="${width - 12}" height="${height - 12}" preserveAspectRatio="xMidYMid meet"/></g>`;
}

function stageDeco(material, theme) {
  const m = MATERIALS[material];
  return `
  <rect x="0" y="16" width="750" height="26" fill="${theme.ink}" opacity=".9"/>
  <rect x="0" y="42" width="750" height="2" fill="url(#metalFlat)"/>
  ${Array.from({ length: 24 }, (_, i) => `<circle cx="${20 + i * 31}" cy="29" r="3" fill="${i % 3 === 0 ? theme.accent2 : m.d}" opacity="${i % 3 === 0 ? 0.95 : 0.7}"/>`).join("")}
  <rect x="0" y="44" width="10" height="732" fill="url(#curtain)"/>
  <rect x="740" y="44" width="10" height="732" fill="url(#curtain)"/>`;
}

function mangaDeco(theme) {
  return `
  <rect x="18" y="18" width="714" height="744" fill="none" stroke="${theme.ink}" stroke-width="14"/>
  <rect x="27" y="27" width="696" height="726" fill="none" stroke="${theme.paper}" stroke-opacity=".4" stroke-width="1"/>
  <rect x="640" y="640" width="88" height="88" fill="url(#halftone)" opacity=".5"/>`;
}

function archiveDeco(material, theme) {
  const foil = material !== "plain" ? "url(#metalFlat)" : theme.ink;
  return `
  <rect x="22" y="22" width="706" height="732" fill="none" stroke="${theme.accent}" stroke-opacity=".55" stroke-width="1.3" stroke-dasharray="3 6"/>
  <g fill="none" stroke="${foil}" stroke-width="2.2" opacity=".95">
    <path d="M30 62 V30 H62"/><path d="M688 30 H720 V62"/>
    <path d="M30 714 V746 H62"/><path d="M688 746 H720 V714"/>
  </g>`;
}

function readingRoomTypeSize(text, width, size) {
  return Math.min(size, Math.floor(width / (text.length * 0.56)));
}

function readingRoomFront(theme, material, art, subject, data) {
  const nameSize = readingRoomTypeSize(data.name, 630, 100);
  const roleSize = readingRoomTypeSize(data.role, 650, 30);
  const subjectX = (W - subject.width / S) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${metalDefs(material)}
    <clipPath id="window"><rect x="22" y="22" width="706" height="740" rx="3"/></clipPath>
    <linearGradient id="paper" x2="0" y2="1">
      <stop stop-color="#fff9ef"/><stop offset="1" stop-color="#f1decd"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#paper)"/>
  <g clip-path="url(#window)">
    <image href="${art.uri}" width="750" height="776"/>
    <image href="${subject.uri}" x="${subjectX}" y="${data.subjectTop}" width="${subject.width / S}" height="${subject.height / S}"/>
  </g>
  ${markPlate(theme, { x: 44, y: 44, height: 108 })}
  <path d="M22 762 H728" stroke="url(#metalFlat)" stroke-width="5"/>
  <text x="46" y="866" font-family=${FD} font-size="${nameSize}" font-weight="700" fill="${theme.ink}">${esc(data.name)}</text>
  <text x="48" y="913" font-family=${MS} font-size="${roleSize}" font-weight="600" fill="#5b374c">${esc(data.role)}</text>
  <path d="M48 939 H702" stroke="#987080" stroke-opacity=".56" stroke-width="2"/>
  <text x="48" y="984" font-family=${MS} font-size="34" font-weight="750" fill="${theme.ink}">${esc(data.rarity)}</text>
  <g transform="translate(48 1010)">${finishLabel(material, theme, 25)}</g>
  <text x="702" y="1019" text-anchor="end" font-family=${PM} font-size="26" fill="#5b374c">${esc(data.serial)}</text>
  ${edgeFrame(material, { width: 19 })}
</svg>`;
}

function readingRoomBack(theme, material, data) {
  const nameSize = readingRoomTypeSize(data.name, 630, 89);
  const roleSize = readingRoomTypeSize(data.role, 610, 30);
  const bio = wrap(data.bio, { size: 35, maxWidth: 590, factor: 0.53, maxLines: 8 });
  const credit = wrap(data.provenanceLong, {
    size: 22,
    maxWidth: 595,
    factor: 0.53,
    maxLines: 5,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${metalDefs(material)}</defs>
  <rect width="${W}" height="${H}" fill="#f6e4d6"/>
  <rect x="26" y="26" width="698" height="998" rx="5" fill="#fff8ee" stroke="#b8899a" stroke-width="2"/>
  ${markPlate(theme, { x: 66, y: 60, height: 118 })}
  <text x="210" y="113" font-family=${MS} font-size="34" font-weight="750" fill="${theme.ink}">${esc(data.collection)}</text>
  <text x="212" y="151" font-family=${PM} font-size="25" fill="#6f4059">${esc(data.era)}</text>
  <path d="M66 204 H684" stroke="url(#metalFlat)" stroke-width="4"/>
  <text x="65" y="310" font-family=${FD} font-size="${nameSize}" font-weight="700" fill="${theme.ink}">${esc(data.name)}</text>
  <text x="68" y="362" font-family=${MS} font-size="${roleSize}" font-weight="600" fill="#5b374c">${esc(data.role)}</text>
  <text x="68" y="448" font-family=${MS} font-size="35" fill="${theme.ink}">
    ${bio.map((line, i) => `<tspan x="68" y="${448 + 46 * i}">${esc(line)}</tspan>`).join("")}
  </text>
  <path d="M68 817 H682" stroke="#987080" stroke-opacity=".64" stroke-width="2"/>
  <text x="68" y="862" font-family=${MS} font-size="30" font-weight="750" fill="${theme.ink}">${esc(data.rarity)}</text>
  <g transform="translate(68 896)">${finishLabel(material, theme, 25)}</g>
  <text x="682" y="904" text-anchor="end" font-family=${PM} font-size="26" fill="#5b374c">${esc(data.serial)}</text>
  <text x="68" y="925" font-family=${MS} font-size="22" fill="#5b374c">
    ${credit.map((line, i) => `<tspan x="68" y="${925 + 22 * i}">${esc(line)}</tspan>`).join("")}
  </text>
  ${edgeFrame(material, { width: 19 })}
</svg>`;
}

function frontSvg(theme, material, art, subject, data) {
  const m = MATERIALS[material];
  const family = theme.family;
  const dark = theme.plinth === "dark";
  const pt = dark ? { ...theme, paper: theme.ground, paper2: "#150e15", ink: theme.paper } : theme;
  const display = theme.display === "manrope" ? MS : FD;
  const upper = theme.display === "manrope";
  const name = fitName(upper ? data.name.toUpperCase() : data.name, {
    maxWidth: 530,
    basis: data.name.length <= 15 ? 92 : 54,
    min: 46,
    factor: upper ? 0.58 : 0.5,
  });
  const lineH = name.size * 0.88;
  const oneLine = name.lines.length === 1;
  const first = oneLine ? 904 : 876;
  const last = first + (name.lines.length - 1) * lineH;
  const roleY = last + 30;
  const provY = roleY + 22;
  const ruleY = provY + 12;
  const metaY = ruleY + 30;
  const footY = metaY + 24;
  const roleLines = wrap(data.role, { size: 18, maxWidth: 630, factor: 0.52, maxLines: 1 });
  const roleMarkup = roleLines
    .map(
      (line, i) =>
        `<text x="34" y="${roleY + i * 22}" font-family=${MS} font-weight="500" font-size="18.6" fill="${pt.ink}" opacity=".8">${esc(line)}</text>`,
    )
    .join("");
  const collectionX = theme.badge === "round" ? 32 : 32;
  const badgeHeight = family === "stage" ? 56 : family === "manga" ? 64 : 92;
  const badgePlate = family === "stage" ? "dark" : family === "manga" ? "dark" : "paper";
  const badge = markPlate(theme, {
    x: 34,
    y: family === "stage" ? 20 : 34,
    height: badgeHeight,
    plate: badgePlate,
  });
  return `
  <defs>${metalDefs(material)}
    <linearGradient id="plinth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pt.paper}"/><stop offset=".62" stop-color="${pt.paper}"/><stop offset="1" stop-color="${pt.paper2}"/></linearGradient>
    <linearGradient id="plinthDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${theme.ground}"/><stop offset=".7" stop-color="${theme.ground}"/><stop offset="1" stop-color="#120b12"/></linearGradient>
    <radialGradient id="spot" cx="50%" cy="40%" r="62%"><stop offset="0" stop-color="${theme.key}" stop-opacity=".26"/><stop offset=".45" stop-color="${theme.key}" stop-opacity=".08"/><stop offset="1" stop-color="${theme.key}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vignette" cx="50%" cy="44%" r="74%"><stop offset=".5" stop-color="${theme.ground}" stop-opacity="0"/><stop offset=".8" stop-color="${theme.ground}" stop-opacity=".28"/><stop offset="1" stop-color="${theme.ground}" stop-opacity=".86"/></radialGradient>
    <linearGradient id="deepen" x1="0" y1="0" x2="0" y2="1"><stop offset=".5" stop-color="${theme.ground}" stop-opacity="0"/><stop offset="1" stop-color="${theme.ground}" stop-opacity=".62"/></linearGradient>
    <linearGradient id="grade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${theme.accent}" stop-opacity=".1"/><stop offset=".55" stop-color="${theme.accent}" stop-opacity="0"/><stop offset="1" stop-color="${theme.ground}" stop-opacity=".36"/></linearGradient>
    <linearGradient id="cast" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".7" stop-color="#000" stop-opacity=".26"/><stop offset="1" stop-color="#000" stop-opacity=".48"/></linearGradient>
    <linearGradient id="inTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
    <linearGradient id="inLeft" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
    <linearGradient id="inRight" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
    <linearGradient id="curtain" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${theme.ink}" stop-opacity=".85"/><stop offset="1" stop-color="${theme.accent2}" stop-opacity=".28"/></linearGradient>
    <pattern id="clubDots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="6" cy="6" r="2.2" fill="${theme.accent}" opacity=".5"/></pattern>
    <pattern id="halftone" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1.5" fill="${theme.ink}" opacity=".35"/></pattern>
    ${material === "diamond" ? `<linearGradient id="holoWash" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8be9ff" stop-opacity=".2"/><stop offset=".32" stop-color="#ff9de0" stop-opacity=".12"/><stop offset=".62" stop-color="#f4ff9d" stop-opacity=".1"/><stop offset="1" stop-color="#b18cff" stop-opacity=".2"/></linearGradient>` : ""}
  </defs>
  <rect width="${W}" height="${H}" fill="${theme.ground}"/>
  <image href="${art.uri}" x="0" y="0" width="750" height="776" preserveAspectRatio="xMidYMid slice"/>
  <rect width="750" height="776" fill="url(#spot)"/>
  <rect width="750" height="776" fill="url(#grade)"/>
  <rect width="750" height="776" fill="url(#vignette)"/>
  <rect y="480" width="750" height="296" fill="url(#deepen)"/>
  <image href="${subject.uri}" x="${375 + (data.offsetX ?? 0) - subject.width / S / 2}" y="${(data.subjectTop ?? (theme.family === "manga" ? 66 : theme.family === "stage" ? 40 : 16)) - subject.pad / S}" width="${subject.width / S}" height="${subject.height / S}"/>
  ${material === "diamond" ? `<rect width="750" height="776" fill="url(#holoWash)"/>` : ""}
  ${family === "stage" ? stageDeco(material, theme) : family === "manga" ? mangaDeco(theme) : archiveDeco(material, theme)}
  ${family !== "stage" ? `<rect x="0" y="742" width="750" height="34" fill="url(#cast)"/>` : ""}
  <rect x="0" y="776" width="750" height="274" fill="url(#${dark ? "plinthDark" : "plinth"})"/>
  ${dark ? `<rect x="0" y="776" width="750" height="274" fill="url(#clubDots)" opacity=".09"/>` : `<rect x="0" y="776" width="750" height="274" fill="url(#halftone)" opacity=".12"/>`}
  <rect x="0" y="776" width="750" height="${family === "manga" ? 10 : 8}" fill="${theme.accent}"/>
  <rect x="0" y="${family === "manga" ? 786 : 784}" width="750" height="2" fill="#000" opacity=".24"/>
  <rect x="18" y="795" width="714" height="238" fill="none" stroke="${pt.ink}" stroke-opacity=".16" stroke-width="1"/>
  <rect x="19" y="796" width="712" height="236" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="1"/>
  <rect x="26" y="803" width="698" height="222" fill="none" stroke="${theme.accent}" stroke-opacity=".38" stroke-width="1.1" stroke-dasharray="3 6"/>
  ${badge}
  <text x="32" y="806" font-family=${PM} font-weight="600" font-size="15.2" letter-spacing="1.2" fill="${pt.ink}">${esc(data.collection.toUpperCase())}</text>
  <text x="32" y="823" font-family=${PM} font-size="9.8" letter-spacing="2.1" fill="${theme.accent}">${esc(data.era)}</text>
  ${seal(material, theme, { x: 684, y: 814, size: 54 })}
  <text x="32" y="${first}" font-family=${display} font-weight="${upper ? 800 : 700}" font-size="${name.size}" letter-spacing="${upper ? -1.6 : -2}" fill="${pt.ink}">${name.lines.map((line, i) => `<tspan x="32" dy="${i === 0 ? 0 : lineH}">${esc(line)}</tspan>`).join("")}</text>
  ${roleMarkup}
  <text x="34" y="${provY}" font-family=${PM} font-size="9.4" letter-spacing="1.8" fill="${pt.ink}" opacity=".5">${esc(data.provenance)}</text>
  ${embossRule(32, ruleY, 718, pt.ink)}
  <text x="32" y="${metaY}" font-family=${MS} font-weight="800" font-size="29" letter-spacing=".2" fill="${pt.ink}">${esc(data.rarity.toUpperCase())}</text>
  <g transform="translate(258 ${metaY - 7})">${finishLabel(material, pt, 23)}</g>
  <text x="718" y="${metaY}" text-anchor="end" font-family=${PM} font-weight="600" font-size="29" letter-spacing="1" fill="${pt.ink}">${esc(data.serial)}</text>
  ${footY <= 1032 ? `<text x="32" y="${footY}" font-family=${PM} font-size="8.6" letter-spacing="2.5" fill="${pt.ink}" opacity=".45">FOILBURY · ${esc(data.slug.toUpperCase())}</text><text x="718" y="${footY}" text-anchor="end" font-family=${PM} font-size="8.6" letter-spacing="2.5" fill="${pt.ink}" opacity=".45">${esc(m.label)} EDITION</text>` : ""}
  ${edgeFrame(material, { radius: family === "manga" ? 4 : 14, width: 15 })}
  <rect x="18" y="18" width="714" height="1014" rx="${family === "manga" ? 2 : 6}" fill="none" stroke="${theme.paper}" stroke-opacity=".26" stroke-width="1"/>`;
}

function backSvg(theme, material, data) {
  const m = MATERIALS[material];
  const dark = (theme.backSurface ?? theme.plinth) === "dark";
  const ink = dark ? theme.paper : theme.ink;
  const paper = dark ? theme.ground : theme.paper;
  const display = theme.display === "manrope" ? MS : FD;
  const upper = theme.display === "manrope";
  const name = fitName(upper ? data.name.toUpperCase() : data.name, {
    maxWidth: 470,
    basis: 78,
    min: 48,
    factor: upper ? 0.58 : 0.5,
  });
  const lineH = name.size * 0.92;
  const bioLines = wrap(data.bio, { size: 18, maxWidth: 470, factor: 0.5, maxLines: 5 });
  const bio = bioLines
    .map((line, i) => `<tspan x="44" dy="${i === 0 ? 0 : 28}">${esc(line)}</tspan>`)
    .join("");
  const provLines = wrap(data.provenanceLong, {
    size: 12.4,
    maxWidth: 400,
    factor: 0.5,
    maxLines: 4,
  });
  const setCode = data.setCode;
  return `
  <defs>${metalDefs(material)}
    <pattern id="backDots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="5" cy="5" r="2" fill="${theme.accent}" opacity=".55"/></pattern>
    <pattern id="backRule" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="none"/><rect y="5" width="6" height=".6" fill="${ink}" opacity=".08"/></pattern>
    <pattern id="backHalftone" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.6" fill="${ink}" opacity=".22"/></pattern>
  </defs>
  <rect width="750" height="1050" fill="${paper}"/>
  ${dark ? `<rect width="750" height="1050" fill="url(#backHalftone)" opacity=".35"/>` : `<rect width="750" height="1050" fill="url(#backRule)"/><rect width="750" height="1050" fill="url(#backDots)" opacity=".08"/>`}
  <g opacity=".045" transform="translate(415 470)">${motif(theme.motif, 0, 0, 170, ink)}</g>
  <rect x="0" y="0" width="12" height="1050" fill="${theme.accent}"/>
  ${markPlate(theme, { x: 44, y: theme.markAspect > 1.2 ? 40 : 44, height: theme.markAspect > 1.2 ? 40 : 68, plate: dark ? "dark" : "paper" })}
  <text x="${theme.markAspect > 1.2 ? 44 : 126}" y="${theme.markAspect > 1.2 ? 108 : 68}" font-family=${PM} font-weight="600" font-size="15" letter-spacing="1.1" fill="${ink}">${esc(data.collection.toUpperCase())}</text>
  <text x="${theme.markAspect > 1.2 ? 44 : 126}" y="${theme.markAspect > 1.2 ? 126 : 88}" font-family=${PM} font-size="9.6" letter-spacing="2.2" fill="${theme.accent}">${esc(data.era)} · REVERSE</text>
  <text x="706" y="68" text-anchor="end" font-family=${PM} font-size="9.6" letter-spacing="2.2" fill="${ink}" opacity=".55">MEMBER ARCHIVE</text>
  <text x="706" y="88" text-anchor="end" font-family=${PM} font-size="9.6" letter-spacing="2.2" fill="${ink}" opacity=".55">NOT OFFICIAL</text>
  ${foilRule(44, theme.markAspect > 1.2 ? 148 : 140, 706, material, 2.4)}
  <text x="42" y="232" font-family=${display} font-weight="${upper ? 800 : 700}" font-size="${name.size}" letter-spacing="${upper ? -1.6 : -2}" fill="${ink}">${name.lines.map((line, i) => `<tspan x="42" dy="${i === 0 ? 0 : lineH}">${esc(line)}</tspan>`).join("")}</text>
  <text x="44" y="${232 + (name.lines.length - 1) * lineH + 30}" font-family=${MS} font-weight="500" font-size="18.4" fill="${ink}" opacity=".72">${esc(data.role)}</text>
  <text x="44" y="352" font-family=${MS} font-weight="500" font-size="18" fill="${ink}" opacity=".88">${bio}</text>
  ${seal(material, theme, { x: 614, y: 372, size: 118 })}
  <text x="614" y="446" text-anchor="middle" font-family=${PM} font-size="8.4" letter-spacing="2.2" fill="${ink}" opacity=".5">SET MARK</text>
  ${embossRule(44, 528, 706, ink)}
  <text x="44" y="562" font-family=${PM} font-size="9.2" letter-spacing="2.4" fill="${theme.accent}">RARITY</text>
  <text x="44" y="592" font-family=${MS} font-weight="800" font-size="26" letter-spacing=".2" fill="${ink}">${esc(data.rarity.toUpperCase())}</text>
  <text x="44" y="634" font-family=${PM} font-size="9.2" letter-spacing="2.4" fill="${theme.accent}">COLLECTION</text>
  <text x="44" y="656" font-family=${display} font-weight="600" font-size="19" fill="${ink}">${esc(data.collection)}</text>
  <text x="44" y="696" font-family=${PM} font-size="9.2" letter-spacing="2.4" fill="${theme.accent}">EDITION</text>
  <text x="44" y="718" font-family=${MS} font-weight="600" font-size="15.4" fill="${ink}">${esc(data.edition)}</text>
  <text x="44" y="758" font-family=${PM} font-size="9.2" letter-spacing="2.4" fill="${theme.accent}">PROVENANCE</text>
  <text x="44" y="779" font-family=${MS} font-weight="500" font-size="12.4" fill="${ink}" opacity=".78">${provLines.map((line, i) => `<tspan x="44" dy="${i === 0 ? 0 : 17}">${esc(line)}</tspan>`).join("")}</text>
  <g transform="translate(468 548)">
    <rect width="238" height="188" fill="none" stroke="${ink}" stroke-opacity=".3" stroke-width="1"/>
    <rect x="6" y="6" width="226" height="176" fill="none" stroke="${theme.accent}" stroke-opacity=".45" stroke-width="1" stroke-dasharray="3 6"/>
    <text x="18" y="28" font-family=${PM} font-size="8.8" letter-spacing="2.4" fill="${ink}" opacity=".55">PRINT</text>
    <text x="18" y="66" font-family=${PM} font-weight="600" font-size="22" letter-spacing="1" fill="${ink}">${esc(data.serial)}</text>
    <rect x="18" y="80" width="202" height="1" fill="${ink}" opacity=".24"/>
    <text x="18" y="102" font-family=${PM} font-size="8.8" letter-spacing="2.4" fill="${ink}" opacity=".55">FINISH</text>
    <text x="18" y="122" font-family=${PM} font-weight="600" font-size="13.4" letter-spacing="1.4" fill="${ink}">${esc(m.label)}</text>
    <text x="18" y="148" font-family=${PM} font-size="8.8" letter-spacing="2.4" fill="${ink}" opacity=".55">SET</text>
    <text x="18" y="168" font-family=${PM} font-weight="600" font-size="13.4" letter-spacing="1.4" fill="${ink}">${esc(setCode)} · 01</text>
    <circle cx="212" cy="158" r="16" fill="none" stroke="url(#metalFlat)" stroke-width="2"/>
    ${motif(theme.motif, 212, 158, 7, "url(#metalFlat)")}
  </g>
  ${foilRule(44, 848, 706, material, 1.4)}
  <text x="44" y="892" font-family=${PM} font-size="9.2" letter-spacing="2.4" fill="${theme.accent}">SET LINE</text>
  <text x="44" y="918" font-family=${display} font-weight="600" font-size="21" fill="${ink}">${esc(data.setLine)}</text>
  <text x="44" y="944" font-family=${MS} font-weight="500" font-size="13.6" fill="${ink}" opacity=".68">${esc(data.setNote)}</text>
  <text x="44" y="1002" font-family=${PM} font-size="9.2" letter-spacing="2.6" fill="${ink}" opacity=".45">FOILBURY · MEMBER ARCHIVE · NOT OFFICIAL</text>
  <text x="706" y="1002" text-anchor="end" font-family=${PM} font-size="9.2" letter-spacing="2.6" fill="${ink}" opacity=".45">${esc(m.label)} EDITION</text>
  ${edgeFrame(material, { radius: theme.family === "manga" ? 4 : 14, width: 15 })}
  <rect x="24" y="24" width="702" height="1002" fill="none" stroke="${theme.accent}" stroke-opacity=".35" stroke-width="1.1" stroke-dasharray="3 6"/>`;
}

function grainBuffer() {
  const width = W * S;
  const height = H * S;
  const data = Buffer.alloc(width * height);
  let seed = 1337;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = 116 + ((seed >>> 24) % 24);
  }
  return sharp(data, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

function render(svg, width = W * S) {
  return new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * S}" height="${H * S}" viewBox="0 0 ${W} ${H}">${svg}</svg>`,
    {
      fitTo: { mode: "width", value: width },
      font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Manrope Card" },
      background: "rgba(0,0,0,0)",
    },
  )
    .render()
    .asPng();
}

function serialiseData(input, theme) {
  const parts = String(input.serial ?? "").split(" · ");
  const serial = input.catalogueCode ?? parts[0] ?? "MEMBER EDITION";
  const subtitleParts = String(input.subtitle ?? "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  const className = String(input.className ?? "").trim();
  const epithet = subtitleParts.find(
    (part) => part !== className && !/\(\d{4}\)/.test(part) && !/^trigger happy/i.test(part),
  );
  const role =
    className && subtitleParts.length
      ? epithet
        ? `${className} · ${epithet}`
        : className
      : subtitleParts.length > 1 && /\(\d{4}\)/.test(subtitleParts[0])
        ? subtitleParts.slice(1).join(" · ")
        : input.subtitle || className || "Member";
  const cardEra =
    input.cardEra ??
    (subtitleParts[0] && /\(\d{4}\)/.test(subtitleParts[0]) ? subtitleParts[0] : theme.era);
  return {
    name: input.name ?? "Untitled",
    role,
    collection: input.collectionName ?? theme.collectionName ?? input.setName ?? "Foilbury",
    era: cardEra ?? "MEMBER ARCHIVE",
    rarity: input.rarity || "Cabinet Rare",
    serial,
    edition: input.edition || parts[1] || "Member archive",
    provenance: input.provenance ?? "MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL",
    provenanceLong:
      input.provenanceLong ??
      "Third-party character art, sourced from the fan wiki and credited. Private, non-commercial member album; not licensed or official.",
    bio:
      input.bio ??
      "A member of the cabinet. This record keeps the card's real name, game context and collection provenance.",
    slug: input.collectionSlug,
    setLine: theme.setLine ?? "",
    setNote: theme.setNote ?? "",
    setCode:
      input.setCode ??
      String(input.collectionSlug ?? "FB")
        .split("-")
        .map((part) => part[0])
        .join("")
        .toUpperCase(),
  };
}

export async function renderFront(input) {
  const theme = liveryFor(input.collectionSlug, input.collectionTheme);
  const material = materialKey(
    input.effect === "holographic" ? "diamond" : (input.material ?? "plain"),
  );
  const mark = await markData(input.markPath, input.markBuffer, input.markMime, theme.markCrop);
  theme.markUri = mark.uri;
  theme.markAspect = mark.aspect;

  const artBox = { x: 0, y: 0, w: 750, h: 776 };
  const scenePath = path.join(
    root,
    "art/backgrounds",
    `${theme.scene ?? input.collectionSlug}.webp`,
  );
  const backgroundPath =
    input.backgroundOverride && input.backgroundPath
      ? input.backgroundPath
      : fs.existsSync(scenePath)
        ? scenePath
        : input.backgroundPath;
  if (!fs.existsSync(backgroundPath)) {
    throw new Error(`Card language needs a real scene background for ${input.collectionSlug}.`);
  }
  const art = await backgroundLayer(backgroundPath, artBox);
  const sourceSubject =
    input.cardSlug && !input.subjectOverride
      ? ([
          path.join(
            root,
            ".foilbury/sourced",
            input.collectionSlug,
            `${input.cardSlug}-source.png`,
          ),
          path.join(
            root,
            ".foilbury/sourced",
            input.collectionSlug,
            `${input.cardSlug}-subject.png`,
          ),
        ].find((candidate) => fs.existsSync(candidate)) ?? input.subjectPath)
      : input.subjectPath;
  const subjectHeight =
    input.subjectHeight ??
    theme.subjectHeight ??
    (theme.family === "manga" ? 900 : theme.family === "stage" ? 960 : 1000);
  const subjectTop =
    input.subjectTop ??
    theme.subjectTop ??
    (theme.family === "manga" ? 66 : theme.family === "stage" ? 40 : 16);
  const subject = await subjectLayer(sourceSubject, subjectHeight, {
    key: theme.key,
    shadow: theme.subjectShadow,
    rim: theme.subjectRim,
  });
  const artUri = { uri: dataUri(art.buffer) };
  const subjectUri = { ...subject, uri: dataUri(subject.buffer) };
  const data = serialiseData(input, theme);
  data.subjectTop = subjectTop;
  const front = theme.layout === "reading-room" ? readingRoomFront : frontSvg;
  const png = render(front(theme, material, artUri, subjectUri, data));
  const grain = await grainBuffer();
  const finished = await sharp(png)
    .composite([{ input: grain, blend: "soft-light" }])
    .png()
    .toBuffer();
  if (input.returnBytes) {
    // The member web object is 750x1050; the 1500x2100 render is the master.
    const buffer = await sharp(finished)
      .resize(750, 1050)
      .webp({ quality: 92, effort: 5 })
      .toBuffer();
    return { width: 750, height: 1050, bytes: buffer.length, buffer, masterPng: finished };
  }
  if (input.outputPath) {
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
    if (input.outputPath.endsWith(".webp")) {
      await sharp(finished).webp({ quality: 92, effort: 5 }).toFile(input.outputPath);
    } else {
      await sharp(finished).png({ compressionLevel: 9 }).toFile(input.outputPath);
    }
    return {
      width: W * S,
      height: H * S,
      bytes: fs.statSync(input.outputPath).size,
      outputPath: input.outputPath,
    };
  }
  return { width: W * S, height: H * S, bytes: finished.length, buffer: finished };
}

export async function renderBack(input) {
  const theme = liveryFor(input.collectionSlug, input.collectionTheme);
  const material = materialKey(
    input.effect === "holographic" ? "diamond" : (input.material ?? "plain"),
  );
  const mark = await markData(input.markPath, input.markBuffer, input.markMime, theme.markCrop);
  theme.markUri = mark.uri;
  theme.markAspect = mark.aspect;
  const data = serialiseData(input, theme);
  const back = theme.layout === "reading-room" ? readingRoomBack : backSvg;
  const png = render(back(theme, material, data));
  const grain = await grainBuffer();
  const finished = await sharp(png)
    .composite([{ input: grain, blend: "soft-light" }])
    .png()
    .toBuffer();
  if (input.returnBytes) {
    const buffer = await sharp(finished)
      .resize(750, 1050)
      .webp({ quality: 92, effort: 5 })
      .toBuffer();
    return { width: 750, height: 1050, bytes: buffer.length, buffer, masterPng: finished };
  }
  if (input.outputPath) {
    fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
    if (input.outputPath.endsWith(".webp")) {
      await sharp(finished).webp({ quality: 92, effort: 5 }).toFile(input.outputPath);
    } else {
      await sharp(finished).png({ compressionLevel: 9 }).toFile(input.outputPath);
    }
    return {
      width: W * S,
      height: H * S,
      bytes: fs.statSync(input.outputPath).size,
      outputPath: input.outputPath,
    };
  }
  return { width: W * S, height: H * S, bytes: finished.length, buffer: finished };
}
