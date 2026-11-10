/**
 * Shared collection livery registry.
 *
 * A collection chooses a theme; it never gets a bespoke frame. The web hero,
 * the card frame and the designed back all read the same tokens. Trial and
 * table are the pilot languages and must keep their existing geometry.
 */
export const LIVERY_THEMES = {
  trial: {
    label: "Class trial archive",
    ground: "#08080a",
    paper: "#f4f0e6",
    ink: "#08080a",
    accent: "#ff2e7e",
    backSurface: "dark",
    markTreatment: "invert",
    markInvert: true,
  },
  table: {
    label: "Table night",
    ground: "#07110f",
    paper: "#f4f0e6",
    ink: "#14352b",
    accent: "#b08a52",
    backSurface: "paper",
    markTreatment: "plate",
    markInvert: false,
  },
  archive: {
    label: "Archive record",
    ground: "#171310",
    paper: "#efe6d2",
    ink: "#1a1712",
    accent: "#b4462f",
    backSurface: "paper",
    markTreatment: "plate",
    markInvert: false,
  },
  broadcast: {
    label: "Broadcast tape",
    ground: "#0a0f16",
    paper: "#f7f3e8",
    ink: "#0b0f14",
    accent: "#f0b429",
    backSurface: "dark",
    markTreatment: "invert",
    markInvert: true,
  },
  stage: {
    label: "Stage lights",
    ground: "#100811",
    paper: "#f7ecf3",
    ink: "#140a13",
    accent: "#e2568c",
    backSurface: "dark",
    markTreatment: "plate",
    markInvert: false,
  },
  manga: {
    label: "Panel print",
    ground: "#141210",
    paper: "#f7f2e7",
    ink: "#101010",
    accent: "#d9482f",
    backSurface: "paper",
    markTreatment: "invert",
    markInvert: true,
  },
};

export function liveryTheme(theme) {
  return LIVERY_THEMES[theme] ?? null;
}

const W = 750;
const H = 1050;

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
}

function metalFor(theme, material) {
  // Trial and table keep the exact pilot metal map.
  if (theme === "trial" || theme === "table") {
    return {
      plain: { edge: "#F4F0E6", soft: "#B08A52", bright: "#FFFDF6" },
      silver: { edge: "#DDE7EC", soft: "#8A9399", bright: "#FFFFFF" },
      gold: { edge: "#F0CE86", soft: "#B08A52", bright: "#FFF1C7" },
      diamond: { edge: "#C9F2FF", soft: "#8FB7C8", bright: "#FFFFFF" },
    }[material];
  }
  const themeTokens = liveryTheme(theme) ?? LIVERY_THEMES.archive;
  return {
    plain: { edge: themeTokens.ink, soft: themeTokens.accent, bright: themeTokens.paper },
    silver: { edge: "#6F767C", soft: "#8A9399", bright: "#FFFFFF" },
    gold: { edge: "#7C5A25", soft: "#B08A52", bright: "#FFF1C7" },
    diamond: { edge: "#3D6170", soft: "#8FB7C8", bright: "#FFFFFF" },
  }[material];
}

export function liveryFrameSvg(theme, material) {
  const t = liveryTheme(theme);
  if (!t) throw new Error(`Unknown livery theme: ${theme}`);
  const metal = metalFor(theme, material);

  if (theme === "trial") {
    return svg(
      `<rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="none" stroke="#08080A" stroke-width="28"/>
      <rect x="26" y="26" width="${W - 52}" height="${H - 52}" fill="none" stroke="${metal.edge}" stroke-width="2.2"/>
      <rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="none" stroke="#08080A" stroke-width="1.1" opacity=".8"/>
      <path d="M20 20 V1030 H300" fill="none" stroke="#FF2E7E" stroke-width="5"/>
      <path d="M${W - 20} 20 V150" fill="none" stroke="#FF2E7E" stroke-width="5"/>
      <g fill="none" stroke="${metal.bright}" stroke-width="3">
        <path d="M48 96 V48 H96"/><path d="M${W - 96} 48 H${W - 48} V96"/>
        <path d="M48 ${H - 96} V${H - 48} H96"/><path d="M${W - 96} ${H - 48} H${W - 48} V${H - 96}"/>
      </g>
      <g fill="#FF2E7E">
        <path d="M48 108 h20 v5 h-20z"/><path d="M${W - 68} 108 h20 v5 h-20z"/>
        <path d="M48 ${H - 113} h20 v5 h-20z"/><path d="M${W - 68} ${H - 113} h20 v5 h-20z"/>
      </g>
      <path d="M64 970 H${W - 64}" stroke="${metal.soft}" stroke-width="1" opacity=".55"/>`,
    );
  }

  if (theme === "table") {
    return svg(
      `<rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="22" fill="none" stroke="#14352B" stroke-width="24"/>
      <rect x="26" y="26" width="${W - 52}" height="${H - 52}" rx="14" fill="none" stroke="${metal.soft}" stroke-width="2.4"/>
      <rect x="34" y="34" width="${W - 68}" height="${H - 68}" rx="9" fill="none" stroke="${metal.edge}" stroke-width="1" opacity=".85"/>
      <g fill="${metal.bright}">
        <circle cx="48" cy="48" r="4"/><circle cx="${W - 48}" cy="48" r="4"/>
        <circle cx="48" cy="${H - 48}" r="4"/><circle cx="${W - 48}" cy="${H - 48}" r="4"/>
      </g>
      <g fill="none" stroke="${metal.soft}" stroke-width="1.2" opacity=".8">
        <path d="M64 92 H190"/><path d="M${W - 190} 92 H${W - 64}"/>
        <path d="M64 ${H - 92} H190"/><path d="M${W - 190} ${H - 92} H${W - 64}"/>
      </g>
      <g fill="${metal.soft}" opacity=".9">
        <circle cx="214" cy="92" r="2.2"/><circle cx="226" cy="92" r="2.2"/>
        <circle cx="${W - 226}" cy="92" r="2.2"/><circle cx="${W - 214}" cy="92" r="2.2"/>
        <circle cx="214" cy="${H - 92}" r="2.2"/><circle cx="226" cy="${H - 92}" r="2.2"/>
        <circle cx="${W - 226}" cy="${H - 92}" r="2.2"/><circle cx="${W - 214}" cy="${H - 92}" r="2.2"/>
      </g>
      <path d="M64 966 H${W - 64}" stroke="${metal.soft}" stroke-width="1.2" opacity=".6"/>`,
    );
  }

  if (theme === "archive") {
    return svg(
      `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${t.ink}" stroke-width="26"/>
      <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="${metal.edge}" stroke-width="2.2"/>
      <rect x="38" y="38" width="${W - 76}" height="${H - 76}" fill="none" stroke="${metal.soft}" stroke-width="1" opacity=".7"/>
      <rect x="8" y="8" width="10" height="${H - 16}" fill="${t.accent}"/>
      <g fill="${t.accent}">
        <rect x="56" y="8" width="86" height="18"/>
        <rect x="${W - 142}" y="8" width="86" height="18"/>
        <rect x="56" y="${H - 26}" width="86" height="18"/>
        <rect x="${W - 142}" y="${H - 26}" width="86" height="18"/>
      </g>
      <g fill="none" stroke="${metal.bright}" stroke-width="2">
        <path d="M62 104 V62 H104"/>
        <path d="M${W - 104} 62 H${W - 62} V104"/>
        <path d="M62 ${H - 104} V${H - 62} H104"/>
        <path d="M${W - 104} ${H - 62} H${W - 62} V${H - 104}"/>
      </g>
      <path d="M64 972 H${W - 64}" stroke="${metal.soft}" stroke-width="1" opacity=".6"/>
      <text x="64" y="1014" font-family="monospace" font-size="12" letter-spacing="3" fill="${metal.soft}" opacity=".8">ARCHIVE COPY</text>`,
    );
  }

  if (theme === "broadcast") {
    return svg(
      `<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="20" fill="none" stroke="${t.ink}" stroke-width="26"/>
      <rect x="28" y="28" width="${W - 56}" height="${H - 56}" rx="12" fill="none" stroke="${metal.edge}" stroke-width="2.4"/>
      <rect x="36" y="36" width="${W - 72}" height="${H - 72}" rx="8" fill="none" stroke="${metal.soft}" stroke-width="1" opacity=".65"/>
      <g fill="${t.accent}">
        <rect x="56" y="56" width="10" height="10" rx="2"/>
        <rect x="74" y="56" width="10" height="10" rx="2" opacity=".6"/>
        <rect x="92" y="56" width="10" height="10" rx="2" opacity=".3"/>
        <rect x="56" y="982" width="132" height="8"/>
      </g>
      <g fill="none" stroke="${metal.bright}" stroke-width="1.6" opacity=".75">
        <path d="M56 86 H${W - 56}"/>
        <path d="M56 ${H - 86} H${W - 56}"/>
      </g>
      <g fill="${metal.soft}" opacity=".65">
        ${Array.from({ length: 22 }, (_, index) => `<rect x="${56 + index * 29}" y="1014" width="14" height="2"/>`).join("")}
      </g>`,
    );
  }

  if (theme === "stage") {
    return svg(
      `<rect x="6" y="6" width="${W - 12}" height="${H - 12}" rx="18" fill="none" stroke="${t.ink}" stroke-width="24"/>
      <rect x="28" y="28" width="${W - 56}" height="${H - 56}" rx="10" fill="none" stroke="${metal.soft}" stroke-width="2"/>
      <rect x="36" y="36" width="${W - 72}" height="${H - 72}" rx="6" fill="none" stroke="${metal.edge}" stroke-width="1" opacity=".75"/>
      <path d="M28 28 H${W - 28} V150 Q${W / 2} 250 28 150 Z" fill="${t.accent}" opacity=".14"/>
      <path d="M28 28 H${W - 28}" stroke="${t.accent}" stroke-width="3" opacity=".9"/>
      <g fill="none" stroke="${metal.bright}" stroke-width="1.4" opacity=".7">
        <path d="M64 92 Q${W / 2} 170 ${W - 64} 92"/>
        <path d="M84 118 Q${W / 2} 190 ${W - 84} 118" opacity=".5"/>
      </g>
      <g stroke="${metal.soft}" stroke-width="1.4" stroke-dasharray="5 7" opacity=".8">
        <path d="M28 240 V${H - 240}"/>
      </g>
      <g fill="${metal.bright}">
        ${Array.from({ length: 9 }, (_, index) => `<circle cx="${56 + index * 80}" cy="${H - 54}" r="3.2"/>`).join("")}
      </g>
      <path d="M64 972 H${W - 64}" stroke="${metal.soft}" stroke-width="1" opacity=".55"/>`,
    );
  }

  // manga
  return svg(
    `<rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${t.ink}" stroke-width="26"/>
    <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="${metal.edge}" stroke-width="2.4"/>
    <rect x="38" y="38" width="${W - 76}" height="${H - 76}" fill="none" stroke="${metal.soft}" stroke-width="1" opacity=".6"/>
    <path d="M8 8 H190 V44 H44 V190 H8 Z" fill="${t.accent}"/>
    <path d="M${W - 8} 8 H${W - 190} V44 H${W - 44} V190 H${W - 8} Z" fill="${t.ink}" opacity=".8"/>
    <g fill="${metal.bright}" opacity=".8">
      <circle cx="72" cy="72" r="3"/><circle cx="92" cy="72" r="3"/><circle cx="72" cy="92" r="3"/>
      <circle cx="${W - 72}" cy="${H - 72}" r="3"/><circle cx="${W - 92}" cy="${H - 72}" r="3"/><circle cx="${W - 72}" cy="${H - 92}" r="3"/>
    </g>
    <g stroke="${metal.soft}" stroke-width="1" opacity=".55">
      ${Array.from({ length: 10 }, (_, index) => `<path d="M${W - 120 - index * 12} ${H - 40} L${W - 40} ${H - 120 - index * 12}"/>`).join("")}
    </g>
    <path d="M64 972 H${W - 64}" stroke="${metal.soft}" stroke-width="1" opacity=".55"/>`,
  );
}
