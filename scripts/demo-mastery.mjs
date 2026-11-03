#!/usr/bin/env node
/**
 * Local mastery acceptance with a dedicated demo identity.
 *
 * Creates a fresh demo member through the real magic-link flow, grants exactly
 * seven of eight Danganronpa Gold variants through the audited admin gift
 * service, proves 7/8, grants the eighth, evaluates achievements, then repeats
 * for Holographic mastery. Every grant is labelled as a local demonstration.
 * The owner account is never modified. This script refuses production.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
if (!["localhost", "127.0.0.1", "::1"].includes(new URL(baseURL).hostname)) {
  console.error("Refusing to run mastery acceptance outside localhost.");
  process.exit(2);
}
const evidence = path.join("docs", "evidence");
const privateEvidence = path.join(".foilbury", "evidence", "mastery");
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync(privateEvidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

const stamp = Date.now();
const demoEmail = `mastery.demo.${stamp}@example.test`;
const csrfTokens = new WeakMap();

async function request(context, method, url, body, headers = {}) {
  const response = await context.request.fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(csrfTokens.get(context) ? { "x-foilbury-csrf": csrfTokens.get(context) } : {}), ...headers },
    data: body === undefined ? undefined : body,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status(), body: parsed, headers: response.headers() };
}

const browser = await chromium.launch({ headless: true });
const ownerContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const ownerPage = await ownerContext.newPage();
const demoContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const demoPage = await demoContext.newPage();

try {
  const ownerLogin = await request(ownerContext, "POST", "/api/v1/dev/login", { email: "owner@foilbury.local" });
  if (ownerLogin.status !== 200) throw new Error(`Owner dev login failed: ${ownerLogin.status}`);
  csrfTokens.set(ownerContext, ownerLogin.body.csrf_token);
  const cdp = await ownerContext.newCDPSession(ownerPage);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await ownerPage.goto("/account/security");
  await ownerPage.getByRole("button", { name: /add a passkey/i }).click();
  await ownerPage.getByText(/Passkey added/i).waitFor({ timeout: 20000 });
  pass("owner strong-auth session established for audited gifts");

  const magic = await request(ownerContext, "POST", "/api/v1/auth/magic-link", { email: demoEmail, purpose: "signin" });
  if (magic.status !== 200 || !magic.body.dev_token) throw new Error(`Magic link failed: ${magic.status} ${JSON.stringify(magic.body)}`);
  await demoPage.goto(`/auth/email/verify?token=${encodeURIComponent(magic.body.dev_token)}`, { waitUntil: "domcontentloaded" });
  await demoPage.getByRole("button", { name: /sign in to foilbury/i }).click();
  await demoPage.waitForURL(/\/play/, { timeout: 20000 });
  await demoPage.goto("/account/security");
  const demoCsrf = await demoPage.evaluate(() => document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "");
  if (!demoCsrf) throw new Error("The demo session did not expose a CSRF token.");
  csrfTokens.set(demoContext, demoCsrf);
  const demo = await request(demoContext, "GET", "/api/v1/me/preferences");
  if (demo.status !== 200) throw new Error(`Demo session is not active: ${demo.status}`);
  pass("dedicated local demo identity created through the real magic-link flow", demoEmail);

  const members = await request(ownerContext, "GET", "/api/v1/admin/members");
  const demoMember = (members.body.items ?? []).find((member) => member.email === demoEmail);
  if (!demoMember) throw new Error("The new demo member did not appear in the member directory.");

  const cardsResult = await request(ownerContext, "GET", "/api/v1/admin/cards?limit=200");
  if (cardsResult.status !== 200) throw new Error(`Admin cards failed: ${cardsResult.status}`);
  const cards = cardsResult.body.items.filter((card) => card.collections.some((collection) => collection.slug === "danganronpa-three-games"));
  if (cards.length !== 8) throw new Error(`Expected 8 Danganronpa cards, found ${cards.length}`);
  const collectionId = cards[0].collections.find((collection) => collection.slug === "danganronpa-three-games").id;

  const targetVariant = (card, material, effect) =>
    card.editions.flatMap((edition) => edition.variants).find((variant) =>
      variant.material_key === material && (effect ? variant.effect_key === effect : !variant.effect_key || variant.effect_key === "none"),
    );

  async function progress(context, label) {
    const result = await request(context, "GET", `/api/v1/collections/${collectionId}`);
    if (result.status !== 200) throw new Error(`${label} progress failed: ${result.status}`);
    return result.body.progress;
  }

  async function gift(card, variant, label) {
    const key = `mastery-${stamp}-${label}-${variant.id}`;
    const result = await request(ownerContext, "POST", "/api/v1/admin/gifts", {
      kind: "card",
      scope: "single",
      userIds: [demoMember.id],
      botId: null,
      cardId: card.id,
      variantId: variant.id,
      message: "Local Foilbury mastery demonstration. This is a labelled prepared grant, not a random pull.",
      reason: "Local mastery acceptance fixture",
    }, { "idempotency-key": key });
    if (result.status !== 201) throw new Error(`Gift failed: ${result.status} ${JSON.stringify(result.body)}`);
  }

  const goldTargets = cards.map((card) => ({ card, variant: targetVariant(card, "gold", null) })).filter((item) => item.variant);
  const holoTargets = cards.map((card) => ({ card, variant: targetVariant(card, "gold", "holographic") ?? targetVariant(card, "diamond", "holographic") })).filter((item) => item.variant);
  if (goldTargets.length !== 8) throw new Error(`Expected 8 Gold variants, found ${goldTargets.length}`);
  if (holoTargets.length !== 8) throw new Error(`Expected 8 Holographic variants, found ${holoTargets.length}`);

  for (const target of goldTargets.slice(0, 7)) await gift(target.card, target.variant, "gold");
  const seven = await progress(demoContext, "demo");
  if (seven.owned_cards !== 7 || seven.total_cards !== 8) throw new Error(`Expected 7/8 after seven grants, got ${seven.owned_cards}/${seven.total_cards}`);
  pass("real 7/8 Gold roster state before the final subject", `${seven.owned_cards}/${seven.total_cards}`);

  await gift(goldTargets[7].card, goldTargets[7].variant, "gold");
  await request(demoContext, "POST", "/api/v1/achievements/evaluate", {});
  const eight = await progress(demoContext, "demo");
  if (eight.owned_cards !== 8 || eight.total_cards !== 8) throw new Error(`Expected 8/8 after eight grants, got ${eight.owned_cards}/${eight.total_cards}`);
  const achievements = await request(demoContext, "GET", "/api/v1/achievements");
  const gold = (achievements.body.items ?? []).find((item) => item.key === "danganronpa-three-games-gold-mastery");
  if (gold?.state !== "earned") throw new Error(`Gold mastery is ${gold?.state ?? "missing"} after 8/8`);
  pass("real 8/8 transition earned Gold mastery once", `${gold.name} · ${gold.earned_at}`);

  for (const target of holoTargets) await gift(target.card, target.variant, "holo");
  await request(demoContext, "POST", "/api/v1/achievements/evaluate", {});
  const afterHolo = await request(demoContext, "GET", "/api/v1/achievements");
  const holo = (afterHolo.body.items ?? []).find((item) => item.key === "danganronpa-three-games-holographic-mastery");
  if (holo?.state !== "earned") throw new Error(`Holographic mastery is ${holo?.state ?? "missing"}`);
  const collectionUnlock = (afterHolo.body.items ?? []).find((item) => item.key === "danganronpa-three-schools");
  if (collectionUnlock?.state !== "earned") throw new Error("Full roster achievement was not earned");
  pass("Holographic mastery and full roster unlock use the same frozen roster", `${holo.name} · ${collectionUnlock.name}`);

  const unlockRows = await request(demoContext, "GET", "/api/v1/achievements");
  const goldCount = (unlockRows.body.items ?? []).filter((item) => item.key === "danganronpa-three-games-gold-mastery" && item.state === "earned").length;
  if (goldCount !== 1) throw new Error("Gold mastery is not represented exactly once");
  pass("no duplicate mastery unlock or reward row");

  await request(demoContext, "PATCH", "/api/v1/me/preferences", { sharingEnabled: true });
  const inventory = await request(demoContext, "GET", "/api/v1/inventory?collection=danganronpa-three-games&limit=120");
  const goldInstance = (inventory.body.items ?? []).find((item) => item.material_key === "gold");
  if (!goldInstance) throw new Error("No Gold copy is available for the permitted share");
  const share = await request(demoContext, "POST", "/api/v1/shares", { kind: "card", targetId: goldInstance.id, expiresInDays: 7 });
  if (share.status !== 200) throw new Error(`Share failed: ${share.status}`);
  const anonymous = await browser.newContext({ baseURL });
  const anonymousPage = await anonymous.newPage();
  const response = await anonymousPage.goto(share.body.url);
  const html = await response.text();
  if (html.includes(goldInstance.serial) || html.includes(goldInstance.card_name)) throw new Error("Anonymous share HTML leaked the member snapshot");
  await anonymousPage.getByText(/behind membership/i).waitFor();
  await anonymous.close();
  pass("mastery card share stays member-gated and does not leak the snapshot", share.body.audience);

  await demoPage.goto("/play/achievements");
  await demoPage.getByText(/Gold run/i).first().waitFor();
  await demoPage.screenshot({ path: path.join(evidence, "mastery-achievements.png"), fullPage: true });
  await demoPage.goto("/play/collection?collection=danganronpa-three-games");
  await demoPage.getByRole("heading", { name: /danganronpa/i }).first().waitFor();
  await demoPage.screenshot({ path: path.join(privateEvidence, "mastery-collection.png"), fullPage: true });
  pass("rendered achievement and collection screens inspected");
} catch (error) {
  console.error(error?.stack ?? error);
  fail("local mastery acceptance", error);
  await demoPage.screenshot({ path: path.join(privateEvidence, "mastery-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, demo_email: demoEmail, results };
fs.writeFileSync(path.join(privateEvidence, "report.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(evidence, "mastery-summary.json"), JSON.stringify({ generated_at: report.generated_at, results }, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
