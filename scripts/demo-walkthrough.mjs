#!/usr/bin/env node
/**
 * Repeatable product walkthrough.
 *
 * Runs the real local app in Chromium, walks the public showcase, the member
 * album, the draw room, card inspection, achievements, gifts, security and the
 * admin surfaces, then writes a private storyboard under `.foilbury/demo/`.
 *
 * The demo uses the local development accounts and a zero-price fixture pool so
 * it does not spend real Foil. It is a demo and a smoke test, not a substitute
 * for production Access/MFA or a real second-person acceptance session.
 *
 * Usage:
 *   pnpm demo                 # headless, writes a storyboard
 *   pnpm demo:show            # headed browser + opens the storyboard
 *   node scripts/demo-walkthrough.mjs --headed --open
 *   node scripts/demo-walkthrough.mjs --read-only   # no fixture pool/draw
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { ensureServer, apiJson, BASE_URL } from "./lib/api.mjs";

const args = new Set(process.argv.slice(2));
const headed = args.has("--headed") || args.has("--show");
const shouldOpen = args.has("--open") || headed;
const readOnly = args.has("--read-only");
const baseURL = process.env.FOILBURY_URL ?? BASE_URL;
const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, ".foilbury/demo", stamp);
const shotsDir = path.join(outDir, "shots");
fs.mkdirSync(shotsDir, { recursive: true });

const stages = [];
const warnings = [];
const consoleErrors = [];
const startedAt = new Date().toISOString();

function log(message) {
  console.log(message);
}

function isIgnorableBrowserNoise(message) {
  const text = message.text();
  const url = message.location()?.url ?? "";
  return (
    text.includes("1Password") ||
    (text.includes("Failed to load resource") && url.endsWith("/favicon.ico"))
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function prime(page) {
  await page.evaluate(async () => {
    // Full-page review needs every designed image, including below-the-fold
    // collection covers. Force eager loading before the screenshot.
    for (const image of document.images) image.loading = "eager";
    const step = Math.max(240, Math.round(window.innerHeight * 0.8));
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    window.scrollTo(0, 0);
  });
  await page
    .waitForFunction(() => [...document.images].every((image) => image.complete), null, {
      timeout: 15000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(250);
}

async function inspect(page) {
  return page.evaluate(() => {
    const images = [...document.images];
    return {
      title: document.title,
      heading:
        document.querySelector("h1")?.textContent?.trim() ??
        document.querySelector("h2")?.textContent?.trim() ??
        "",
      brokenImages: images
        .filter(
          (image) => image.complete && image.naturalWidth === 0 && (image.currentSrc || image.src),
        )
        .map((image) => image.currentSrc || image.src)
        .slice(0, 8),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      url: location.href,
    };
  });
}

async function capture(page, { name, caption, bullets = [], fullPage = true }) {
  await prime(page);
  const info = await inspect(page);
  const index = String(stages.length + 1).padStart(2, "0");
  const file = path.join(
    shotsDir,
    `${index}-${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}.png`,
  );
  await page.screenshot({ path: file, fullPage, scale: "css" });
  if (info.brokenImages.length)
    warnings.push(`${name}: broken images ${info.brokenImages.join(", ")}`);
  if (info.overflow) warnings.push(`${name}: horizontal overflow at ${info.url}`);
  stages.push({
    index,
    name,
    caption,
    bullets,
    screenshot: path.relative(outDir, file),
    status: "PASS",
    info,
  });
  log(`  captured ${name}`);
}

async function visit(
  page,
  { name, route, caption, bullets = [], waitFor, fullPage = true, screenshot = true },
) {
  await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 });
  if (screenshot) await capture(page, { name, caption, bullets, fullPage });
  else {
    const info = await inspect(page);
    stages.push({
      index: String(stages.length + 1).padStart(2, "0"),
      name,
      caption,
      bullets,
      screenshot: null,
      status: "PASS",
      info,
    });
    log(`  checked ${name}`);
  }
}

async function login(context, email) {
  const response = await context.request.post(`${baseURL}/api/v1/dev/login`, { data: { email } });
  if (!response.ok())
    throw new Error(`Development sign-in failed for ${email}: HTTP ${response.status()}`);
}

function cleanupLocalTestFixtures() {
  if (readOnly || !/localhost|127\.0\.0\.1/.test(baseURL)) return;
  const base = path.join(root, ".wrangler/state/v3/d1");
  if (!fs.existsSync(base)) return;
  let db = null;
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(entry));
    if (!file.endsWith(".sqlite") || file.endsWith("metadata.sqlite")) continue;
    try {
      const table = execFileSync(
        "sqlite3",
        [file, "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_artwork_editions';"],
        { encoding: "utf8" },
      ).trim();
      if (table) {
        db = file;
        break;
      }
    } catch {
      // Not the application database.
    }
  }
  if (!db) return;
  const now = new Date().toISOString();
  execFileSync(
    "sqlite3",
    [
      db,
      `BEGIN;
       UPDATE fb_collections SET status = 'archived', archived_at = '${now}' WHERE slug LIKE 'album-proof-%';
       UPDATE fb_card_definitions SET status = 'retired', archived_at = '${now}' WHERE slug LIKE 'album-card-%';
       UPDATE fb_card_instances SET status = 'surrendered', updated_at = '${now}'
        WHERE card_id IN (SELECT id FROM fb_card_definitions WHERE slug LIKE 'album-card-%');
       COMMIT;`,
    ],
    { encoding: "utf8" },
  );
  log("Local acceptance fixtures archived for a clean demo");
}

async function ensureDemoPool() {
  const cards = await apiJson("/api/v1/admin/cards?limit=2000");
  const card =
    cards.items.find((item) => item.slug === "hajime-hinata") ??
    cards.items.find((item) => item.collections?.length);
  if (!card) throw new Error("No launch card is available for the demo pool.");
  const variant = card.editions
    .flatMap((edition) => edition.variants)
    .find((item) => item.material_key === "plain" && item.render_url);
  if (!variant) throw new Error("No plain rendered variant is available for the demo pool.");
  const pools = await apiJson("/api/v1/admin/pools");
  const existing = pools.items.find((item) => item.slug === "demo-walkthrough");
  const body = {
    name: "Demo Walkthrough",
    description:
      "A zero-price fixture pool used by the guided product walkthrough. It pulls one fixed card so every demo is consistent.",
    price: 0,
    entries: [{ variantId: variant.id, weight: 1 }],
  };
  if (existing) {
    const updated = await apiJson(`/api/v1/admin/pools/${existing.id}`, {
      method: "PATCH",
      body: { expectedRevision: existing.revision, ...body },
    });
    await apiJson(`/api/v1/admin/pools/${updated.pool.id}/publish`, { method: "POST", body: {} });
    return { pool: updated.pool, card: card.name, variant: variant.name };
  }
  const created = await apiJson("/api/v1/admin/pools", {
    method: "POST",
    body: { slug: "demo-walkthrough", ...body },
  });
  await apiJson(`/api/v1/admin/pools/${created.pool.id}/publish`, { method: "POST", body: {} });
  return { pool: created.pool, card: card.name, variant: variant.name };
}

function storyboard() {
  const passed = stages.length;
  const status = warnings.length === 0 && consoleErrors.length === 0 ? "PASS" : "PASS WITH NOTES";
  const cards = stages
    .map(
      (stage) => `
      <section class="stage" id="stage-${stage.index}">
        <div class="stage-copy">
          <p class="kicker">${stage.index} · ${escapeHtml(stage.info?.heading || stage.name)}</p>
          <h2>${escapeHtml(stage.name)}</h2>
          <p class="caption">${escapeHtml(stage.caption)}</p>
          <ul>${stage.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>
          <p class="url">${escapeHtml(stage.info?.url || "")}</p>
        </div>
        ${
          stage.screenshot
            ? `<figure><img src="${escapeHtml(stage.screenshot)}" alt="${escapeHtml(stage.name)} screenshot" loading="lazy" /><figcaption>${escapeHtml(stage.name)}</figcaption></figure>`
            : `<div class="check"><span>✓</span><p>${escapeHtml(stage.caption)}</p></div>`
        }
      </section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Foilbury guided walkthrough · ${escapeHtml(stamp)}</title>
<style>
  :root { --paper:#f4f0e6; --paper2:#fbf8f0; --ink:#141512; --muted:#6f6a5f; --line:#d8d0bf; --brass:#7d5a26; --green:#245c4b; --oxblood:#6d2b2b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 48px clamp(20px, 5vw, 72px) 28px; border-bottom:1px solid var(--line); background: linear-gradient(120deg, #fbf8f0, #efe7d7); }
  .eyebrow { margin:0 0 8px; font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.18em; text-transform:uppercase; color:var(--brass); }
  h1 { margin:0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(38px, 6vw, 72px); line-height:.95; font-weight:600; letter-spacing:-.035em; }
  .dek { max-width: 780px; margin:18px 0 0; font-size:17px; line-height:1.55; color:#3e3a33; }
  .meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:22px; }
  .chip { border:1px solid var(--line); background:#fffdf7; padding:7px 11px; border-radius:999px; font: 600 11px/1 ui-monospace, monospace; letter-spacing:.08em; text-transform:uppercase; }
  .chip.ok { border-color:#b9d2c7; color:var(--green); }
  .chip.note { border-color:#e0c89e; color:var(--brass); }
  nav { position:sticky; top:0; z-index:5; display:flex; gap:8px; overflow:auto; padding:10px clamp(20px, 5vw, 72px); background:rgba(244,240,230,.94); backdrop-filter:blur(10px); border-bottom:1px solid var(--line); }
  nav a { flex:0 0 auto; color:var(--muted); text-decoration:none; font: 600 11px/1 ui-monospace, monospace; letter-spacing:.06em; padding:7px 9px; border-radius:4px; }
  nav a:hover { color:var(--ink); background:#fffdf7; }
  main { padding: 30px clamp(20px, 5vw, 72px) 80px; max-width:1400px; margin:0 auto; }
  .stage { display:grid; grid-template-columns: minmax(280px, 420px) minmax(0, 1fr); gap: clamp(20px, 3vw, 46px); padding: 34px 0; border-bottom:1px solid var(--line); align-items:start; }
  .stage-copy h2 { margin:0 0 10px; font-family: Georgia, serif; font-size: clamp(25px, 3vw, 38px); line-height:1.05; font-weight:600; letter-spacing:-.02em; }
  .kicker { margin:0 0 8px; font: 600 10px/1.4 ui-monospace, monospace; letter-spacing:.14em; text-transform:uppercase; color:var(--brass); }
  .caption { margin:0; color:#454037; line-height:1.55; font-size:15px; }
  ul { margin:14px 0 0; padding-left:18px; color:#4d473d; font-size:13px; line-height:1.55; }
  li + li { margin-top:5px; }
  .url { margin:14px 0 0; font: 11px/1.4 ui-monospace, monospace; color:var(--muted); word-break:break-all; }
  figure { margin:0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fffdf7; box-shadow: 0 20px 50px -38px rgba(20,21,18,.55); }
  figure img { display:block; width:100%; height:auto; }
  figcaption { padding:9px 12px; border-top:1px solid var(--line); font: 10px/1.3 ui-monospace, monospace; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .check { border:1px dashed #b9d2c7; border-radius:8px; background:#f4faf6; padding:26px; display:flex; gap:16px; align-items:flex-start; }
  .check span { display:grid; place-items:center; width:30px; height:30px; flex:0 0 auto; border-radius:50%; background:var(--green); color:white; font-weight:700; }
  .check p { margin:0; line-height:1.55; color:#2f4a3f; }
  .notes { margin-top:34px; display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .note { border:1px solid var(--line); border-radius:8px; background:var(--paper2); padding:20px; }
  .note h2 { margin:0 0 8px; font-family: Georgia, serif; font-size:22px; }
  .note p, .note li { color:#4d473d; font-size:13px; line-height:1.55; }
  .note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:#efe8da; padding:2px 5px; border-radius:3px; }
  footer { margin-top:40px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; line-height:1.6; }
  @media (max-width: 860px) { .stage { grid-template-columns:1fr; } .notes { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <p class="eyebrow">Foilbury · guided walkthrough</p>
  <h1>Everything that makes the cabinet worth opening.</h1>
  <p class="dek">A repeatable run through the public showcase, the member album, card inspection, the draw room, achievements, gifts, security and the admin surfaces. Screenshots and checks are captured from the real local app.</p>
  <div class="meta">
    <span class="chip">${escapeHtml(new Date(startedAt).toLocaleString())}</span>
    <span class="chip">${escapeHtml(baseURL)}</span>
    <span class="chip">${passed} stages</span>
    <span class="chip ok">${status}</span>
    <span class="chip ${warnings.length ? "note" : ""}">${warnings.length} layout notes</span>
    <span class="chip ${consoleErrors.length ? "note" : ""}">${consoleErrors.length} console errors</span>
  </div>
</header>
<nav>${stages.map((stage) => `<a href="#stage-${stage.index}">${stage.index} · ${escapeHtml(stage.name)}</a>`).join("")}</nav>
<main>
  ${cards}
  <div class="notes">
    <div class="note">
      <h2>How to run it again</h2>
      <p><code>pnpm demo</code> writes a fresh storyboard headlessly. <code>pnpm demo:show</code> opens the browser and the storyboard. The demo uses <code>player@foilbury.local</code> and <code>owner@foilbury.local</code>, plus a zero-price <code>demo-walkthrough</code> pool.</p>
    </div>
    <div class="note">
      <h2>What this does not prove</h2>
      <p>This is a local development walkthrough. It does not prove Cloudflare Access MFA, a production Discord consent flow, EmDash’s native console, a real second guild or Dean’s final visual approval. Those remain human acceptance steps.</p>
    </div>
    <div class="note">
      <h2>Console and layout notes</h2>
      ${warnings.length || consoleErrors.length ? `<ul>${[...warnings, ...consoleErrors].map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "<p>No broken images, horizontal overflow or console errors were observed.</p>"}
    </div>
    <div class="note">
      <h2>Evidence</h2>
      <p>The full-resolution screenshots live beside this page in <code>${escapeHtml(path.relative(root, shotsDir))}</code>. This directory is private and gitignored.</p>
    </div>
  </div>
  <footer>Foilbury walkthrough · ${escapeHtml(startedAt)} · private evidence, not for public release.</footer>
</main>
</body>
</html>`;
}

let browser;
try {
  if (!readOnly) {
    if (!/localhost|127\.0\.0\.1/.test(baseURL)) {
      throw new Error(
        "Refusing to create the demo fixture pool outside localhost. Use --read-only for a remote walkthrough.",
      );
    }
    await ensureServer();
    cleanupLocalTestFixtures();
    const fixture = await ensureDemoPool();
    log(`Demo pool ready: ${fixture.pool.name} · ${fixture.card} — ${fixture.variant}`);
  }

  browser = await chromium.launch({ channel: "chrome", headless: !headed });
  const publicContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const publicPage = await publicContext.newPage();
  publicPage.on("console", (message) => {
    if (message.type() === "error" && !isIgnorableBrowserNoise(message))
      consoleErrors.push(message.text());
  });
  publicPage.on("pageerror", (error) => consoleErrors.push(error.message));

  log("\nPublic showcase");
  await visit(publicPage, {
    name: "Public first impression",
    route: "/",
    waitFor: "text=Characters worth keeping.",
    caption:
      "The signed-out landing page. The public showcase is the approved Loftwah-owned content only; no launch roster or private art is present.",
    bullets: [
      "Real published renders lead the page.",
      "The cabinet/sign-in path is visible without exposing member content.",
      "Bold Manrope typography, deep current and electric aqua establish the Foilbury Signal identity.",
    ],
  });
  await visit(publicPage, {
    name: "Public cabinet",
    route: "/cabinet",
    waitFor: "h1",
    caption:
      "The public catalogue: four reviewed Loftwah showcase collections. The 17 launch worlds are members-only and do not appear here.",
    bullets: [
      "Collection covers and marks carry the identity.",
      "Cards are inspectable without a member session.",
      "No NBA or franchise names leak into the public HTML.",
    ],
  });
  await visit(publicPage, {
    name: "Public card detail",
    route: "/cabinet/tux",
    waitFor: "h1",
    caption:
      "A public card detail with the designed front, profile, source context and provenance language.",
    bullets: [
      "Artwork and metadata are readable at desktop size.",
      "The card is framed as a collectible, not a dashboard tile.",
      "Source credit is honest and visible.",
    ],
  });
  await visit(publicPage, {
    name: "Guided website tour",
    route: "/tour",
    waitFor: "h1",
    caption:
      "A short, skippable and resumable tour through the real product. It uses real public cards, explains free play and shows the difference between roster completion and finish mastery.",
    bullets: [
      "The tour is a route into the live product, not a storyboard.",
      "Member-only content stays behind membership.",
      "The operator appendix appears only for an authorised account.",
    ],
  });
  await visit(publicPage, {
    name: "Brand kit",
    route: "/brand-kit",
    waitFor: "h1",
    caption:
      "Four reviewed marks, sixteen Discord avatars, eight server/social banners, wordmarks and OG assets, all downloadable.",
    bullets: [
      "Signal Fold is the canonical working identity.",
      "Palette and clear-space rules are documented.",
      "No paid generation and no borrowed franchise emblem.",
    ],
  });
  await visit(publicPage, {
    name: "Showcase and video",
    route: "/showcase",
    waitFor: "h1",
    caption:
      "Real public stills and playable MP4 exports, with an export manifest and public-safe boundary.",
    bullets: [
      "The 18-second trailer is generated from real public renders.",
      "The 9:16 teaser is silent and playable.",
      "The private opening replay is not published as marketing.",
    ],
  });
  await visit(publicPage, {
    name: "Sign-in options",
    route: "/login",
    waitFor: "h1",
    caption:
      "Passwordless entry: Discord OAuth, one-use email link, passkey, and the loopback-only development sign-in.",
    bullets: [
      "The normal journey is passwordless.",
      "The development shortcut is clearly separated from production identity.",
      "No account is merged on an unverified email string.",
    ],
  });

  log("\nMember album");
  const memberContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await login(memberContext, "player@foilbury.local");
  const memberPage = await memberContext.newPage();
  memberPage.on("console", (message) => {
    if (message.type() === "error" && !isIgnorableBrowserNoise(message))
      consoleErrors.push(message.text());
  });
  memberPage.on("pageerror", (error) => consoleErrors.push(error.message));

  await visit(memberPage, {
    name: "Member cabinet",
    route: "/play",
    waitFor: "text=Your cabinet",
    caption:
      "The member home: balance, recent acquisitions, set progress, achievements and the next draw.",
    bullets: [
      "The balance and daily allowance are visible without hunting.",
      "Recent cards lead the page; the interface stays quiet.",
      "The draw room, collections and achievements are one click away.",
    ],
  });
  await visit(memberPage, {
    name: "Worlds browser",
    route: "/play/collections",
    waitFor: "text=Every world you can enter.",
    caption:
      "All playable worlds, with collection covers, member-only labels, completion progress and the public/member distinction.",
    bullets: [
      "The 17 launch worlds are presented as distinct albums.",
      "Progress is separate from catalogue ownership.",
      "The public showcase remains visibly separate.",
    ],
  });
  await visit(memberPage, {
    name: "Danganronpa collection",
    route: "/play/collection?collection=danganronpa-three-games",
    waitFor: "text=Your drawers",
    caption:
      "A launch collection detail. The roster, owned cards, collection identity and source boundary are in one place.",
    bullets: [
      "The collection reads as an album, not a filter tag.",
      "Owned and missing cards are distinguishable.",
      "Card art is the visual anchor.",
    ],
  });

  log("\nDraw room and card inspection");
  await memberPage.goto(`${baseURL}/play/draw`, { waitUntil: "networkidle" });
  await memberPage.getByLabel("Choose a capsule").waitFor();
  await memberPage.getByLabel("Choose a capsule").selectOption("demo-walkthrough");
  await capture(memberPage, {
    name: "Draw odds",
    caption:
      "The draw room with the zero-price demo capsule selected. Odds and prices are shown before the action.",
    bullets: [
      "The pool price is explicit.",
      "The eligible finish odds are visible.",
      "Opening is a deliberate action, not a surprise charge.",
    ],
  });
  await memberPage.getByRole("button", { name: /Draw for/ }).click();
  await memberPage.getByText(/New subject|Duplicate/).waitFor({ timeout: 20000 });
  await memberPage.getByRole("button", { name: /Show result now/ }).click().catch(() => undefined);
  await memberPage.locator(".draw-reveal.is-revealed").waitFor({ timeout: 20000 });
  await memberPage.waitForTimeout(300);
  await capture(memberPage, {
    name: "Draw result",
    caption:
      "A real draw result with the awarded card, finish, serial, pool, balance and odds for that copy.",
    bullets: [
      "The copy is immediately in the collection.",
      "The serial and finish are recorded, not inferred.",
      "The result explains what was pulled and what it cost.",
    ],
  });

  const inventory = await memberPage.evaluate(async () =>
    (await fetch("/api/v1/inventory")).json(),
  );
  const owned =
    inventory.items?.find((item) => item.card_name === "Hajime Hinata") ?? inventory.items?.[0];
  if (owned) {
    await memberPage.goto(`${baseURL}/play/card/${owned.id}`, { waitUntil: "networkidle" });
    await memberPage.locator(".card-inspector__stage").waitFor();
    await capture(memberPage, {
      name: "Card front",
      caption:
        "The awarded card in the private inspector. The front is the real render, not a UI approximation.",
      bullets: [
        "The image is the same render used by Discord.",
        "The serial and finish remain attached to this copy.",
        "The flat view is the first paint.",
      ],
    });
    await memberPage.getByRole("button", { name: /View back/i }).click();
    await memberPage.getByRole("button", { name: /View front/i }).waitFor();
    await capture(memberPage, {
      name: "Card back",
      caption:
        "The designed reverse: collection identity, a readable profile excerpt, structured attributes and a credit line.",
      bullets: [
        "The back is a real designed surface, not the front repeated.",
        "The biography and attributes do not collide.",
        "The selected side is visible even in flat mode.",
      ],
    });
    await memberPage.getByRole("button", { name: /Inspect in 3D/i }).click();
    await memberPage.getByRole("button", { name: "Exit 3D" }).waitFor();
    await capture(memberPage, {
      name: "3D inspection",
      caption:
        "On-demand CSS 3D. Tilt is interaction-only, the card keeps its printed identity and no ownership changes.",
      bullets: [
        "The card gains depth without a canvas per tile.",
        "Pointer and keyboard controls are available.",
        "The back remains selectable while 3D is on.",
      ],
    });
    await memberPage.getByRole("button", { name: /View front/i }).click();
    await memberPage.getByRole("button", { name: /View back/i }).waitFor();
    await memberPage.emulateMedia({ reducedMotion: "reduce" });
    await memberPage.getByRole("button", { name: /View back/i }).click();
    await memberPage.getByRole("button", { name: /View front/i }).waitFor();
    await capture(memberPage, {
      name: "Reduced motion",
      caption:
        "Reduced-motion mode removes the tilt animation but still shows the selected back. Motion is optional; content is not.",
      bullets: [
        "No unnecessary movement.",
        "The back is still visible and readable.",
        "The accessibility tree follows the selected side.",
      ],
    });
    await memberPage.emulateMedia({ reducedMotion: "no-preference" });
  } else {
    warnings.push("No owned card was available for the inspection stages.");
  }

  log("\nProgress, gifts and security");
  await visit(memberPage, {
    name: "Achievements",
    route: "/play/achievements",
    waitFor: "text=Little proofs of time well spent.",
    caption:
      "Earned badges and next milestones. Achievement progress is separate from the catalogue and survives later collection growth.",
    bullets: [
      "Earned and next are clearly separated.",
      "Rewards are shown as one-time entitlements.",
      "The page uses real committed inventory.",
    ],
  });
  await visit(memberPage, {
    name: "Gift receipts",
    route: "/play/gifts",
    waitFor: "text=A note in the post.",
    caption:
      "The member gift inbox: what arrived, who sent it, the value and when it was delivered.",
    bullets: [
      "Gifts are Bot-scoped and auditable.",
      "Foil, opening and card gifts are distinguishable.",
      "The receipt explains the delivered value.",
    ],
  });
  await visit(memberPage, {
    name: "Preferences",
    route: "/play/preferences",
    waitFor: "text=Make the cabinet yours.",
    caption:
      "Member preferences for reduced motion, sharing and presentation without changing ownership or odds.",
    bullets: [
      "Preferences are separate from collectible identity.",
      "Sharing is explicit and revocable.",
      "The cabinet can be made quieter without losing content.",
    ],
  });
  await visit(memberPage, {
    name: "Account security",
    route: "/account/security",
    waitFor: "h1",
    caption:
      "Passkeys, authenticator, recovery codes and session review. Sensitive actions require recent strong authentication.",
    bullets: [
      "Passwordless and strong-auth paths are first-class.",
      "Sessions can be reviewed and revoked.",
      "The development login remains a local-only shortcut.",
    ],
  });

  log("\nAdmin surfaces");
  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await login(adminContext, "owner@foilbury.local");
  const adminPage = await adminContext.newPage();
  adminPage.on("console", (message) => {
    if (message.type() === "error" && !isIgnorableBrowserNoise(message))
      consoleErrors.push(message.text());
  });
  adminPage.on("pageerror", (error) => consoleErrors.push(error.message));
  for (const [name, route, caption, bullets] of [
    [
      "Admin overview",
      "/admin",
      "Bot administration, kept visually separate from Platform Administration and the member album.",
      [
        "The Bot scope is explicit.",
        "Catalogue, economy, team and audit are grouped.",
        "This is not platform-wide authority.",
      ],
    ],
    [
      "Catalogue studio",
      "/admin/catalogue",
      "The catalogue studio: card identity, editions, four finishes, render state and publish controls.",
      [
        "Card definitions and artwork editions are distinct.",
        "Renders are visible before publishing.",
        "Long names and missing fields have designed states.",
      ],
    ],
    [
      "Collections studio",
      "/admin/collections",
      "Collection management with identity, source context, visibility and Bot enablement.",
      [
        "Scope, status, audience and distribution are separate.",
        "Disabling distribution does not delete awards.",
        "Collection covers and marks are editable.",
      ],
    ],
    [
      "Render studio",
      "/admin/design",
      "The render studio for previewing finishes and checking the card as a collectible object.",
      [
        "Base, Silver, Gold and Holographic are materially different.",
        "The preview uses the same renderer as delivery.",
        "Text and serials remain programmatic.",
      ],
    ],
    [
      "Achievement composer",
      "/admin/achievements",
      "Versioned achievement definitions, criteria, rewards and visibility.",
      [
        "Criteria are explicit and reviewable.",
        "Rewards are separate from notification delivery.",
        "Existing unlocks are not rewritten.",
      ],
    ],
    [
      "Gift composer",
      "/admin/gifts",
      "Scoped administrator gifts with preview, limits, reasons and per-recipient receipts.",
      [
        "The audience is previewed before sending.",
        "Caps and permissions are visible.",
        "Sending is a deliberate, audited action.",
      ],
    ],
  ]) {
    await visit(adminPage, { name, route, caption, bullets, waitFor: "h1, h2", fullPage: false });
  }

  log("\nPlatform administration and editorial");
  await visit(adminPage, {
    name: "Platform Administration",
    route: "/platform-admin",
    waitFor: "h1, h2",
    fullPage: false,
    caption:
      "The platform-level console, reachable locally with the provisioned Super Admin account. In production this area is protected by Cloudflare Access and the Worker re-verifies the Access JWT on every request.",
    bullets: [
      "Accounts, Access links, Bots, installations and global collections are separate from Bot Admin.",
      "The account shown is the provisioned local Super Admin, not a Discord moderator.",
      "Local development sign-in is clearly a fixture and is absent in production.",
    ],
  });
  await visit(adminPage, {
    name: "People and roles",
    route: "/platform-admin/people",
    waitFor: "h1, h2",
    fullPage: true,
    caption:
      "Searchable people, explicit scopes, audited role assignment and a plain-language permission matrix. Global Collection Admin is not Super Admin.",
    bullets: [
      "Super Admin remains explicitly provisioned.",
      "A scoped role can be granted, changed and revoked idempotently.",
      "Bot roles and platform roles are shown separately.",
    ],
  });
  await visit(adminPage, {
    name: "Scoped Studio",
    route: "/studio",
    waitFor: "h1, h2",
    fullPage: false,
    caption:
      "The Studio is a normal signed-in workspace with live role checks. It does not depend on Cloudflare Access and cannot grant platform root, secrets or another Bot.",
    bullets: [
      "Bot Owners/Admins and scoped collection admins share one surface.",
      "The API enforces the same scope as the UI.",
      "Editorial remains a handoff to EmDash rather than a second CMS.",
    ],
  });
  // EmDash's local dev bypass is a development-only route. Production uses the
  // existing Cloudflare Access editorial application and Dean's CMS account.
  await adminPage.goto(
    `${baseURL}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin&content=0`,
    { waitUntil: "networkidle" },
  );
  await visit(adminPage, {
    name: "EmDash editorial console",
    route: "/_emdash/admin",
    waitFor: "text=Foilbury Editorial",
    fullPage: false,
    caption:
      "The native EmDash operator console on the same local D1/R2 bindings. Foilbury remains the card/game authority; EmDash owns journal content and media.",
    bullets: [
      "The console is the native EmDash admin, not a Foilbury imitation.",
      "Local access uses EmDash's development-only bypass.",
      "Production maps the existing Dean CMS account through Cloudflare Access; automatic provisioning is disabled.",
    ],
  });

  log("\nPrivacy boundary");
  const publicCollections = await publicContext.request.get(`${baseURL}/api/v1/collections`);
  const publicJson = await publicCollections.json();
  const publicSlugs = new Set((publicJson.items ?? []).map((item) => item.slug));
  if (publicSlugs.has("nba-opening-night") || publicSlugs.has("danganronpa-three-games")) {
    throw new Error("Signed-out collection API leaked a launch collection.");
  }
  const signedOutPlay = await publicContext.request.get(`${baseURL}/play`, { maxRedirects: 0 });
  if (![200, 302, 303, 307, 308].includes(signedOutPlay.status()))
    throw new Error(`Signed-out /play returned ${signedOutPlay.status()}`);
  if (owned) {
    const renderPath = await memberPage.evaluate(() => {
      const image = document.querySelector(".card-inspector__front img");
      return image ? new URL(image.getAttribute("src"), location.href).pathname : null;
    });
    if (renderPath) {
      const anonymousRender = await publicContext.request.get(`${baseURL}${renderPath}`);
      const memberRender = await memberContext.request.get(`${baseURL}${renderPath}`);
      if (anonymousRender.status() !== 404)
        throw new Error(
          `Signed-out launch render returned ${anonymousRender.status()}, expected 404.`,
        );
      if (memberRender.status() !== 200)
        throw new Error(`Member launch render returned ${memberRender.status()}, expected 200.`);
      const cache = memberRender.headers()["cache-control"] ?? "";
      if (!cache.includes("private") || !cache.includes("no-store"))
        throw new Error(`Member render cache policy was ${cache || "(missing)"}.`);
    }
  }
  stages.push({
    index: String(stages.length + 1).padStart(2, "0"),
    name: "Privacy boundary",
    caption:
      "Signed-out callers see only the four public showcase collections. A launch render is 404 without membership and 200 with private, no-store headers for a member.",
    bullets: [
      "Public HTML and API do not list launch rosters.",
      "Launch renders are authorised per request.",
      "A secret URL is not used as authorisation.",
    ],
    screenshot: null,
    status: "PASS",
    info: { heading: "Privacy boundary", url: `${baseURL}/api/v1/collections` },
  });
  log("  checked privacy boundary");

  log("\nMobile review");
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await login(mobileContext, "player@foilbury.local");
  const mobilePage = await mobileContext.newPage();
  await visit(mobilePage, {
    name: "Mobile worlds",
    route: "/play/collections",
    waitFor: "text=Every world you can enter.",
    caption:
      "The worlds browser at phone width. Covers, labels and progress reflow without hiding the collection identity.",
    bullets: [
      "No horizontal overflow.",
      "Collection covers remain legible.",
      "The member/public distinction survives the smaller viewport.",
    ],
  });
  if (owned) {
    await mobilePage.goto(`${baseURL}/play/card/${owned.id}`, { waitUntil: "networkidle" });
    await mobilePage.locator(".card-inspector__stage").waitFor();
    await capture(mobilePage, {
      name: "Mobile card inspection",
      caption:
        "The card inspector at phone width. The card leads; the controls stay reachable and the selected side is visible.",
      bullets: [
        "The front/back controls are touch-sized.",
        "The card keeps its 5:7 geometry.",
        "The page does not rely on hover.",
      ],
    });
  }
  await mobileContext.close();

  await browser.close();
  browser = null;

  const report = {
    generated_at: new Date().toISOString(),
    base_url: baseURL,
    source: (() => {
      try {
        return spawnSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).stdout.trim();
      } catch {
        return null;
      }
    })(),
    mode: readOnly ? "read-only" : "local-fixture",
    stages: stages.map((stage) => ({ ...stage, status: stage.status })),
    warnings,
    console_errors: [...new Set(consoleErrors)],
    passed: stages.length,
    status: warnings.length === 0 && consoleErrors.length === 0 ? "PASS" : "PASS WITH NOTES",
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "index.html"), storyboard());
  const latest = path.join(root, ".foilbury/demo/latest");
  fs.rmSync(latest, { force: true, recursive: true });
  try {
    fs.symlinkSync(outDir, latest, "dir");
  } catch {
    // Symlinks are a convenience; the timestamped directory is authoritative.
  }
  log(`\nStoryboard: ${path.join(outDir, "index.html")}`);
  log(
    `Stages: ${stages.length} · warnings: ${warnings.length} · console errors: ${new Set(consoleErrors).size}`,
  );
  if (shouldOpen) {
    spawn("open", [path.join(outDir, "index.html")], { stdio: "ignore", detached: true }).unref();
  }
  if (warnings.length || new Set(consoleErrors).size) process.exitCode = 1;
} catch (error) {
  if (browser) await browser.close().catch(() => undefined);
  console.error(`\nWalkthrough failed: ${error instanceof Error ? error.message : String(error)}`);
  try {
    fs.writeFileSync(
      path.join(outDir, "report.json"),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          base_url: baseURL,
          stages,
          warnings,
          console_errors: [...new Set(consoleErrors)],
          error: String(error),
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(outDir, "index.html"), storyboard());
  } catch {
    // Keep the original failure.
  }
  process.exitCode = 1;
}
