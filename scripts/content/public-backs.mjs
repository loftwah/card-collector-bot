#!/usr/bin/env node
/**
 * Build designed public-safe card backs from the approved public catalogue and
 * publish them through the same authenticated back-render endpoint.
 *
 * This does not change fronts, variants, ownership, serials or the award ledger.
 * Run against the local server first; production requires a backup and approval.
 *
 *   node scripts/content/public-backs.mjs --dry-run
 *   node scripts/content/public-backs.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { composeCardBack } from "../../art/compose.mjs";
import { apiForm, apiJson, agentToken, accessHeaders, ensureServer, BASE_URL } from "../lib/api.mjs";

const apply = process.argv.includes("--apply");
const root = process.cwd();
const outDir = path.join(root, ".foilbury", "generated", "public-backs");
const tmpDir = path.join(root, ".foilbury", "tmp");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

await ensureServer();
const catalogue = await apiJson("/api/v1/catalogue?limit=100");
const cards = catalogue.items.filter((card) => card.editions.some((edition) => edition.variants.some((variant) => variant.render_url)) && card.collections.length > 0 && card.collections.every((collection) => collection.view_audience === "public"));
const manrope = fs.readFileSync(path.join(root, "public", "fonts", "manrope-latin.woff2")).toString("base64");
const fraunces = fs.readFileSync(path.join(root, "public", "fonts", "Fraunces.ttf")).toString("base64");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 750, height: 1050 });

function esc(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const rows = [];
for (const card of cards) {
  const collection = card.collections[0];
  let logo = "";
  if (collection?.logo_url) {
    try {
      const response = await fetch(`${BASE_URL}${collection.logo_url}`, { headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() } });
      if (response.ok) logo = `data:${collection.logo_url.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    } catch {}
  }
  const attrs = (() => { try { return JSON.parse(card.attributes_json ?? "[]"); } catch { return []; } })();
  const attrMarkup = attrs.slice(0, 4).map((attribute) => `<div><dt>${esc(attribute.label)}</dt><dd>${esc(attribute.value)}${attribute.unit ? ` ${esc(attribute.unit)}` : ""}</dd></div>`).join("")
    || `<div><dt>Collection</dt><dd>${esc(collection?.name ?? "Foilbury")}</dd></div><div><dt>Category</dt><dd>${esc(card.category?.name ?? "Cabinet card")}</dd></div><div><dt>Rarity</dt><dd>${esc(card.rarity?.name ?? "Unclassified")}</dd></div><div><dt>Source</dt><dd>${esc(card.source_work ?? "Foilbury original")}</dd></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manrope}') format('woff2');font-weight:200 800}
    @font-face{font-family:Fraunces;src:url('data:font/ttf;base64,${fraunces}') format('truetype');font-weight:100 900}
    *{margin:0;padding:0;box-sizing:border-box}html,body{width:750px;height:1050px;background:#07110f;color:#eff5f1;font-family:Manrope,sans-serif;overflow:hidden}
    .back{position:relative;width:750px;height:1050px;padding:72px 64px;background:
      radial-gradient(circle at 80% 16%,rgba(44,227,211,.10),transparent 38%),
      linear-gradient(140deg,#0b1a16,#07110f 55%,#0b1a16)}
    .frame{position:absolute;inset:30px;border:1px solid #3d6259}.frame::before{content:"";position:absolute;inset:8px;border:1px solid rgba(201,242,95,.18)}
    .top{display:flex;align-items:center;gap:16px;border-bottom:1px solid rgba(239,245,241,.18);padding-bottom:18px}
    .top img{width:52px;height:52px;object-fit:contain;border:1px solid rgba(201,242,95,.5)}
    .kicker{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#2ce3d3}
    h1{font-family:Fraunces,serif;font-size:64px;line-height:.95;letter-spacing:-.03em;margin-top:38px}
    .sub{font-size:19px;color:#b6cec7;margin-top:10px}
    .bio{font-size:18px;line-height:1.55;color:#cfe0da;margin-top:24px;display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
    .bio.small{font-size:16px;-webkit-line-clamp:10}
    .watermark{position:absolute;right:-60px;bottom:140px;width:360px;height:360px;object-fit:contain;opacity:.05;filter:grayscale(1)}
    dl{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px;margin-top:26px;border-top:1px solid rgba(239,245,241,.14);padding-top:18px}
    dt{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8aa39b}
    dd{font-size:15px;color:#eff5f1;margin-top:3px}
    .credit{position:absolute;left:64px;right:64px;bottom:96px;border-top:1px solid rgba(239,245,241,.14);padding-top:14px;font-size:11px;line-height:1.5;color:#8aa39b}
    .foot{position:absolute;left:64px;right:64px;bottom:54px;display:flex;justify-content:space-between;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8aa39b}
    .stamp{position:absolute;right:64px;top:76px;border:1px solid #c9f25f;color:#c9f25f;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;padding:5px 7px;text-transform:uppercase;transform:rotate(1.5deg)}
  </style></head><body><div class="back"><div class="frame"></div><img class="watermark" src="${logo}" alt=""><div class="top"><img src="${logo}" alt=""><div><p class="kicker">${esc(collection?.name ?? "Foilbury")}</p><p style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;color:#8aa39b;margin-top:4px">PUBLIC SHOWCASE · DESIGNED BACK</p></div></div><span class="stamp">Public-safe</span><h1>${esc(card.name)}</h1><p class="sub">${esc(card.subtitle ?? "")}</p><p class="bio ${(card.bio_safe ?? card.description ?? "").length > 480 ? "small" : ""}">${esc(card.bio_safe ?? card.description ?? "")}</p><dl>${attrMarkup}</dl><div class="credit">${esc(card.credit ?? "Foilbury original card design. Source art credited by the owner.")}</div><div class="foot"><span>Foilbury · ${esc(collection?.name ?? "Public showcase")}</span><span>No serial on a published back</span></div></div></body></html>`;
  const file = path.join(outDir, `${card.slug}-back.png`);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: false });
  for (const edition of card.editions) {
    for (const variant of edition.variants) {
      if (!variant.render_url) continue;
      rows.push({ card: card.name, slug: card.slug, variantId: variant.id, material: variant.material_key, effect: variant.effect_key, source: file });
    }
  }
}
await browser.close();
console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY RUN", cards: cards.length, variants: rows.length, output: outDir }, null, 2));
if (!apply) {
  console.log("\nDry run only. Re-run with --apply to publish designed backs through the authenticated endpoint.");
  process.exit(0);
}
let done = 0;
let failed = 0;
for (const row of rows) {
  try {
    const output = path.join(tmpDir, `${row.variantId}-public-back.webp`);
    await composeCardBack({ backPath: row.source, material: row.material === "diamond" ? "diamond" : row.material, effect: row.effect ?? "none", outputPath: output });
    const form = new FormData();
    form.append("back", new Blob([fs.readFileSync(output)], { type: "image/webp" }), `${row.variantId}-back.webp`);
    await apiForm(`/api/v1/admin/variants/${row.variantId}/back`, form);
    fs.rmSync(output, { force: true });
    done += 1;
  } catch (error) {
    failed += 1;
    console.error(`failed ${row.card} ${row.variantId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(JSON.stringify({ applied: true, done, failed }, null, 2));
