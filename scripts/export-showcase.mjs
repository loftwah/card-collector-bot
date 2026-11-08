#!/usr/bin/env node
/**
 * Build real, portable stills and playable MP4 exports from the public showcase
 * and a persisted local draw receipt.
 *
 * Public outputs contain only approved public showcase renders. The opening
 * replay uses the local demonstration receipt and is written under the ignored
 * `.foilbury/exports` directory, clearly labelled as a local demo.
 *
 *   node scripts/export-showcase.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const root = process.cwd();
const publicOut = path.join(root, "public", "media", "showcase");
const privateOut = path.join(root, ".foilbury", "exports");
fs.mkdirSync(publicOut, { recursive: true });
fs.mkdirSync(privateOut, { recursive: true });
const wrangler = process.platform === "win32" ? "wrangler.cmd" : "npx";
const d1 = ["wrangler", "d1", "execute", "foilbury-local", "--local", "--json"];
function query(sql) {
  const output = execFileSync(wrangler, [...d1, "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}
const manropeBase64 = fs.readFileSync(path.join(root, "public", "fonts", "manrope-latin.woff2")).toString("base64");
const brandMark = fs.readFileSync(path.join(root, "public", "brand", "kit", "foil-standard", "mark-1024.png")).toString("base64");

function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function bytes(url) {
  const response = await fetch(url.startsWith("http") ? url : `http://127.0.0.1:5173${url}`);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const publicCards = query(`SELECT cd.slug, cd.name, cd.subtitle, c.name AS collection_name, c.slug AS collection_slug,
  m.key AS material_key, fx.key AS effect_key, v.name AS variant_name,
  (SELECT vr.public_url FROM fb_variant_renders vr WHERE vr.variant_id = v.id AND vr.status = 'published' LIMIT 1) AS render_url,
  (SELECT '/media/back/' || br.asset_id FROM fb_variant_back_renders br WHERE br.variant_id = v.id AND br.status = 'published' LIMIT 1) AS back_url
  FROM fb_variants v
  JOIN fb_card_definitions cd ON cd.id = v.card_id
  JOIN fb_materials m ON m.id = v.material_id
  LEFT JOIN fb_effects fx ON fx.id = v.effect_id
  JOIN fb_collection_cards cc ON cc.card_id = cd.id
  JOIN fb_collections c ON c.id = cc.collection_id
  WHERE c.view_audience = 'public' AND c.public_approved_at IS NOT NULL AND c.status = 'published'
    AND v.status = 'published' AND cd.status = 'published'
  GROUP BY cd.id, v.id
  ORDER BY cd.name, CASE m.key WHEN 'plain' THEN 0 WHEN 'silver' THEN 1 WHEN 'gold' THEN 2 ELSE 3 END
  LIMIT 120`);
if (!publicCards.length) throw new Error("No public cards are available to export.");
const byCard = new Map();
for (const card of publicCards) {
  if (!byCard.has(card.slug)) byCard.set(card.slug, []);
  byCard.get(card.slug).push(card);
}
const heroCard = [...byCard.values()].find((variants) => variants.length >= 4) ?? [...byCard.values()][0];
const hero = heroCard[0];
const heroFront = await bytes(hero.render_url);
const heroBack = hero.back_url ? await bytes(hero.back_url) : null;
const heroData = `data:image/webp;base64,${heroFront.toString("base64")}`;
const heroBackData = heroBack ? `data:image/webp;base64,${heroBack.toString("base64")}` : heroData;
const variants = heroCard.slice(0, 4);
const variantData = await Promise.all(variants.map(async (variant) => ({ ...variant, data: `data:image/webp;base64,${(await bytes(variant.render_url)).toString("base64")}` })));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function capture(html, file, width, height) {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file });
}
function baseCss(width, height) {
  return `@font-face{font-family:Manrope;src:url('data:font/woff2;base64,${manropeBase64}') format('woff2');font-weight:200 800}
  *{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;background:#07110f;color:#eff5f1;font-family:Manrope,sans-serif}`;
}
function poster({ width, height, portrait = true, compact = false, title = "Characters worth keeping.", kicker = "FOILBURY · PUBLIC SHOWCASE", card = heroData, back = heroBackData, footer = "FREE TO PLAY · ORIGINAL WORLDS · FOILBURY.LOFTWAH.COM" }) {
  const pad = Math.round(width * 0.065);
  const cardWidth = portrait ? Math.round(width * 0.52) : Math.round(height * 0.67);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(width, height)}
    .stage{position:relative;width:100%;height:100%;padding:${pad}px ${pad}px ${Math.round(pad * 2.3)}px;display:grid;grid-template-columns:${portrait ? "1fr" : "1.05fr .95fr"};gap:${pad * 0.6}px;align-items:center;background:
      linear-gradient(130deg,rgba(44,227,211,.16),transparent 46%),
      linear-gradient(0deg,rgba(201,242,95,.06),transparent 60%),#07110f}
    .grid{position:absolute;inset:0;background-image:linear-gradient(to right,rgba(201,242,95,.08) 1px,transparent 1px),linear-gradient(to bottom,rgba(201,242,95,.06) 1px,transparent 1px);background-size:${Math.round(width / 18)}px ${Math.round(width / 18)}px;mask-image:linear-gradient(110deg,transparent 10%,black 80%)}
    .copy{position:relative;z-index:2}
    .mark{width:${Math.round(width * 0.075)}px;height:${Math.round(width * 0.075)}px;border:1px solid #2ce3d3;margin-bottom:${pad * 0.5}px}
    .kicker{font-family:ui-monospace,monospace;font-size:${Math.round(width * 0.014)}px;letter-spacing:.22em;color:#2ce3d3;text-transform:uppercase}
    h1{font-size:${Math.round(width * (portrait ? 0.095 : 0.062))}px;line-height:.92;letter-spacing:-.055em;text-transform:uppercase;margin-top:${pad * 0.4}px;max-width:12ch}
    .sub{font-size:${Math.round(width * 0.022)}px;line-height:1.4;color:#b6cec7;margin-top:${pad * 0.5}px;max-width:28ch}
    .rule{height:8px;background:linear-gradient(90deg,#2ce3d3 0 42%,#c9f25f 42% 64%,#eff5f1 64% 100%);margin-top:${pad * 0.55}px;width:${Math.round(width * 0.4)}px}
    .cardwrap{position:relative;z-index:2;display:grid;place-items:center}
    .cardwrap img{width:${cardWidth}px;max-height:${Math.round(height * 0.72)}px;object-fit:contain;filter:drop-shadow(0 ${Math.round(height * 0.05)}px ${Math.round(height * 0.06)}px rgba(0,0,0,.7));transform:rotate(-2deg)}
    .cardwrap .back{position:absolute;width:${Math.round(cardWidth * 0.7)}px;transform:rotate(7deg) translate(${Math.round(cardWidth * 0.35)}px,${Math.round(cardWidth * 0.1)}px);opacity:.9}
    .footer{position:absolute;left:${pad}px;right:${pad}px;bottom:${pad * 0.6}px;display:flex;justify-content:space-between;font-family:ui-monospace,monospace;font-size:${Math.round(width * 0.012)}px;letter-spacing:.16em;color:#8aa39b;text-transform:uppercase}
    .stamp{position:absolute;z-index:4;right:${pad}px;top:${pad}px;background:rgba(7,17,15,.88);border:1px solid #c9f25f;color:#c9f25f;font-family:ui-monospace,monospace;font-size:${Math.round(width * 0.012)}px;letter-spacing:.12em;padding:6px 9px;text-transform:uppercase;transform:rotate(1.5deg)}
    ${compact ? `.stage{padding-bottom:${Math.round(pad * 2.1)}px}.mark{width:48px;height:48px;margin-bottom:16px}.kicker{font-size:12px}h1{font-size:56px;line-height:.95;max-width:14ch;margin-top:14px}.sub{font-size:16px;line-height:1.35;max-width:38ch;margin-top:14px}.rule{height:6px;width:220px;margin-top:16px}.footer{font-size:10px;letter-spacing:.14em}` : ""}
  </style></head><body><div class="stage"><div class="grid"></div><div class="copy"><img class="mark" src="data:image/png;base64,${brandMark}" alt=""><p class="kicker">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="sub">${esc(hero.name)} · ${esc(hero.collection_name)}. A real public card, a designed back, four finishes and a serial that belongs to its owner.</p><div class="rule"></div></div><div class="cardwrap"><img class="back" src="${back}" alt=""><img src="${card}" alt=""></div><div class="footer"><span>${esc(footer)}</span><span>${new Date().toISOString().slice(0, 10)}</span></div><span class="stamp">Public-safe</span></div></body></html>`;
}
const sizes = [
  { name: "card-1x1-1080.png", width: 1080, height: 1080, portrait: false, title: "A card worth keeping." },
  { name: "card-4x5-1080.png", width: 1080, height: 1350, portrait: true, title: "Front. Back. Yours." },
  { name: "card-9x16-1080.png", width: 1080, height: 1920, portrait: true, title: "Hold it to the light." },
  { name: "card-16x9-1920.png", width: 1920, height: 1080, portrait: false, title: "Characters worth keeping." },
];
for (const size of sizes) {
  const file = path.join(publicOut, size.name);
  await capture(poster(size), file, size.width, size.height);
  console.log(`still ${size.name}`);
}

const ogFile = path.join(publicOut, "og-1200x630.png");
await capture(poster({ width: 1200, height: 630, portrait: false, compact: true, title: "Characters worth keeping.", kicker: "FOILBURY · PUBLIC SHOWCASE", footer: "FOILBURY.LOFTWAH.COM" }), ogFile, 1200, 630);

const mastery = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(1920, 1080)}
  .stage{position:relative;width:100%;height:100%;padding:70px;background:linear-gradient(130deg,rgba(44,227,211,.12),transparent 48%),#07110f}
  h1{font-size:84px;line-height:.92;letter-spacing:-.05em;text-transform:uppercase}.k{font-family:ui-monospace,monospace;font-size:17px;letter-spacing:.2em;color:#2ce3d3;text-transform:uppercase}
  .row{display:grid;grid-template-columns:repeat(4,1fr);gap:22px;margin-top:38px}.row figure{border:1px solid #2b4a44;background:#0d1a17;padding:8px}.row img{width:100%;display:block}.row figcaption{font-family:ui-monospace,monospace;font-size:15px;letter-spacing:.12em;color:#b6cec7;text-transform:uppercase;margin-top:8px}
  .foot{position:absolute;left:70px;bottom:42px;font-family:ui-monospace,monospace;font-size:14px;letter-spacing:.14em;color:#8aa39b;text-transform:uppercase}
</style></head><body><div class="stage"><p class="k">Finish mastery · public showcase</p><h1>${esc(hero.name)}<br>four ways.</h1><div class="row">${variantData.map((variant) => `<figure><img src="${variant.data}" alt=""><figcaption>${esc(variant.variant_name)}</figcaption></figure>`).join("")}</div><p class="foot">Real published renders · Plain / Silver / Gold / Holographic · Foilbury original card design</p></div></body></html>`;
await capture(mastery, path.join(publicOut, "finish-mastery-16x9-1920.png"), 1920, 1080);

function ffmpeg(args) {
  execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
}
function zoomClip(input, output, seconds, width, height) {
  ffmpeg(["-y", "-loop", "1", "-i", input, "-vf", `scale=${width}:${height},zoompan=z='min(zoom+0.0009,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${seconds * 30}:s=${width}x${height},fade=t=in:st=0:d=0.5,fade=t=out:st=${seconds - 0.6}:d=0.6`, "-t", String(seconds), "-r", "30", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
}
const trailerParts = [];
const publicVariants = [...byCard.values()].flat().slice(0, 3);
for (const [index, card] of publicVariants.entries()) {
  const data = await bytes(card.render_url);
  const slide = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(1920, 1080)}
    .stage{position:relative;width:100%;height:100%;display:grid;grid-template-columns:1fr 1fr;align-items:center;padding:80px;background:linear-gradient(130deg,rgba(44,227,211,.14),transparent 44%),#07110f}
    h1{font-size:88px;line-height:.9;letter-spacing:-.05em;text-transform:uppercase}.k{font-family:ui-monospace,monospace;font-size:16px;letter-spacing:.2em;color:#2ce3d3;text-transform:uppercase}.sub{font-size:26px;color:#b6cec7;margin-top:28px}
    img{width:420px;max-height:820px;object-fit:contain;justify-self:center;filter:drop-shadow(0 40px 50px rgba(0,0,0,.7));transform:rotate(-2deg)}
    .foot{position:absolute;left:80px;bottom:44px;font-family:ui-monospace,monospace;font-size:14px;letter-spacing:.14em;color:#8aa39b;text-transform:uppercase}
  </style></head><body><div class="stage"><div><p class="k">Foilbury · public showcase · ${index + 1}/3</p><h1>${esc(card.name)}</h1><p class="sub">${esc(card.collection_name)} · ${esc(card.variant_name)}. A real published render, not a mock-up.</p></div><img src="data:image/webp;base64,${data.toString("base64")}" alt=""><p class="foot">Free to play · inspect the odds · keep the card · foilbury.loftwah.com</p></div></body></html>`;
  const file = path.join(privateOut, `trailer-slide-${index + 1}.png`);
  await capture(slide, file, 1920, 1080);
  const clip = path.join(privateOut, `trailer-clip-${index + 1}.mp4`);
  zoomClip(file, clip, 6, 1920, 1080);
  trailerParts.push(clip);
}
const concatFile = path.join(privateOut, "trailer-concat.txt");
fs.writeFileSync(concatFile, trailerParts.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", "-movflags", "+faststart", path.join(publicOut, "foilbury-trailer-16x9.mp4")]);
zoomClip(path.join(publicOut, "card-9x16-1080.png"), path.join(publicOut, "foilbury-teaser-9x16.mp4"), 8, 1080, 1920);

const draw = query(`SELECT id, instance_id, receipt_json, created_at FROM fb_draws ORDER BY created_at DESC LIMIT 1`)[0];
let replayManifest = null;
if (draw) {
  const receipt = JSON.parse(draw.receipt_json);
  let frontData = "";
  let replayImageNote = "Persisted local draw receipt; the recorded render is no longer available, so this poster shows the receipt facts without substitute card art.";
  try {
    const front = await bytes(receipt.render_url);
    frontData = `data:image/webp;base64,${front.toString("base64")}`;
    replayImageNote = "Persisted local draw receipt and its recorded render.";
  } catch {
    // Never substitute another card's art. Label the missing render honestly.
  }
  const cardVisual = frontData
    ? `<img src="${frontData}" alt="">`
    : `<div class="missing"><span>Recorded render unavailable</span><small>Receipt facts only · no substitute art</small></div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(1080, 1920)}
    .stage{position:relative;width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(150deg,rgba(44,227,211,.16),transparent 50%),#07110f}
    .k{position:absolute;top:86px;left:74px;font-family:ui-monospace,monospace;font-size:17px;letter-spacing:.18em;color:#2ce3d3;text-transform:uppercase}
    .local{position:absolute;top:86px;right:74px;border:1px solid #c9f25f;color:#c9f25f;font-family:ui-monospace,monospace;font-size:13px;letter-spacing:.12em;padding:7px 10px;text-transform:uppercase}
    img{width:720px;max-height:1200px;object-fit:contain;filter:drop-shadow(0 60px 60px rgba(0,0,0,.8));transform:rotate(-2deg)}
    .missing{width:720px;height:1000px;display:grid;place-items:center;border:1px solid #3d6259;background:repeating-linear-gradient(135deg,#0d1b17 0 18px,#10231e 18px 36px);text-align:center;padding:40px}
    .missing span{font-size:44px;line-height:1;text-transform:uppercase;letter-spacing:-.04em}.missing small{display:block;margin-top:14px;font-family:ui-monospace,monospace;font-size:16px;letter-spacing:.12em;color:#8aa39b;text-transform:uppercase}
    .copy{position:absolute;left:74px;right:74px;bottom:110px}.copy h1{font-size:66px;line-height:.92;letter-spacing:-.05em;text-transform:uppercase}.copy p{font-family:ui-monospace,monospace;font-size:16px;letter-spacing:.12em;color:#b6cec7;margin-top:12px;text-transform:uppercase}
    .foot{position:absolute;left:74px;right:74px;bottom:44px;font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.14em;color:#8aa39b;text-transform:uppercase;display:flex;justify-content:space-between}
  </style></head><body><div class="stage"><p class="k">Opening replay · persisted receipt</p><span class="local">Local demo · not a public pull</span>${cardVisual}<div class="copy"><h1>${esc(receipt.card_name)}</h1><p>${esc(receipt.variant_name)} · serial ${esc(receipt.serial)} · ${esc(receipt.probability_bps / 100)}% shown odds · pool v${esc(receipt.pool_revision)}</p></div><div class="foot"><span>Recorded ${esc(draw.created_at)}</span><span>Receipt ${esc(draw.id)}</span></div></div></body></html>`;
  const file = path.join(privateOut, "opening-replay-poster.png");
  await capture(html, file, 1080, 1920);
  zoomClip(file, path.join(privateOut, "opening-replay-9x16.mp4"), 7, 1080, 1920);
  replayManifest = { draw_id: draw.id, instance_id: draw.instance_id, receipt_created_at: draw.created_at, card: receipt.card_name, variant: receipt.variant_name, serial: receipt.serial, pool_revision: receipt.pool_revision, audience: "local-demo-private", image_note: replayImageNote, output: ".foilbury/exports/opening-replay-9x16.mp4" };
}

await browser.close();
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
const rendered = [];
for (const name of fs.readdirSync(publicOut).sort()) {
  rendered.push({ file: `public/media/showcase/${name}`, sha256: hash(`public/media/showcase/${name}`), bytes: fs.statSync(path.join(publicOut, name)).size });
}
const manifest = {
  generated_at: new Date().toISOString(),
  source_commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  audience: "public-safe Foilbury originals",
  public_card: { name: hero.name, collection: hero.collection_name, render: hero.render_url },
  outputs: rendered,
  private_demo: replayManifest,
  regeneration: "node scripts/export-showcase.mjs",
  notes: [
    "Stills and public trailer use only approved public showcase renders.",
    "The opening replay is a real persisted local draw receipt, kept private and labelled local demo.",
    "Video is silent by design; no music or voice rights are implied.",
    "The export action never draws, spends, grants or mutates gameplay.",
  ],
};
fs.writeFileSync(path.join(publicOut, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, publicOutputs: rendered.length, trailer: "public/media/showcase/foilbury-trailer-16x9.mp4", teaser: "public/media/showcase/foilbury-teaser-9x16.mp4", replay: replayManifest?.output ?? null }, null, 2));
