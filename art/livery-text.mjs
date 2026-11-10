/**
 * Authored text layouts for the shared livery themes.
 *
 * The compositor owns the geometry; this module only draws the information
 * band. Trial and table stay in art/compose.mjs so their deployed output is
 * unchanged. Every other collection uses one of these four shared layouts.
 */
const W = 750;
const H = 1050;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncate(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function wrapName(name, maxChars = 20) {
  const words = String(name).split(/\s+/);
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
  return lines.slice(0, 3);
}

function wrapWords(value, maxChars, maxLines = 2) {
  const words = String(value ?? "")
    .split(/\s+/)
    .filter(Boolean);
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
  return lines.slice(0, maxLines);
}

function finishLabel(material, effect) {
  if (effect === "holographic" || material === "diamond") return "HOLOGRAPHIC";
  return `${material.toUpperCase()}${effect && effect !== "none" ? ` · ${effect.toUpperCase()}` : ""}`;
}

function metaLine(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()))].join(" · ");
}

function nameMarkup(lines, x, firstBaseline, lineHeight, size) {
  return lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
}

function markPlate(
  markData,
  { x, y, size, plate, aspect = 1, opacity = 1, maxWidth = size * 3 },
) {
  if (!markData) return { svg: "", width: 0, x, y };
  const width = Math.round(Math.min(maxWidth, Math.max(size, size * aspect)));
  return {
    svg: `<rect x="${x}" y="${y}" width="${width}" height="${size}" fill="${plate}" opacity="${opacity}"/>
    <image href="${markData}" x="${x + 5}" y="${y + 5}" width="${width - 10}" height="${size - 10}" preserveAspectRatio="xMidYMid meet"/>`,
    width,
    x,
    y,
  };
}

/** Archive: a cream index-card band, catalogue tab and a typed record. */
export function archiveTextSvg({
  name,
  subtitle,
  setName,
  serial,
  className,
  rarity,
  material,
  effect,
  markAspect,
  markData,
}) {
  const mark = markPlate(markData, {
    x: 64,
    y: 786,
    size: 56,
    plate: "#f7f0e2",
    aspect: markAspect,
    maxWidth: 240,
  });
  const textX = mark.width ? 64 + mark.width + 16 : 64;
  const lines = wrapName(name, 22);
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const nameSize = lines.length >= 3 ? 38 : longest > 20 ? 42 : lines.length > 1 ? 48 : 56;
  const lineHeight = nameSize + 6;
  const firstBaseline = 902 - (lines.length - 1) * lineHeight;
  const lastBaseline = firstBaseline + (lines.length - 1) * lineHeight;
  const roleLines = wrapWords(subtitle, 50, 2);
  const roleY = lastBaseline + 28;
  const metaY = roleY + (roleLines.length ? (roleLines.length - 1) * 20 + 26 : 24);
  const roleMarkup = roleLines
    .map(
      (line, index) =>
        `<text x="64" y="${roleY + index * 20}" font-family="Manrope" font-size="17" fill="#1a1712" opacity=".82">${escapeXml(line)}</text>`,
    )
    .join("");
  const meta = metaLine([setName, className, rarity])
    .split(" · ")
    .map((value) => escapeXml(truncate(value, 30)))
    .join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="archiveShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#171310" stop-opacity="0"/>
        <stop offset=".55" stop-color="#171310" stop-opacity=".18"/>
        <stop offset="1" stop-color="#171310" stop-opacity=".5"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="230" fill="url(#archiveShade)"/>
    <rect x="0" y="744" width="${W}" height="306" fill="#efe6d2"/>
    <rect x="0" y="744" width="${W}" height="8" fill="#b4462f"/>
    <rect x="0" y="752" width="${W}" height="1.5" fill="#1a1712" opacity=".35"/>
    <rect x="0" y="1022" width="${W}" height="28" fill="#1a1712"/>
    <rect x="48" y="744" width="112" height="26" fill="#1a1712"/>
    <text x="60" y="762" font-family="IBM Plex Mono" font-size="10" letter-spacing="2.2" fill="#efe6d2">CASE FILE</text>
    ${mark.svg}
    <text x="${textX}" y="806" font-family="IBM Plex Mono" font-size="11" letter-spacing="2.2" fill="#b4462f">${escapeXml(truncate(setName.toUpperCase(), 36))}</text>
    <text x="${textX}" y="828" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.8" fill="#1a1712" opacity=".62">${escapeXml(finishLabel(material, effect))}</text>
    <text x="64" y="${firstBaseline}" font-family="Fraunces" font-weight="600" font-size="${nameSize}" fill="#1a1712">${nameMarkup(lines, 64, firstBaseline, lineHeight, nameSize)}</text>
    ${roleMarkup}
    <text x="64" y="${metaY}" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.7" fill="#b4462f">${meta.toUpperCase()}</text>
    <path d="M64 978 H${W - 64}" stroke="#1a1712" stroke-width="1" opacity=".28"/>
    <text x="64" y="1010" font-family="IBM Plex Mono" font-size="9" letter-spacing="2.2" fill="#1a1712" opacity=".68">ARCHIVE RECORD · MEMBER ARCHIVE · NOT OFFICIAL</text>
    <text x="${W - 64}" y="1010" text-anchor="end" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.2" fill="#1a1712" opacity=".82">${escapeXml(serial)}</text>
    <text x="64" y="1042" font-family="IBM Plex Mono" font-size="9" letter-spacing="2.4" fill="#efe6d2" opacity=".8">FOILBURY · COLLECTION ARCHIVE</text>
  </svg>`;
}

/** Broadcast: a lower-third caption over a dark tape, with a tally light. */
export function broadcastTextSvg({
  name,
  subtitle,
  setName,
  serial,
  className,
  rarity,
  material,
  effect,
  markAspect,
  markData,
}) {
  const mark = markPlate(markData, {
    x: 64,
    y: 48,
    size: 58,
    plate: "#0a0f16",
    aspect: markAspect,
    maxWidth: 170,
    opacity: 0.88,
  });
  const textX = mark.width ? 64 + mark.width + 14 : 64;
  const lines = wrapName(name.toUpperCase(), 18);
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const nameSize = lines.length >= 3 ? 38 : longest > 17 ? 42 : lines.length > 1 ? 48 : 56;
  const lineHeight = nameSize + 4;
  const firstBaseline = 896 - (lines.length - 1) * lineHeight;
  const lastBaseline = firstBaseline + (lines.length - 1) * lineHeight;
  const meta = metaLine([setName, className, rarity])
    .split(" · ")
    .map((value) => escapeXml(truncate(value, 30)))
    .join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="tapeShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0a0f16" stop-opacity="0"/>
        <stop offset=".5" stop-color="#0a0f16" stop-opacity=".2"/>
        <stop offset="1" stop-color="#0a0f16" stop-opacity=".94"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="220" fill="url(#tapeShade)"/>
    <rect x="0" y="700" width="${W}" height="350" fill="url(#tapeShade)"/>
    <rect x="0" y="742" width="${W}" height="5" fill="#f0b429"/>
    <rect x="0" y="747" width="196" height="303" fill="#f0b429" opacity=".12"/>
    <rect x="0" y="747" width="8" height="303" fill="#f0b429"/>
    ${mark.svg}
    <text x="${textX}" y="76" font-family="IBM Plex Mono" font-size="13" letter-spacing="2.6" fill="#f0b429">${escapeXml(truncate(setName.toUpperCase(), 34))}</text>
    <text x="${textX}" y="96" font-family="IBM Plex Mono" font-size="10" letter-spacing="2" fill="#f7f3e8" opacity=".65">BROADCAST TAPE · MEMBER COPY</text>
    <g transform="translate(${W - 154} 62)">
      <circle cx="7" cy="7" r="6" fill="#d9482f"/>
      <text x="20" y="12" font-family="IBM Plex Mono" font-size="11" letter-spacing="2.2" fill="#f7f3e8">REC</text>
    </g>
    <text x="${W - 64}" y="96" text-anchor="end" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.8" fill="#f7f3e8" opacity=".62">${escapeXml(finishLabel(material, effect))}</text>
    <text x="64" y="${firstBaseline}" font-family="Manrope" font-weight="800" font-size="${nameSize}" letter-spacing=".4" fill="#fffdf6">${nameMarkup(lines, 64, firstBaseline, lineHeight, nameSize)}</text>
    ${subtitle ? `<text x="64" y="${lastBaseline + 32}" font-family="Manrope" font-size="18" fill="#f7f3e8" opacity=".82">${escapeXml(truncate(subtitle, 48))}</text>` : ""}
    <text x="64" y="${lastBaseline + 60}" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.8" fill="#f0b429">${meta.toUpperCase()}</text>
    <path d="M64 978 H${W - 64}" stroke="#f7f3e8" stroke-width="1" opacity=".22"/>
    <text x="64" y="1010" font-family="IBM Plex Mono" font-size="10" letter-spacing="2.4" fill="#f7f3e8" opacity=".6">MEMBER TAPE · NOT OFFICIAL</text>
    <text x="${W - 64}" y="1010" text-anchor="end" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.2" fill="#f7f3e8" opacity=".8">${escapeXml(serial)}</text>
  </svg>`;
}

/** Stage: a ticket-stub band with a marquee rule and a now-showing line. */
export function stageTextSvg({
  name,
  subtitle,
  setName,
  serial,
  className,
  rarity,
  material,
  effect,
  markAspect,
  markData,
}) {
  const markWidth = markData
    ? Math.round(Math.min(190, Math.max(64, 64 * (markAspect || 1))))
    : 0;
  const markX = W - 64 - markWidth;
  const mark = markPlate(markData, {
    x: markX,
    y: 758,
    size: 64,
    plate: "#f7ecf3",
    aspect: markAspect,
    maxWidth: 190,
  });
  const lines = wrapName(name, 21);
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const nameSize = lines.length >= 3 ? 38 : longest > 20 ? 42 : lines.length > 1 ? 48 : 56;
  const lineHeight = nameSize + 6;
  const firstBaseline = 894 - (lines.length - 1) * lineHeight;
  const lastBaseline = firstBaseline + (lines.length - 1) * lineHeight;
  const meta = metaLine([className, rarity])
    .split(" · ")
    .map((value) => escapeXml(truncate(value, 30)))
    .join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="stageShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#100811" stop-opacity="0"/>
        <stop offset=".48" stop-color="#100811" stop-opacity=".24"/>
        <stop offset="1" stop-color="#100811" stop-opacity=".95"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="210" fill="url(#stageShade)"/>
    <rect x="0" y="710" width="${W}" height="340" fill="url(#stageShade)"/>
    <rect x="0" y="748" width="${W}" height="1.4" fill="#e2568c" opacity=".8"/>
    <rect x="0" y="748" width="154" height="302" fill="#e2568c" opacity=".1"/>
    <text x="64" y="780" font-family="IBM Plex Mono" font-size="10" letter-spacing="2.6" fill="#e2568c">NOW SHOWING</text>
    <text x="64" y="802" font-family="IBM Plex Mono" font-size="10" letter-spacing="2" fill="#f7ecf3" opacity=".62">${escapeXml(truncate(setName.toUpperCase(), 34))}</text>
    ${mark.svg}
    <text x="${W - 64}" y="844" text-anchor="end" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.8" fill="#f7ecf3" opacity=".62">${escapeXml(finishLabel(material, effect))}</text>
    <text x="64" y="${firstBaseline}" font-family="Fraunces" font-weight="600" font-size="${nameSize}" fill="#fff7fb">${nameMarkup(lines, 64, firstBaseline, lineHeight, nameSize)}</text>
    ${subtitle ? `<text x="64" y="${lastBaseline + 31}" font-family="Manrope" font-size="18" fill="#f7ecf3" opacity=".86">${escapeXml(truncate(subtitle, 48))}</text>` : ""}
    <text x="64" y="${lastBaseline + 58}" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.8" fill="#e2568c">${meta.toUpperCase()}</text>
    <path d="M64 978 H${W - 64}" stroke="#f7ecf3" stroke-width="1" opacity=".24"/>
    <text x="64" y="1010" font-family="IBM Plex Mono" font-size="10" letter-spacing="2.4" fill="#f7ecf3" opacity=".6">ADMIT ONE · MEMBER ARCHIVE · NOT OFFICIAL</text>
    <text x="${W - 64}" y="1010" text-anchor="end" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.2" fill="#f7ecf3" opacity=".8">${escapeXml(serial)}</text>
  </svg>`;
}

/** Manga: a paper caption panel with an inked gutter and halftone corner. */
export function mangaTextSvg({
  name,
  subtitle,
  setName,
  serial,
  className,
  rarity,
  material,
  effect,
  markAspect,
  markData,
}) {
  const mark = markPlate(markData, {
    x: 64,
    y: 784,
    size: 56,
    plate: "#f7f2e7",
    aspect: markAspect,
    maxWidth: 160,
  });
  const textX = mark.width ? 64 + mark.width + 16 : 64;
  const lines = wrapName(name.toUpperCase(), 19);
  const longest = Math.max(...lines.map((line) => line.length), 1);
  const nameSize = lines.length >= 3 ? 38 : longest > 18 ? 42 : lines.length > 1 ? 48 : 56;
  const lineHeight = nameSize + 5;
  const firstBaseline = 900 - (lines.length - 1) * lineHeight;
  const lastBaseline = firstBaseline + (lines.length - 1) * lineHeight;
  const meta = metaLine([setName, className, rarity])
    .split(" · ")
    .map((value) => escapeXml(truncate(value, 30)))
    .join(" · ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <pattern id="mangaDots" width="9" height="9" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1" fill="#101010" opacity=".2"/>
      </pattern>
    </defs>
    <rect x="0" y="0" width="${W}" height="220" fill="#141210" opacity=".28"/>
    <rect x="0" y="748" width="${W}" height="302" fill="#f7f2e7"/>
    <rect x="0" y="748" width="${W}" height="6" fill="#101010"/>
    <rect x="0" y="754" width="${W}" height="3" fill="#d9482f"/>
    <rect x="0" y="1018" width="${W}" height="32" fill="#101010"/>
    <rect x="${W - 210}" y="748" width="210" height="120" fill="url(#mangaDots)"/>
    ${mark.svg}
    <text x="${textX}" y="806" font-family="IBM Plex Mono" font-size="12" letter-spacing="2.6" fill="#d9482f">${escapeXml(truncate(setName.toUpperCase(), 42))}</text>
    <text x="${textX}" y="828" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.8" fill="#101010" opacity=".62">PANEL PRINT · ${escapeXml(finishLabel(material, effect))}</text>
    <text x="${W - 64}" y="806" text-anchor="end" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.8" fill="#101010" opacity=".62">MEMBER COPY</text>
    <text x="${W - 64}" y="828" text-anchor="end" font-family="IBM Plex Mono" font-size="10" letter-spacing="1.8" fill="#101010" opacity=".62">${escapeXml(truncate(className || "CABINET", 22).toUpperCase())}</text>
    <text x="64" y="${firstBaseline}" font-family="Manrope" font-weight="800" font-size="${nameSize}" letter-spacing=".3" fill="#101010">${nameMarkup(lines, 64, firstBaseline, lineHeight, nameSize)}</text>
    ${subtitle ? `<rect x="64" y="${lastBaseline + 14}" width="${W - 128}" height="30" fill="#101010"/><text x="76" y="${lastBaseline + 34}" font-family="Manrope" font-size="16" fill="#f7f2e7">${escapeXml(truncate(subtitle, 46))}</text>` : ""}
    <text x="64" y="${lastBaseline + (subtitle ? 70 : 34)}" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.7" fill="#d9482f">${meta.toUpperCase()}</text>
    <text x="64" y="1008" font-family="IBM Plex Mono" font-size="10" letter-spacing="2.4" fill="#101010" opacity=".68">MEMBER ARCHIVE · NOT OFFICIAL</text>
    <text x="${W - 64}" y="1008" text-anchor="end" font-family="IBM Plex Mono" font-size="11" letter-spacing="1.2" fill="#101010" opacity=".82">${escapeXml(serial)}</text>
    <text x="64" y="1040" font-family="IBM Plex Mono" font-size="9" letter-spacing="2.4" fill="#f7f2e7" opacity=".8">FOILBURY · PANEL PRINT</text>
  </svg>`;
}
