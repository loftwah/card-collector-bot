#!/usr/bin/env node
/**
 * Build and publish designed backs for multi-print editions.
 *
 *   node scripts/art/render-print-backs.mjs --only=tux
 *
 * The front is the print artwork; the back is an independently designed
 * information object with the print number, bio, attributes and provenance.
 * Text, marks and serials are rendered deterministically outside the artwork.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { composeCardBack } from "../../art/compose.mjs";
import { apiForm, apiJson, ensureServer } from "../lib/api.mjs";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1] ?? null;
const outDir = path.join(root, ".foilbury/generated/print-backs");
const tmpDir = path.join(root, ".foilbury/tmp");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

const manrope = fs.readFileSync(path.join(root, "public/fonts/manrope-latin.woff2")).toString("base64");
const fraunces = fs.readFileSync(path.join(root, "public/fonts/Fraunces.ttf")).toString("base64");
const collectionMarks = {
  fighter: fs.readFileSync(path.join(root, "public/art/collections/fighter.svg")).toString("base64"),
  "protocol-11": fs.readFileSync(path.join(root, "public/art/collections/protocol-11.svg")).toString("base64"),
  bubbles: fs.readFileSync(path.join(root, "public/art/collections/bubbles.svg")).toString("base64"),
};

const cards = (await apiJson("/api/v1/admin/cards?limit=300")).items;
const selections = JSON.parse(
  fs.readFileSync(path.join(root, ".foilbury/content/print-selections.json"), "utf8"),
);
const plan = JSON.parse(fs.readFileSync(path.join(root, ".foilbury/content/print-set.json"), "utf8"));
const allowedEditions = new Set();
for (const selection of selections.prints) {
  const subject = plan.subjects.find((item) => item.slug === selection.subject);
  const print = subject?.prints.find(
    (item) =>
      `${item.print_number}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` ===
      selection.print,
  );
  const card = cards.find((item) => item.slug === subject?.card_slug);
  if (print && card) allowedEditions.add(`${card.name} — ${print.title}`);
}
await ensureServer();

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: 750, height: 1050 });

let uploaded = 0;
let skipped = 0;
for (const card of cards) {
  const editions = card.editions.filter((edition) => allowedEditions.has(edition.name));
  if (!editions.length) continue;
  if (only && !card.slug.includes(only)) continue;
  const collection = card.collections[0];
  const mark = collectionMarks[collection?.slug] ?? "";
  const proposals = (await apiJson(`/api/v1/admin/cards/${card.id}/prints`)).items;
  const attributes = (() => {
    try {
      return JSON.parse(card.attributes_json ?? "[]");
    } catch {
      return [];
    }
  })();
  for (const edition of editions) {
    const printTitle = edition.name.split(" — ").slice(1).join(" — ");
    const proposal = proposals.find((item) => item.title.endsWith(`· ${printTitle}`));
    const printNumber = proposal?.print_number ?? "—";
    const provenance = proposal?.provenance ?? {};
    const generation = provenance.generation ?? {};
    const reviewNote = proposal?.review_note ?? provenance.review_note ?? "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manrope}') format('woff2');font-weight:200 800}
      @font-face{font-family:Fraunces;src:url('data:font/ttf;base64,${fraunces}') format('truetype');font-weight:100 900}
      *{margin:0;padding:0;box-sizing:border-box}html,body{width:750px;height:1050px;background:#07110f;color:#eff5f1;font-family:Manrope,sans-serif;overflow:hidden}
      .back{position:relative;width:750px;height:1050px;padding:66px 64px;background:
        radial-gradient(circle at 82% 12%,rgba(44,227,211,.12),transparent 38%),
        radial-gradient(circle at 10% 88%,rgba(201,242,95,.08),transparent 34%),
        linear-gradient(145deg,#0b1a16,#07110f 58%,#0b1a16)}
      .frame{position:absolute;inset:28px;border:1px solid #3d6259}.frame::before{content:"";position:absolute;inset:7px;border:1px solid rgba(201,242,95,.16)}
      .top{display:flex;align-items:center;gap:14px;border-bottom:1px solid rgba(239,245,241,.18);padding-bottom:16px}
      .top img{width:48px;height:48px;object-fit:contain;border:1px solid rgba(201,242,95,.45);background:#07110f}
      .kicker{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#2ce3d3}
      .stamp{position:absolute;right:64px;top:74px;border:1px solid #c9f25f;color:#c9f25f;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.12em;padding:5px 8px;text-transform:uppercase;transform:rotate(1.2deg)}
      h1{font-family:Fraunces,serif;font-size:62px;line-height:.94;letter-spacing:-.03em;margin-top:34px}
      .print{font-family:ui-monospace,monospace;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#c9f25f;margin-top:10px}
      .bio{font-size:17px;line-height:1.55;color:#cfe0da;margin-top:22px;display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
      dl{display:grid;grid-template-columns:1fr 1fr;gap:12px 22px;margin-top:22px;border-top:1px solid rgba(239,245,241,.14);padding-top:16px}
      dt{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#8aa39b}
      dd{font-size:14px;color:#eff5f1;margin-top:3px}
      .big-number{position:absolute;right:38px;top:360px;font-family:Fraunces,serif;font-size:250px;line-height:1;color:transparent;-webkit-text-stroke:1px rgba(201,242,95,.16);opacity:.9;pointer-events:none}
      .notes{margin-top:24px;border-top:1px solid rgba(239,245,241,.14);padding-top:16px}
      .notes h2{font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#2ce3d3;margin-bottom:6px}
      .notes p{font-size:12.5px;line-height:1.55;color:#cfe0da}
      .notes p + h2{margin-top:14px}
      .provenance{position:absolute;left:64px;right:64px;bottom:100px;border-top:1px solid rgba(239,245,241,.14);padding-top:11px;font-size:9.5px;line-height:1.5;color:#8aa39b}
      .foot{position:absolute;left:64px;right:64px;bottom:54px;display:flex;justify-content:space-between;font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:#8aa39b}
      .watermark{position:absolute;right:-50px;bottom:170px;width:320px;height:320px;object-fit:contain;opacity:.05;filter:grayscale(1)}
    </style></head><body><div class="back"><div class="frame"></div>
      <img class="watermark" src="data:image/svg+xml;base64,${mark}" alt="">
      <span class="stamp">Alternate print</span>
      <div class="top"><img src="data:image/svg+xml;base64,${mark}" alt=""><div><p class="kicker">${esc(collection?.name ?? "Foilbury")}</p><p style="font-family:ui-monospace,monospace;font-size:9px;letter-spacing:.12em;color:#8aa39b;margin-top:4px">MEMBER EDITION · DESIGNED BACK</p></div></div>
      <span class="big-number" aria-hidden="true">${esc(printNumber)}</span>
      <h1>${esc(card.name)}</h1>
      <p class="print">Print ${esc(printNumber)} · ${esc(printTitle)}</p>
      <p class="bio">${esc(card.bio_safe ?? card.bio ?? card.description ?? "")}</p>
      <dl>${(attributes.length ? attributes.slice(0, 4) : [{ label: "Collection", value: collection?.name ?? "Foilbury" }, { label: "Print role", value: String(proposal?.role ?? "alternate print").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()) }]).map((attribute) => `<div><dt>${esc(attribute.label)}</dt><dd>${esc(attribute.value)}${attribute.unit ? ` ${esc(attribute.unit)}` : ""}</dd></div>`).join("")}</dl>
      <div class="notes">
        ${reviewNote ? `<h2>Print note</h2><p>${esc(reviewNote)}</p>` : ""}
        <h2>Release and provenance</h2>
        <p>${esc(collection?.name ?? "Foilbury")} · print ${esc(printNumber)}. ${generation.endpoint ? `Artwork generated with ${esc(generation.endpoint)} from the reviewed identity reference.` : ""} Reviewed under delegated authority on 2026/11/04. The finish is a material treatment of this print, not a separate print.</p>
      </div>
      <div class="provenance">Original Foilbury character and original composition. Not official artwork for any third-party property. Copy serials are issued only to owned cards; this published back carries the print identity.</div>
      <div class="foot"><span>Foilbury · ${esc(collection?.name ?? "Cabinet")}</span><span>Print ${esc(printNumber)} · designed back</span></div>
    </div></body></html>`;
    const base = path.join(outDir, `${card.slug}-${String(printNumber).padStart(2, "0")}.png`);
    if (!fs.existsSync(base)) {
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: base, omitBackground: false });
    }
    for (const variant of edition.variants) {
      const output = path.join(tmpDir, `${variant.id}-print-back.webp`);
      await composeCardBack({
        backPath: base,
        material: variant.material_key,
        effect: variant.effect_key ?? "none",
        outputPath: output,
      });
      const form = new FormData();
      form.append("back", new Blob([fs.readFileSync(output)], { type: "image/webp" }), `${variant.id}-back.webp`);
      await apiForm(`/api/v1/admin/variants/${variant.id}/back`, form);
      uploaded += 1;
      fs.rmSync(output, { force: true });
    }
  }
}
await browser.close();
console.log(JSON.stringify({ uploaded, skipped, output: outDir }, null, 2));
