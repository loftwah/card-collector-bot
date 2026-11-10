#!/usr/bin/env node
/**
 * Designed card backs for the two pilot collections.
 *
 * The front is the art-led object; the back is a concise information object:
 * collection mark, name, role/game, a short bio, real facts and provenance.
 * It is deterministic and uses the existing render pipeline.
 *
 *   FOILBURY_URL=http://localhost:5175 node scripts/content/pilot-backs.mjs --dry-run
 *   FOILBURY_URL=http://localhost:5175 node scripts/content/pilot-backs.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { composeCardBack } from "../../art/compose.mjs";
import {
  apiForm,
  apiJson,
  agentToken,
  accessHeaders,
  ensureServer,
  BASE_URL,
} from "../lib/api.mjs";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg?.split("=")[1] ?? null;
const presentations = JSON.parse(
  fs.readFileSync(path.join(root, "src/data/collection-presentations.json"), "utf8"),
);
const themeTokens = JSON.parse(
  fs.readFileSync(path.join(root, "src/data/collection-themes.json"), "utf8"),
);
const outDir = path.join(root, ".foilbury/generated/collection-backs");
const tmpDir = path.join(root, ".foilbury/tmp");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const themes = Object.fromEntries(
  Object.entries(presentations).map(([slug, presentation]) => [slug, presentation.theme]),
);

await ensureServer();
const catalogue = await apiJson("/api/v1/admin/cards?limit=200");
const cards = catalogue.items.filter((card) => {
  const slug = card.collections?.[0]?.slug;
  return Boolean(themes[slug]) && (!only || slug === only);
});
const manrope = fs
  .readFileSync(path.join(root, "public/fonts/manrope-latin.woff2"))
  .toString("base64");
const fraunces = fs.readFileSync(path.join(root, "public/fonts/Fraunces.ttf")).toString("base64");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 750, height: 1050 });

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const truncate = (value, max) => {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

async function logoData(card) {
  const logo = card.collections?.[0]?.logo_url;
  if (!logo) return "";
  const assetId = logo.match(/^\/media\/asset\/([A-Za-z0-9_-]+)$/)?.[1];
  const route = assetId ? `/api/v1/admin/assets/${assetId}/bytes` : logo;
  const response = await fetch(`${BASE_URL}${route}`, {
    headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
  }).catch(() => null);
  if (!response?.ok) return "";
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return "";
  const bytes = Buffer.from(await response.arrayBuffer());
  const mime = contentType.includes("svg") || logo.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function trialHtml(card, logo) {
  const rarity = card.rarity?.name ?? "Unclassified";
  const game = String(card.subtitle ?? "").split(" · ")[0] || "Danganronpa";
  const role =
    String(card.subtitle ?? "")
      .split(" · ")
      .slice(1)
      .join(" · ") || "Student";
  const description = card.description ?? "A card from the class trial archive.";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manrope}') format('woff2');font-weight:200 800}
    @font-face{font-family:Fraunces;src:url('data:font/ttf;base64,${fraunces}') format('truetype');font-weight:100 900}
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:750px;height:1050px;background:#0b0b0d;color:#f4f0e6;font-family:Manrope,sans-serif;overflow:hidden}
    .back{position:relative;width:750px;height:1050px;padding:82px 68px 76px;background:
      radial-gradient(circle at 82% 12%,rgba(255,46,126,.18),transparent 34%),
      linear-gradient(150deg,#111114,#08080a 58%,#141416)}
    .dots{position:absolute;inset:0;background-image:radial-gradient(rgba(244,240,230,.13) 1px,transparent 1px);background-size:13px 13px;opacity:.45}
    .pinkbar{position:absolute;left:0;top:0;bottom:0;width:18px;background:#ff2e7e}
    .content{position:relative;z-index:1;display:flex;height:100%;flex-direction:column}
    .top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border-bottom:1px solid rgba(244,240,230,.25);padding-bottom:22px}
    .mark{width:200px;height:56px;object-fit:contain;object-position:left center;filter:invert(1)}
    .kicker{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#ff7aa8;text-align:right;line-height:1.7}
    .index{margin-top:54px;font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#ff7aa8}
    h1{margin-top:14px;font-family:Manrope;font-weight:800;font-size:66px;line-height:.93;letter-spacing:-.02em;text-transform:uppercase;max-width:620px}
    .role{margin-top:16px;font-size:21px;color:#d8d2c7}
    .middle{display:grid;flex:1;grid-template-columns:minmax(0,1fr) 220px;gap:28px;padding-block:24px;align-items:center}
    .bio{font-size:18px;line-height:1.55;color:#c9c2b5;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
    .seal{position:relative;width:220px;height:220px;border:1px solid rgba(255,46,126,.5);border-radius:999px;display:grid;place-items:center;text-align:center;transform:rotate(-5deg);opacity:.9}
    .seal::before{content:"";position:absolute;inset:10px;border:1px solid rgba(244,240,230,.22);border-radius:999px}
    .seal::after{content:"";position:absolute;width:220px;height:1px;background:rgba(255,46,126,.45);transform:rotate(-45deg)}
    .seal span{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;line-height:1.8;text-transform:uppercase;color:#ff7aa8}
    .facts{display:grid;grid-template-columns:1fr 1fr;gap:16px 28px;margin-top:0;border-top:1px solid rgba(244,240,230,.22);padding-top:20px}
    dt{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#9a9388}
    dd{margin-top:4px;font-size:15px;color:#f4f0e6}
    .foot{display:flex;justify-content:space-between;gap:20px;border-top:1px solid rgba(244,240,230,.2);margin-top:22px;padding-top:14px;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#9a9388}
    .stamp{display:inline-block;border:1px solid #ff2e7e;color:#ff7aa8;padding:5px 7px;transform:rotate(-1.5deg)}
  </style></head><body><div class="back"><div class="dots"></div><div class="pinkbar"></div><div class="content">
    <div class="top"><img class="mark" src="${logo}" alt=""><div class="kicker">Class trial archive<br>Member edition<br><span class="stamp">Not official</span></div></div>
    <p class="index">${esc(game)} · Case file</p>
    <h1>${esc(card.name)}</h1>
    <p class="role">${esc(role)}</p>
    <div class="middle"><p class="bio">${esc(description)}</p><div class="seal" aria-hidden="true"><span>Class trial<br>evidence<br>member file</span></div></div>
    <dl class="facts">
      <div><dt>Collection</dt><dd>Danganronpa — Three Killing Games</dd></div>
      <div><dt>Rarity</dt><dd>${esc(rarity)}</dd></div>
      <div><dt>Edition</dt><dd>Member archive</dd></div>
      <div><dt>Provenance</dt><dd>Third-party art · sourced reference</dd></div>
    </dl>
    <div class="foot"><span>Member archive · not official · no affiliation claimed</span><span>Foilbury</span></div>
  </div></div></body></html>`;
}

function tableHtml(card, logo) {
  const rarity = card.rarity?.name ?? "Unclassified";
  const role = card.subtitle ?? card.class?.name ?? "Table regular";
  const description = card.description ?? "One of the Protocol 11 table-night regulars.";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manrope}') format('woff2');font-weight:200 800}
    @font-face{font-family:Fraunces;src:url('data:font/ttf;base64,${fraunces}') format('truetype');font-weight:100 900}
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:750px;height:1050px;background:#f4f0e6;color:#14352b;font-family:Manrope,sans-serif;overflow:hidden}
    .back{position:relative;width:750px;height:1050px;padding:82px 68px 76px;background:
      radial-gradient(circle at 78% 12%,rgba(176,138,82,.16),transparent 38%),
      linear-gradient(140deg,#fbf9f3,#f4f0e6 55%,#f0ebdf)}
    .rule{position:absolute;left:38px;right:38px;top:38px;bottom:38px;border:1px solid rgba(20,53,43,.35)}
    .rule::before{content:"";position:absolute;inset:8px;border:1px solid rgba(176,138,82,.55)}
    .content{position:relative;z-index:1;display:flex;height:100%;flex-direction:column}
    .top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border-bottom:1px solid rgba(20,53,43,.28);padding-bottom:22px}
    .mark{width:72px;height:72px;border-radius:999px;object-fit:contain;background:#14352b;padding:6px}
    .kicker{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6f5a35;text-align:right;line-height:1.7}
    .index{margin-top:56px;font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#8a6b3a}
    h1{margin-top:14px;font-family:Fraunces,serif;font-weight:600;font-size:68px;line-height:.95;letter-spacing:-.03em;max-width:620px}
    .role{margin-top:14px;font-size:22px;color:#36584b}
    .middle{display:grid;flex:1;grid-template-columns:minmax(0,1fr) 220px;gap:28px;padding-block:24px;align-items:center}
    .bio{font-size:18px;line-height:1.55;color:#3c5a4e;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
    .table-seal{position:relative;width:220px;height:220px;border:1px solid rgba(176,138,82,.55);border-radius:999px;display:grid;place-items:center;text-align:center;transform:rotate(4deg)}
    .table-seal::before{content:"";position:absolute;inset:12px;border:1px solid rgba(20,53,43,.22);border-radius:999px}
    .table-seal::after{content:"";position:absolute;inset:28px;border:1px dashed rgba(176,138,82,.45);border-radius:999px}
    .table-seal b{font-family:Fraunces,serif;font-size:58px;font-weight:600;line-height:1;color:#14352b}
    .table-seal span{display:block;margin-top:6px;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#8a6b3a}
    .facts{display:grid;grid-template-columns:1fr 1fr;gap:16px 28px;margin-top:0;border-top:1px solid rgba(20,53,43,.26);padding-top:20px}
    dt{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8a7a5d}
    dd{margin-top:4px;font-size:15px;color:#14352b}
    .foot{display:flex;justify-content:space-between;gap:20px;border-top:1px solid rgba(20,53,43,.24);margin-top:22px;padding-top:14px;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8a7a5d}
    .stamp{display:inline-block;border:1px solid #b08a52;color:#8a6b3a;padding:5px 7px;transform:rotate(1.5deg)}
  </style></head><body><div class="back"><div class="rule"></div><div class="content">
    <div class="top"><img class="mark" src="${logo}" alt=""><div class="kicker">Table night · place card<br>Original Foilbury project<br><span class="stamp">Public showcase</span></div></div>
    <p class="index">Table night · Seat record</p>
    <h1>${esc(card.name)}</h1>
    <p class="role">${esc(role)}</p>
    <div class="middle"><p class="bio">${esc(description)}</p><div class="table-seal" aria-hidden="true"><div><b>XI</b><span>Table night</span></div></div></div>
    <dl class="facts">
      <div><dt>Collection</dt><dd>Protocol 11</dd></div>
      <div><dt>Role</dt><dd>${esc(card.class?.name ?? "Regular")}</dd></div>
      <div><dt>Rarity</dt><dd>${esc(rarity)}</dd></div>
      <div><dt>Provenance</dt><dd>Original Foilbury project</dd></div>
    </dl>
    <div class="foot"><span>Original Foilbury project · public showcase</span><span>XI · Foilbury</span></div>
  </div></div></body></html>`;
}

function genericBackHtml(card, logo, theme) {
  const tokens = themeTokens[theme] ?? themeTokens.archive;
  const paper = tokens.backSurface === "paper";
  const rarity = card.rarity?.name ?? "Unclassified";
  const role = card.subtitle ?? card.class?.name ?? "Member card";
  const description = card.description ?? "A card from the Foilbury archive.";
  const collectionName = card.collections?.[0]?.name ?? "Foilbury";
  const shortName = presentations[card.collections?.[0]?.slug]?.cardSetName ?? collectionName;
  const invertMark = tokens.markInvert === true;
  const mark = logo
    ? `<span class="mark-plate${paper || invertMark ? "" : " mark-plate--paper"}"><img class="mark${invertMark ? " mark--invert" : ""}" src="${logo}" alt=""></span>`
    : "";
  const record = [
    ["Collection", shortName],
    ["Rarity", rarity],
    ["Edition", card.class?.name ?? "Member archive"],
    [
      "Provenance",
      card.collections?.[0]?.view_audience === "public"
        ? "Original Foilbury project"
        : "Third-party art · sourced reference",
    ],
  ]
    .map(
      ([label, value]) =>
        `<div><dt>${esc(label)}</dt><dd>${esc(truncate(String(value), 42))}</dd></div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manrope}') format('woff2');font-weight:200 800}
    @font-face{font-family:Fraunces;src:url('data:font/ttf;base64,${fraunces}') format('truetype');font-weight:100 900}
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:750px;height:1050px;background:${tokens.paper};color:${tokens.ink};font-family:Manrope,sans-serif;overflow:hidden}
    .back{position:relative;width:750px;height:1050px;padding:78px 66px 74px;background:${paper ? tokens.paper : tokens.ground};color:${paper ? tokens.ink : tokens.paper}}
    .edge{position:absolute;inset:34px;border:1px solid ${paper ? tokens.ink : tokens.accent};opacity:.55}
    .edge::before{content:"";position:absolute;inset:9px;border:1px solid ${paper ? tokens.accent : tokens.paper};opacity:.35}
    .content{position:relative;z-index:1;display:flex;height:100%;flex-direction:column}
    .top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;border-bottom:1px solid ${paper ? tokens.ink : tokens.paper};border-color:color-mix(in srgb,${paper ? tokens.ink : tokens.paper} 26%,transparent);padding-bottom:20px}
    .mark-plate{display:inline-flex;align-items:center;justify-content:center;min-width:200px;height:64px;padding:6px 10px;background:${paper ? "transparent" : "rgba(255,255,255,.06)"}}
    .mark-plate--paper{background:${tokens.paper}}
    .mark{max-width:190px;max-height:52px;object-fit:contain}
    .mark--invert{filter:invert(1)}
    .kicker{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:${paper ? tokens.accent : tokens.paper};text-align:right;line-height:1.8;opacity:.9}
    .stamp{display:inline-block;border:1px solid ${tokens.accent};color:${tokens.accent};padding:4px 6px;transform:rotate(-1.5deg)}
    .index{margin-top:48px;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${tokens.accent}}
    h1{margin-top:12px;font-family:Fraunces,serif;font-weight:600;font-size:66px;line-height:.94;letter-spacing:-.03em;max-width:620px;color:${paper ? tokens.ink : tokens.paper}}
    .role{margin-top:14px;font-size:20px;color:${paper ? tokens.ink : tokens.paper};opacity:.78}
    .middle{display:grid;flex:1;grid-template-columns:minmax(0,1fr) 190px;gap:28px;padding-block:28px 20px;align-items:start}
    .bio{font-size:17px;line-height:1.55;color:${paper ? tokens.ink : tokens.paper};opacity:.82;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;max-width:430px}
    .record{position:relative;border:1px solid ${tokens.accent};padding:18px 16px;transform:rotate(-2deg)}
    .record::before{content:"";position:absolute;inset:6px;border:1px solid ${tokens.accent};opacity:.35}
    .record span{display:block;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:${tokens.accent}}
    .record strong{display:block;margin:6px 0 8px;font-family:Fraunces,serif;font-size:30px;font-weight:600;line-height:1;color:${paper ? tokens.ink : tokens.paper}}
    .facts{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px;border-top:1px solid ${paper ? tokens.ink : tokens.paper};border-color:color-mix(in srgb,${paper ? tokens.ink : tokens.paper} 22%,transparent);padding-top:18px}
    dt{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:${paper ? tokens.ink : tokens.paper};opacity:.55}
    dd{margin-top:3px;font-size:14px;color:${paper ? tokens.ink : tokens.paper}}
    .foot{display:flex;justify-content:space-between;gap:20px;border-top:1px solid ${paper ? tokens.ink : tokens.paper};border-color:color-mix(in srgb,${paper ? tokens.ink : tokens.paper} 20%,transparent);margin-top:20px;padding-top:12px;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:${paper ? tokens.ink : tokens.paper};opacity:.6}
    ${theme === "archive" ? `.back::after{content:"";position:absolute;left:0;top:0;bottom:0;width:10px;background:${tokens.accent}}` : ""}
    ${theme === "broadcast" ? `.back::after{content:"";position:absolute;left:0;right:0;bottom:0;height:12px;background:${tokens.accent}}` : ""}
    ${theme === "stage" ? `.edge::after{content:"";position:absolute;left:-1px;top:120px;bottom:120px;border-left:1px dashed ${tokens.accent};opacity:.6}` : ""}
    ${theme === "manga" ? `.back::after{content:"";position:absolute;right:0;bottom:0;width:220px;height:160px;background-image:radial-gradient(${tokens.ink}22 1px,transparent 1px);background-size:9px 9px}` : ""}
  </style></head><body><div class="back" data-theme="${theme}"><div class="edge"></div><div class="content">
    <div class="top">${mark}<div class="kicker">${esc(tokens.label)}<br>Member edition<br><span class="stamp">Not official</span></div></div>
    <p class="index">${esc(collectionName)} · ${esc(tokens.label)}</p>
    <h1>${esc(card.name)}</h1>
    <p class="role">${esc(role)}</p>
    <div class="middle"><p class="bio">${esc(description)}</p><div class="record"><span>Archive record</span><strong>${esc(rarity)}</strong><span>${esc(shortName)}</span></div></div>
    <dl class="facts">${record}</dl>
    <div class="foot"><span>Member archive · not official · no affiliation claimed</span><span>Foilbury</span></div>
  </div></div></body></html>`;
}


const rows = [];
for (const card of cards) {
  const collection = card.collections?.[0];
  const theme = themes[collection.slug];
  const logo = await logoData(card);
  const file = path.join(outDir, `${card.slug}-${theme}-back.png`);
  const html =
    theme === "trial"
      ? trialHtml(card, logo)
      : theme === "table"
        ? tableHtml(card, logo)
        : genericBackHtml(card, logo, theme);
  await page.setContent(html, {
    waitUntil: "load",
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: false });
  for (const edition of card.editions ?? []) {
    for (const variant of edition.variants ?? []) {
      if (!variant.render_url) continue;
      rows.push({
        card: card.name,
        slug: card.slug,
        theme,
        variantId: variant.id,
        material: variant.material_key,
        effect: variant.effect_key,
        source: file,
      });
    }
  }
}
await browser.close();
console.log(
  JSON.stringify(
    {
      mode: apply ? "APPLY" : "DRY RUN",
      cards: cards.length,
      variants: rows.length,
      output: outDir,
    },
    null,
    2,
  ),
);
if (!apply) process.exit(0);

let done = 0;
let failed = 0;
for (const row of rows) {
  try {
    const output = path.join(tmpDir, `${row.variantId}-pilot-back.webp`);
    await composeCardBack({
      backPath: row.source,
      material: row.material === "diamond" ? "diamond" : row.material,
      effect: row.effect ?? "none",
      collectionTheme: row.theme,
      outputPath: output,
    });
    const form = new FormData();
    form.append(
      "back",
      new Blob([fs.readFileSync(output)], { type: "image/webp" }),
      `${row.variantId}-back.webp`,
    );
    await apiForm(`/api/v1/admin/variants/${row.variantId}/back`, form);
    fs.rmSync(output, { force: true });
    done += 1;
  } catch (error) {
    failed += 1;
    console.error(
      `failed ${row.card} ${row.variantId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
console.log(JSON.stringify({ applied: true, done, failed }, null, 2));
if (failed) process.exitCode = 1;
