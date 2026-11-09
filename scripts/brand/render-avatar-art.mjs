#!/usr/bin/env node
/**
 * Foilbury account avatar family.
 *
 * The final artwork is raster: tactile paper, ink bleed, embossed foil and
 * photographed shadows. This script is the reproducible render pipeline, not a
 * shipped vector illustration. It writes the PNG family and the mascot poses.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const avatarDir = join(root, "public/avatars/default");
const mascotDir = join(root, "public/brand/mascot");
const workDir = join(root, ".foilbury/art");

const C = {
  paper: "#F4EDDD",
  paperLight: "#FBF6EA",
  paperDeep: "#E4D6BA",
  paperShadow: "#C9B894",
  ink: "#17150F",
  inkSoft: "#2B2720",
  foil: "#1F5EFF",
  foilLight: "#8FB0FF",
  foilDark: "#123AA8",
  brass: "#BF8C32",
  brassLight: "#EDCD83",
  brassDark: "#7A541B",
  rust: "#A94A33",
  night: "#242735",
  nightLight: "#3B4055",
  sage: "#C9D2C1",
  blueGrey: "#D3DCE7",
  rose: "#E4CEC8",
  bone: "#DED8C5",
};

const DEFS = `
  <defs>
    <filter id="grain" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="17" result="noise"/>
      <feDiffuseLighting in="noise" lighting-color="#ffffff" surfaceScale="1.1" result="light">
        <feDistantLight azimuth="45" elevation="58"/>
      </feDiffuseLighting>
      <feComposite in="SourceGraphic" in2="light" operator="arithmetic" k1="1.02" k2="0" k3="0" k4="0"/>
    </filter>
    <filter id="fiber" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.008 0.55" numOctaves="3" seed="9" result="noise"/>
      <feDiffuseLighting in="noise" lighting-color="#ffffff" surfaceScale="0.55" result="light">
        <feDistantLight azimuth="80" elevation="62"/>
      </feDiffuseLighting>
      <feComposite in="SourceGraphic" in2="light" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>
    </filter>
    <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>
    <filter id="tightShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5"/>
    </filter>
    <filter id="inkBleed" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="0.55"/>
      <feComponentTransfer><feFuncA type="linear" slope="1.15" intercept="0"/></feComponentTransfer>
    </filter>
    <linearGradient id="foil" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.foilDark}"/>
      <stop offset=".22" stop-color="${C.foilLight}"/>
      <stop offset=".46" stop-color="${C.foil}"/>
      <stop offset=".72" stop-color="${C.foilDark}"/>
      <stop offset=".88" stop-color="${C.foil}"/>
      <stop offset="1" stop-color="${C.foilLight}"/>
    </linearGradient>
    <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.brassDark}"/>
      <stop offset=".24" stop-color="${C.brassLight}"/>
      <stop offset=".5" stop-color="${C.brass}"/>
      <stop offset=".78" stop-color="${C.brassLight}"/>
      <stop offset="1" stop-color="${C.brassDark}"/>
    </linearGradient>
    <radialGradient id="lightPool" cx=".34" cy=".24" r=".9">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".48"/>
      <stop offset=".5" stop-color="#ffffff" stop-opacity=".1"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".14"/>
    </radialGradient>
    <radialGradient id="vignette" cx=".5" cy=".48" r=".72">
      <stop offset=".55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity=".22"/>
    </radialGradient>
    <pattern id="dotGrid" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.05" fill="${C.ink}" opacity=".08"/>
    </pattern>
    <clipPath id="bodyClip">
      <path d="M300 264Q300 230 334 230H646L724 308V696Q724 730 690 730H334Q300 730 300 696Z"/>
    </clipPath>
  </defs>
`;

const BACKGROUNDS = {
  keeper: C.paperDeep,
  archivist: C.sage,
  prospector: "#DEC59C",
  completionist: C.blueGrey,
  curator: C.rose,
  "night-owl": C.night,
  trader: C.bone,
};

function background(field) {
  const dark = field === C.night;
  return `
    <rect width="1024" height="1024" fill="${field}"/>
    <rect width="1024" height="1024" fill="url(#dotGrid)"/>
    <rect width="1024" height="1024" fill="url(#lightPool)"/>
    <circle cx="512" cy="500" r="392" fill="${dark ? C.nightLight : C.paperLight}" opacity="${dark ? ".5" : ".55"}"/>
    <circle cx="512" cy="500" r="392" fill="none" stroke="${C.ink}" stroke-opacity="${dark ? ".35" : ".18"}" stroke-width="3"/>
    <path d="M150 934h724" stroke="${C.ink}" stroke-opacity="${dark ? ".28" : ".16"}" stroke-width="4"/>
    <path d="M150 934h150" stroke="${C.foil}" stroke-width="7"/>
  `;
}

function keeperFace(expression) {
  if (expression === "pleased") {
    return `<g fill="none" stroke="${C.ink}" stroke-width="15" stroke-linecap="round" filter="url(#inkBleed)">
      <path d="M420 420q30-26 60 0"/><path d="M544 420q30-26 60 0"/>
      <path d="M468 498q44 36 88 0"/>
    </g>
    <circle cx="396" cy="474" r="17" fill="${C.rust}" opacity=".3"/>
    <circle cx="628" cy="474" r="17" fill="${C.rust}" opacity=".3"/>`;
  }
  if (expression === "mischievous") {
    return `<g fill="${C.ink}" filter="url(#inkBleed)">
      <ellipse cx="450" cy="424" rx="25" ry="30"/>
      <path d="M548 414q28-20 56-4l6 16q-32-11-62 6z"/>
    </g>
    <path d="M466 508q40 20 80-10" stroke="${C.ink}" stroke-width="14" stroke-linecap="round" fill="none" filter="url(#inkBleed)"/>`;
  }
  if (expression === "curious") {
    return `<g fill="${C.ink}" filter="url(#inkBleed)">
      <circle cx="450" cy="424" r="28"/>
      <circle cx="580" cy="414" r="34"/>
      <circle cx="457" cy="417" r="8" fill="${C.paper}"/>
      <circle cx="589" cy="404" r="9" fill="${C.paper}"/>
    </g>
    <ellipse cx="512" cy="506" rx="21" ry="26" fill="${C.ink}" filter="url(#inkBleed)"/>`;
  }
  return `<g fill="${C.ink}" filter="url(#inkBleed)">
      <circle cx="450" cy="424" r="28"/>
      <circle cx="580" cy="424" r="28"/>
      <circle cx="458" cy="416" r="8" fill="${C.paper}"/>
      <circle cx="588" cy="416" r="8" fill="${C.paper}"/>
    </g>
    <path d="M468 500q44 34 88 0" stroke="${C.ink}" stroke-width="15" stroke-linecap="round" fill="none" filter="url(#inkBleed)"/>
    <circle cx="396" cy="478" r="16" fill="${C.rust}" opacity=".22"/>
    <circle cx="628" cy="478" r="16" fill="${C.rust}" opacity=".22"/>`;
}

function body(expression, role) {
  const hood =
    role === "night-owl"
      ? `<g>
          <path d="M288 300Q250 180 322 150l66 74 124-96 124 96 66-74q72 30 34 150l-34 96H322z" fill="${C.night}" stroke="${C.ink}" stroke-width="10" stroke-linejoin="round" filter="url(#grain)"/>
          <path d="M322 150l66 74M702 150l-66 74" stroke="${C.foil}" stroke-width="5" opacity=".7"/>
        </g>`
      : "";
  const hat =
    role === "prospector"
      ? `<g transform="translate(0 -38)">
          <path d="M314 240q64-132 198-132t198 132l30 26q10 18-12 22H296q-22-4-12-22z" fill="${C.brass}" stroke="${C.ink}" stroke-width="10" stroke-linejoin="round" filter="url(#grain)"/>
          <path d="M286 268q226-48 452 0" stroke="${C.ink}" stroke-width="10" fill="none"/>
          <path d="M374 214q138-46 276 0" stroke="${C.inkSoft}" stroke-width="10" opacity=".35" fill="none"/>
        </g>`
      : role === "trader"
        ? `<g transform="translate(0 -22)">
            <path d="M300 246q0-96 212-96t212 96l-12 8q-20-40-200-40t-200 40z" fill="${C.inkSoft}" stroke="${C.ink}" stroke-width="9" stroke-linejoin="round" filter="url(#grain)"/>
            <path d="M280 250q232-64 464 0l-12 24q-220-52-440 0z" fill="${C.ink}" stroke="${C.ink}" stroke-width="8" stroke-linejoin="round"/>
          </g>`
        : "";
  const spectacles =
    role === "archivist"
      ? `<g fill="none" stroke="${C.brass}" stroke-width="8">
          <circle cx="450" cy="424" r="48"/><circle cx="580" cy="424" r="48"/><path d="M498 424h34"/>
          <path d="M402 420l-30-12M628 420l30-12"/>
        </g>`
      : "";
  const bowTie =
    role === "curator"
      ? `<g transform="translate(512 650)">
          <path d="M0 0l-78-32v64zM0 0l78-32v64z" fill="${C.ink}" stroke="${C.ink}" stroke-width="7" stroke-linejoin="round"/>
          <circle r="16" fill="${C.brass}" stroke="${C.ink}" stroke-width="5"/>
        </g>`
      : "";
  const checklist =
    role === "completionist"
      ? `<g transform="translate(590 610) rotate(-7)">
          <rect width="196" height="240" rx="10" fill="${C.paperLight}" stroke="${C.ink}" stroke-width="8" filter="url(#grain)"/>
          <rect x="14" y="14" width="168" height="212" fill="none" stroke="${C.ink}" stroke-opacity=".18" stroke-width="3"/>
          <path d="M34 48h78M34 84h112M34 120h64" stroke="${C.ink}" stroke-width="7" opacity=".6"/>
          <rect x="30" y="158" width="46" height="38" fill="none" stroke="${C.foil}" stroke-width="8"/>
          <path d="M128 160l18 20 34-42" stroke="${C.foil}" stroke-width="9" fill="none" stroke-linecap="round"/>
          <path d="M0 0v240" stroke="${C.foil}" stroke-width="12"/>
        </g>`
      : "";
  const loupe =
    role === "prospector"
      ? `<g transform="translate(790 450) rotate(18)">
          <circle r="58" fill="${C.foilLight}" fill-opacity=".3" stroke="${C.ink}" stroke-width="16"/>
          <circle r="44" fill="none" stroke="${C.brass}" stroke-width="9"/>
          <path d="M42 42l58 58" stroke="${C.ink}" stroke-width="20" stroke-linecap="round"/>
        </g>`
      : "";
  const frame =
    role === "curator"
      ? `<g transform="translate(610 640) rotate(4)" filter="url(#grain)">
          <rect width="196" height="146" fill="${C.paperLight}" stroke="${C.ink}" stroke-width="9"/>
          <rect x="16" y="16" width="164" height="114" fill="none" stroke="${C.brass}" stroke-width="6"/>
          <rect x="38" y="36" width="74" height="74" fill="${C.foil}" opacity=".22"/>
          <path d="M38 112h118" stroke="${C.ink}" stroke-width="6" opacity=".4"/>
        </g>`
      : "";
  const cards =
    role === "trader"
      ? `<g transform="translate(586 640) rotate(-9)" filter="url(#grain)">
          <rect width="114" height="160" rx="7" fill="${C.paperLight}" stroke="${C.ink}" stroke-width="7"/>
          <rect x="12" y="12" width="90" height="98" fill="${C.foil}" opacity=".2"/>
          <path d="M22 130h70M22 144h46" stroke="${C.ink}" stroke-width="5" opacity=".45"/>
        </g>
        <g transform="translate(680 628) rotate(9)" filter="url(#grain)">
          <rect width="114" height="160" rx="7" fill="${C.paperDeep}" stroke="${C.ink}" stroke-width="7"/>
          <rect x="12" y="12" width="90" height="98" fill="${C.brass}" opacity=".28"/>
          <path d="M22 130h70M22 144h46" stroke="${C.ink}" stroke-width="5" opacity=".45"/>
        </g>`
      : "";
  const moon =
    role === "night-owl"
      ? `<g transform="translate(206 230)">
          <circle r="56" fill="${C.paperLight}" stroke="${C.ink}" stroke-width="8"/>
          <path d="M0-38a38 38 0 1 0 30 58 30 30 0 1 1-30-58z" fill="${C.foil}"/>
        </g>`
      : "";

  return `<g transform="rotate(-3 512 520)">
    <g filter="url(#softShadow)" opacity=".32">
      <path d="M300 264Q300 230 334 230H646L724 308V696Q724 730 690 730H334Q300 730 300 696Z" fill="${C.ink}" transform="translate(10 34)"/>
      <path d="M318 700v86q0 18 20 18h30q16 0 16-18v-86zM642 700v86q0 18 16 18h30q20 0 20-18v-86z" fill="${C.ink}" transform="translate(10 34)"/>
    </g>
    ${hood}
    <path d="M300 264Q300 230 334 230H646L724 308V696Q724 730 690 730H334Q300 730 300 696Z" fill="${C.paper}" stroke="${C.ink}" stroke-width="11" stroke-linejoin="round" filter="url(#grain)"/>
    <path d="M646 230L724 308H670Q646 308 646 284Z" fill="${C.paperDeep}" stroke="${C.ink}" stroke-width="11" stroke-linejoin="round" filter="url(#grain)"/>
    <path d="M646 230L724 308" stroke="${C.ink}" stroke-width="7" opacity=".55"/>
    <g clip-path="url(#bodyClip)">
      <rect x="318" y="264" width="22" height="442" fill="url(#foil)"/>
      <rect x="340" y="264" width="5" height="442" fill="${C.brass}"/>
      <rect x="356" y="264" width="2" height="442" fill="${C.paperShadow}" opacity=".55"/>
      <rect x="300" y="264" width="424" height="466" fill="url(#lightPool)" opacity=".32"/>
      <path d="M300 650h424" stroke="${C.ink}" stroke-width="3" opacity=".12"/>
    </g>
    <path d="M318 264v442" stroke="${C.foilLight}" stroke-width="5" opacity=".7"/>
    ${moon}
    ${hat}
    ${keeperFace(expression)}
    ${spectacles}
    <path d="M362 676h300" stroke="${C.ink}" stroke-width="3" opacity=".14"/>
    <g transform="translate(0 0)">
      <path d="M300 588q-62 14-74 76" fill="none" stroke="${C.ink}" stroke-width="13" stroke-linecap="round"/>
      <circle cx="226" cy="672" r="27" fill="${C.paper}" stroke="${C.ink}" stroke-width="11" filter="url(#grain)"/>
      <path d="M724 584q76 28 58 110" fill="none" stroke="${C.ink}" stroke-width="13" stroke-linecap="round"/>
      <circle cx="782" cy="702" r="27" fill="${C.paper}" stroke="${C.ink}" stroke-width="11" filter="url(#grain)"/>
    </g>
    <g transform="translate(792 716) rotate(21)">
      <circle r="34" fill="none" stroke="${C.brass}" stroke-width="19"/>
      <path d="M0 34v108" stroke="${C.brass}" stroke-width="19" stroke-linecap="square"/>
      <path d="M0 112h46M0 134h30" stroke="${C.brass}" stroke-width="18" stroke-linecap="square"/>
      <circle r="34" fill="none" stroke="${C.ink}" stroke-width="6" opacity=".45"/>
      <path d="M0 34v108" stroke="${C.ink}" stroke-width="5" opacity=".3"/>
    </g>
    <g filter="url(#grain)">
      <path d="M332 730v82q0 18 20 18h34q16 0 16-18v-82z" fill="${C.paper}" stroke="${C.ink}" stroke-width="10" stroke-linejoin="round"/>
      <path d="M606 730v82q0 18 16 18h34q20 0 20-18v-82z" fill="${C.paper}" stroke="${C.ink}" stroke-width="10" stroke-linejoin="round"/>
      <rect x="322" y="806" width="92" height="30" rx="14" fill="${C.inkSoft}"/>
      <rect x="596" y="806" width="92" height="30" rx="14" fill="${C.inkSoft}"/>
    </g>
    ${bowTie}
    ${checklist}
    ${frame}
    ${cards}
    ${loupe}
    <g transform="translate(512 660)" fill="${C.brass}" opacity=".9">
      <circle r="15"/><path d="M-6 10h12l-4 26h-4z"/>
    </g>
  </g>`;
}

function portraitSvg(role = "keeper", expression = "neutral") {
  const field = BACKGROUNDS[role] ?? C.paperDeep;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    ${DEFS}
    ${background(field)}
    ${body(expression, role)}
    <rect width="1024" height="1024" fill="url(#vignette)"/>
    <rect width="1024" height="1024" filter="url(#fiber)" opacity=".2"/>
  </svg>`;
}

function fullBodySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    ${DEFS}
    ${background(C.paperDeep)}
    <g transform="translate(0 40) scale(.92) translate(44 0)">
      ${body("neutral", "keeper")}
    </g>
    <rect width="1024" height="1024" fill="url(#vignette)"/>
    <rect width="1024" height="1024" filter="url(#fiber)" opacity=".2"/>
  </svg>`;
}

async function render(svg, path, size) {
  await sharp(Buffer.from(svg))
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(path);
}

await mkdir(avatarDir, { recursive: true });
await mkdir(mascotDir, { recursive: true });
await mkdir(workDir, { recursive: true });

const ROLES = [
  ["keeper", "keeper"],
  ["archivist", "archivist"],
  ["prospector", "prospector"],
  ["completionist", "completionist"],
  ["curator", "curator"],
  ["night-owl", "night-owl"],
  ["trader", "trader"],
];

for (const [key, role] of ROLES) {
  const svg = portraitSvg(role, "neutral");
  await writeFile(join(workDir, `${key}-master.svg`), `${svg}\n`, "utf8");
  for (const size of [512, 256, 128, 64, 32]) {
    await render(svg, join(avatarDir, `${key}-${size}.png`), size);
  }
}

for (const expression of ["neutral", "curious", "pleased", "mischievous"]) {
  const svg = portraitSvg("keeper", expression);
  await writeFile(join(workDir, `keeper-${expression}-master.svg`), `${svg}\n`, "utf8");
  await render(svg, join(mascotDir, `keeper-${expression}-512.png`), 512);
}

const full = fullBodySvg();
await writeFile(join(workDir, "keeper-full-body-master.svg"), `${full}\n`, "utf8");
await render(full, join(mascotDir, "keeper-full-body-512.png"), 512);
await render(full, join(mascotDir, "keeper-full-body-256.png"), 256);

console.log("Rendered paper-craft avatar family.");
