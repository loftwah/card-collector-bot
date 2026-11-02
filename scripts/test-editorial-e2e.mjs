#!/usr/bin/env node
/**
 * Editorial/catalogue acceptance: draft card -> artwork edition -> render ->
 * publish -> authorised pool -> draw -> retire -> no further drops, while the
 * awarded instance remains owned.
 *
 * The browser session is a real passkey session. Rendering uses the durable
 * local render queue. The draw uses the same domain command as Discord.
 */
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidence = path.join("docs", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));

async function request(method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "x-foilbury-csrf": csrf, ...(method === "POST" ? { "idempotency-key": `editorial-${crypto.randomUUID()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { method, url, body });
}

try {
  const login = await context.request.post("/api/v1/dev/login", { data: { email: "owner@foilbury.local" } });
  if (login.status() !== 200) throw new Error(`Dev login returned ${login.status()}`);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto("/account/security");
  await page.getByRole("button", { name: /add a passkey/i }).click();
  await page.getByText(/Passkey added/i).waitFor({ timeout: 20000 });
  pass("strong passkey session established for editorial work");

  const stamp = Date.now();
  const draft = await request("POST", "/api/v1/admin/cards", {
    slug: `editorial-proof-${stamp}`,
    name: `Editorial Proof ${stamp}`,
    subtitle: "A test of the editorial pipeline",
    description: "A card created through the editorial path to prove draft, publish, draw and retire boundaries.",
    bio: "This identity exists to prove that the editorial controls and the playable catalogue are one system.",
    quote: "Keep the receipt.",
    categorySlug: "bubbles",
    rarityKey: "rare",
    tags: ["cabinet", "proof"],
  });
  if (draft.status !== 201) throw new Error(`Draft card create returned ${draft.status}: ${JSON.stringify(draft.body)}`);
  const cardId = draft.body.card.id;
  pass("draft card created with category, tags, bio and quote", cardId);

  const subjects = await request("GET", "/api/v1/admin/assets?kind=subject");
  const backgrounds = await request("GET", "/api/v1/admin/assets?kind=background");
  const subject = subjects.body.items?.[0];
  const background = backgrounds.body.items?.[0];
  if (!subject) throw new Error("No subject asset available for the proof card");
  const edition = await request("POST", `/api/v1/admin/cards/${cardId}/editions`, {
    name: "Proof edition",
    subjectAssetId: subject.id,
    backgroundAssetId: background?.id ?? null,
    materials: ["plain"],
    effects: ["none"],
    status: "published",
  });
  if (edition.status !== 201) throw new Error(`Edition create returned ${edition.status}: ${JSON.stringify(edition.body)}`);
  const variantId = edition.body.card.editions[0]?.variants?.[0]?.id;
  if (!variantId) throw new Error("No variant was created for the proof edition");
  pass("artwork edition and published variant attached", variantId);

  const render = spawnSync("pnpm", ["cards:render", "--limit=3"], { cwd: process.cwd(), encoding: "utf8", timeout: 120000 });
  if (render.status !== 0) throw new Error(`Render failed: ${render.stderr?.slice(0, 400) ?? render.stdout?.slice(0, 400)}`);
  const cards = await request("GET", "/api/v1/admin/cards?limit=200");
  const refreshed = cards.body.items.find((card) => card.id === cardId);
  const renderedVariant = refreshed?.editions.flatMap((item) => item.variants).find((variant) => variant.id === variantId);
  if (!renderedVariant?.render_url) throw new Error("The new variant still has no published render");
  pass("durable render queue produced the public card image");

  const published = await request("POST", `/api/v1/admin/cards/${cardId}/status`, { status: "published" });
  if (published.status !== 200) throw new Error(`Publish returned ${published.status}: ${JSON.stringify(published.body)}`);
  pass("card published to the playable catalogue");

  const pool = await request("POST", "/api/v1/admin/pools", {
    slug: `editorial-pool-${stamp}`,
    name: `Editorial Pool ${stamp}`,
    description: "A zero-price acceptance pool for the editorial proof card.",
    price: 0,
    entries: [{ variantId, weight: 1 }],
  });
  if (pool.status !== 201) throw new Error(`Pool create returned ${pool.status}: ${JSON.stringify(pool.body)}`);
  const poolId = pool.body.pool.id;
  const publishPool = await request("POST", `/api/v1/admin/pools/${poolId}/publish`, {});
  if (publishPool.status !== 200) throw new Error(`Pool publish returned ${publishPool.status}`);
  pass("authorised Bot pool includes the new card");

  const draw = await page.evaluate(async ({ slug }) => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch("/api/v1/draws", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-foilbury-csrf": csrf, "idempotency-key": `editorial-draw-${crypto.randomUUID()}` },
      body: JSON.stringify({ pool: slug, expectedRevision: 1 }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { slug: `editorial-pool-${stamp}` });
  if (draw.status !== 200) throw new Error(`Draw returned ${draw.status}: ${JSON.stringify(draw.body)}`);
  const instanceId = draw.body.instance_id;
  if (!instanceId) throw new Error("Draw did not return an instance");
  pass("draw through the shared command awarded the new card", instanceId);

  const retired = await request("POST", `/api/v1/admin/cards/${cardId}/status`, { status: "retired" });
  if (retired.status !== 200) throw new Error(`Retire returned ${retired.status}: ${JSON.stringify(retired.body)}`);
  const preview = await request("GET", `/api/v1/pools/editorial-pool-${stamp}`);
  if (preview.status !== 200 || preview.body.eligible_count !== 0) throw new Error(`Retired card still appears in pool: ${JSON.stringify(preview.body)}`);
  const secondDraw = await page.evaluate(async ({ slug }) => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch("/api/v1/draws", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-foilbury-csrf": csrf, "idempotency-key": `editorial-draw-blocked-${crypto.randomUUID()}` },
      body: JSON.stringify({ pool: slug, expectedRevision: 1 }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { slug: `editorial-pool-${stamp}` });
  if (secondDraw.status !== 409 || !["empty_pool", "pool_changed"].includes(secondDraw.body?.error?.code)) throw new Error(`Retired card was still drawable: ${secondDraw.status} ${JSON.stringify(secondDraw.body)}`);
  pass("retired card cannot drop again, and the attempt is not charged");

  const instance = await request("GET", `/api/v1/instances/${instanceId}`);
  if (instance.status !== 200 || instance.body.instance?.status !== "owned") throw new Error(`Previously awarded copy is no longer owned: ${JSON.stringify(instance.body)}`);
  pass("previously awarded copy remains owned after retirement", instance.body.instance.serial);

  await page.goto(`/play/card/${instanceId}`);
  await page.getByRole("heading", { level: 1, name: new RegExp(`Editorial Proof ${stamp}`) }).waitFor();
  await page.screenshot({ path: path.join(evidence, "editorial-proof-card.png"), fullPage: true });

  const unexpectedErrors = consoleErrors.filter((message) => !/409 \(Conflict\)/.test(message));
  if (unexpectedErrors.length) throw new Error(`Console errors: ${unexpectedErrors.slice(0, 3).join(" | ")}`);
  pass("owned card detail renders the editorial proof without console errors");
} catch (error) {
  console.error(error?.stack ?? error);
  fail("editorial catalogue acceptance", error);
  await page.screenshot({ path: path.join(evidence, "editorial-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, results };
fs.writeFileSync(path.join(evidence, "editorial-browser.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
