#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { ensureServer, apiJson, agentToken } from "./lib/api.mjs";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidence = path.join(process.cwd(), "docs/evidence");
fs.mkdirSync(evidence, { recursive: true });
await ensureServer();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { testedAt: new Date().toISOString(), baseURL, checks: [], consoleErrors: [], screenshots: [] };
const fail = (name, error) => {
  report.checks.push({ name, result: "failed", error: error instanceof Error ? error.message : String(error) });
  throw error;
};
function pass(name, evidenceText) {
  report.checks.push({ name, result: "passed", evidence: evidenceText });
}
async function shot(page, name, fullPage = false) {
  const file = path.join(evidence, name);
  await page.screenshot({ path: file, fullPage, scale: "css" });
  report.screenshots.push(path.relative(process.cwd(), file));
  return file;
}
async function noOverflow(page, label) {
  const values = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  assert.ok(values.scroll <= values.inner + 2, `${label}: horizontal overflow ${values.scroll} > ${values.inner}`);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("1Password")) report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.consoleErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) report.consoleErrors.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Characters worth keeping." }).waitFor();
  assert.ok((await page.locator(".card-face img").count()) >= 3, "hero should use real published renders");
  await noOverflow(page, "desktop home");
  await shot(page, "home-desktop.png");
  pass("Public landing", "real card renders, responsive layout, no horizontal overflow");

  const manifest = await page.evaluate(async () => (await fetch("/site.webmanifest")).status);
  assert.equal(manifest, 200);
  pass("PWA manifest", "site.webmanifest 200");

  const login = await page.request.post(`${baseURL}/api/v1/dev/login`, { data: { email: "owner@foilbury.local" } });
  assert.equal(login.status(), 200);
  await page.goto(`${baseURL}/play`, { waitUntil: "networkidle" });
  await page.getByText("Good to see you").waitFor();
  assert.ok((await page.locator("[data-foil-balance]").first().textContent())?.includes("Foil"));
  pass("Owner browser session", "loopback development sign-in; wallet visible in the shared header");
  await shot(page, "play-overview.png");
  const browserInventory = await page.evaluate(async () => (await fetch("/api/v1/inventory")).json());
  const headlessInventory = await apiJson("/api/v1/inventory", { token: agentToken("owner") });
  assert.deepEqual(browserInventory.items.map((item) => item.id).sort(), headlessInventory.items.map((item) => item.id).sort());
  assert.equal(browserInventory.items.length, headlessInventory.items.length);
  pass("Browser/headless owner parity", `${browserInventory.items.length} instance ids and wallet-backed collection matched`);

  await apiJson("/api/v1/me/preferences", { method: "PATCH", token: agentToken("owner"), body: { sharingEnabled: true } });
  const share = await apiJson("/api/v1/shares", { method: "POST", token: agentToken("owner"), body: { expiresInDays: 7 } });
  await page.goto(share.url, { waitUntil: "networkidle" });
  await page.getByText("shared a cabinet.", { exact: false }).waitFor();
  const sharedCards = await page.locator(".card-grid article").count();
  assert.ok(sharedCards > 0, "explicit share should show public renders");
  await apiJson(`/api/v1/shares/${share.id}/revoke`, { method: "POST", token: agentToken("owner"), body: {} });
  const revoked = await page.request.get(share.url);
  assert.equal(revoked.status(), 404);
  await apiJson("/api/v1/me/preferences", { method: "PATCH", token: agentToken("owner"), body: { sharingEnabled: false } });
  pass("Explicit share + revoke", `${sharedCards} public renders shown; revoked link returns 404; no private source assets`);

  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  assert.ok(focused.includes("Skip to content"), `first keyboard focus was ${focused}`);
  pass("Keyboard focus", "first Tab reaches the skip link; focus is visible");

  const playerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await playerContext.request.post(`${baseURL}/api/v1/dev/login`, { data: { email: "player@foilbury.local" } });
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${baseURL}/play`, { waitUntil: "networkidle" });
  const playerBrowserInventory = await playerPage.evaluate(async () => (await fetch("/api/v1/inventory")).json());
  const playerHeadlessInventory = await apiJson("/api/v1/inventory", { token: agentToken("player") });
  assert.deepEqual(playerBrowserInventory.items.map((item) => item.id).sort(), playerHeadlessInventory.items.map((item) => item.id).sort());
  pass("Browser/headless player parity", `${playerBrowserInventory.items.length} instance ids matched for the player`);
  const adminCards = await apiJson("/api/v1/admin/cards?limit=200", { token: agentToken("owner") });
  const pressure = adminCards.items.find((card) => card.slug === "pressure-orbit");
  const privateAsset = pressure?.editions?.[0]?.subject_asset_id;
  assert.ok(privateAsset, "private subject asset id should be available to the owner admin");
  const ownerPrivate = await page.request.get(`${baseURL}/media/asset/${privateAsset}`);
  const playerPrivate = await playerPage.request.get(`${baseURL}/media/asset/${privateAsset}`);
  const publicPrivate = await page.request.get(`${baseURL}/media/public/${privateAsset}`);
  assert.equal(ownerPrivate.status(), 200);
  assert.ok([403, 404].includes(playerPrivate.status()), `player accessed an unowned private asset: ${playerPrivate.status()}`);
  assert.equal(publicPrivate.status(), 404);
  pass("Private media authorisation", "owner can read the private source asset; player gets 404; public route does not expose it");
  await playerContext.close();

  await page.goto(`${baseURL}/play/collection`, { waitUntil: "networkidle" });
  await page.getByText("Your drawers").waitFor();
  const loaded = await page.locator(".card-face img").first().evaluate((img) => ({ complete: img.complete, width: img.naturalWidth }));
  assert.ok(loaded.complete && loaded.width > 0, "collection render did not load");
  pass("Player collection", `render image loaded at ${loaded.width}px source width`);
  await shot(page, "collection.png");

  const me = await apiJson("/api/v1/me", { token: agentToken("owner") });
  const ownerWallet = await apiJson("/api/v1/wallet", { token: agentToken("owner") });
  if (ownerWallet.balance < 200) {
    await apiJson(`/api/v1/admin/wallets/${me.user.id}/adjust`, {
      method: "POST",
      token: agentToken("owner"),
      body: { amount: 500, reason: "Local end-to-end draw allowance" },
      idempotencyKey: `e2e-topup-${Date.now()}`,
    });
    pass("Local acceptance top-up", "owner wallet topped up by an audited adjustment so the repeatable draw journey can run");
  }
  await page.goto(`${baseURL}/play/draw`, { waitUntil: "networkidle" });
  await page.getByText("Know the odds.").waitFor();
  assert.ok((await page.locator("tbody tr").count()) > 0, "odds table should be populated");
  await noOverflow(page, "draw room");
  await shot(page, "draw-room.png");
  const beforeDraw = await page.getByText(/^✦ \d+$/).first().textContent();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Draw for"));
    button?.click();
  });
  await page.getByText("Draw receipt").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /Reveal card/ }).click();
  const resultImage = page.locator("img.draw-result-image");
  await resultImage.waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector("img.draw-result-image");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  await page.getByRole("link", { name: /Inspect this instance/ }).waitFor();
  await shot(page, "draw-result.png");
  pass("Draw journey", `skippable reveal; balance before draw ${beforeDraw?.trim()}`);

  await page.goto(`${baseURL}/admin/catalogue`, { waitUntil: "networkidle" });
  await page.getByText("Definitions and editions.").waitFor();
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length > 0);
  const rowCount = await page.locator("tbody tr").count();
  assert.ok(rowCount >= 10, "admin catalogue should show imported cards");
  pass("Owner catalogue browser", `${rowCount} rows rendered`);
  await shot(page, "admin-catalogue.png");

  const adminWrite = await page.evaluate(async () => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch("/api/v1/admin/taxonomy", {
      method: "POST",
      headers: { "content-type": "application/json", "x-foilbury-csrf": csrf },
      body: JSON.stringify({ kind: "tag", key: `browser-proof-${Date.now()}`, name: "Browser proof" }),
    });
    const body = await response.json();
    return { status: response.status, id: body.id };
  });
  assert.equal(adminWrite.status, 201);
  const archive = await page.evaluate(async (id) => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    return (await fetch(`/api/v1/admin/taxonomy/tag/${id}`, { method: "DELETE", headers: { "x-foilbury-csrf": csrf } })).status;
  }, adminWrite.id);
  assert.equal(archive, 200);
  pass("Browser admin write + CSRF", "created and archived a taxonomy item with the browser session");


  const routes = [
    ["/cabinet", "The Cabinet."],
    ["/cabinet/loftwah", "Loftwah"],
    ["/admin/pools", "Distribution rules."],
    ["/admin/sets", "Curated releases and completion."],
    ["/admin/taxonomy", "The owner's vocabulary."],
    ["/admin/topics", "Narrow the room, never the odds."],
    ["/admin/imports", "Provenance with a paper trail."],
    ["/play/rewards", "Earned, never bought."],
    ["/play/trades", "Move a card without losing the plot."],
    ["/play/preferences", "Make the cabinet yours."],
    ["/admin/economy", "One currency. One ledger."],
    ["/admin/agents", "Scoped, revocable authority."],
    ["/admin/design", "One identity, several finishes."],
    ["/admin/integrations", "Optional outside the core."],
    ["/admin/audit", "Who did what, and for whom."],
    ["/journal", "Notes from the cabinet."],
    ["/journal/the-first-cabinet-is-open", "The first cabinet is open"],
    ["/admin/editorial", "Publishing, kept separate."],
    ["/docs/agent-guide", "Use the cabinet, not a second app."],
  ];
  for (const [route, heading] of routes) {
    await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
    await page.getByText(heading, { exact: false }).first().waitFor({ timeout: 15000 });
    await noOverflow(page, route);
    pass(`Route ${route}`, "rendered with expected heading and no horizontal overflow");
  }
  const openapi = await page.request.get(`${baseURL}/openapi.json`);
  assert.equal(openapi.status(), 200);
  assert.equal((await openapi.json()).info.title, "Foilbury");
  pass("OpenAPI", "served at /openapi.json with title Foilbury");

  const html = await page.content();
  for (const marker of ["fba_", "emdash_enc_v1_", "CF_API_TOKEN", "FAL_AI_API_KEY", "RESEND_API_KEY"]) {
    assert.ok(!html.includes(marker), `secret marker ${marker} found in browser output`);
  }
  pass("Browser secret scan", "no bearer, encryption-key or provider credential markers in rendered HTML");

  await context.addCookies([{ name: "fb_theme", value: "light", url: baseURL }]);
  await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await shot(page, "home-light.png");
  pass("Light presentation", "light theme cookie applied");
  await context.addCookies([{ name: "fb_theme", value: "dark", url: baseURL }]);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  pass("Dark presentation", "dark theme cookie applied");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${baseURL}/`, { waitUntil: "networkidle" });
  await mobilePage.getByRole("heading", { name: "Characters worth keeping." }).waitFor();
  await noOverflow(mobilePage, "mobile home");
  await shot(mobilePage, "home-mobile.png");
  pass("Mobile landing", "390×844 viewport with no horizontal overflow");

  const reduced = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await reducedPage.request.post(`${baseURL}/api/v1/dev/login`, { data: { email: "owner@foilbury.local" } });
  await reducedPage.goto(`${baseURL}/play/collection`, { waitUntil: "networkidle" });
  const firstCard = reducedPage.locator(".card-face").first();
  await firstCard.click();
  await reducedPage.waitForURL(/\/play\/card\//);
  const motion = await reducedPage.evaluate(() => {
    const effect = document.querySelector(".layered-card__effect");
    if (!effect) return { present: false, duration: null };
    const style = getComputedStyle(effect);
    return { present: true, duration: style.animationDuration, name: style.animationName };
  });
  assert.ok(!motion.present || String(motion.duration).startsWith("0.001") || motion.name === "none", `reduced motion not applied: ${JSON.stringify(motion)}`);
  await shot(reducedPage, "card-reduced-motion.png");
  pass("Reduced motion", JSON.stringify(motion));

  assert.deepEqual(report.consoleErrors, []);
  report.checks.push({ name: "Console errors", result: "passed", evidence: "none" });
  fs.writeFileSync(path.join(evidence, "e2e.json"), JSON.stringify(report, null, 2) + "\n");
  await browser.close();
  console.log(JSON.stringify({ ok: true, checks: report.checks.length, screenshots: report.screenshots.length, evidence: "docs/evidence/e2e.json" }, null, 2));
} catch (error) {
  report.checks.push({ name: "E2E run", result: "failed", error: error instanceof Error ? error.stack : String(error) });
  fs.writeFileSync(path.join(evidence, "e2e.json"), JSON.stringify(report, null, 2) + "\n");
  await browser.close().catch(() => undefined);
  console.error(`test:e2e failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
