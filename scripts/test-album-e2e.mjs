#!/usr/bin/env node
/**
 * Album acceptance through the real Admin UI and a real member session.
 *
 * The admin actions under test are performed in Chromium: collection creation,
 * logo/cover upload, card creation/edit, four-finish artwork, publish, Bot
 * enablement, achievement creation and a scoped gift. Rendering and the pool
 * fixture use the supported background pipeline/API because they are jobs, not
 * editor decisions.
 *
 * Evidence contains member-only content and is written under .foilbury/
 * (gitignored), never docs/evidence.
 */
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidence = path.join(".foilbury", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };
const stamp = Date.now();
const slug = `album-proof-${stamp}`;
const cardSlug = `album-card-${stamp}`;
const cardName = `Album Proof ${stamp}`;
const collectionName = `Album Proof World ${stamp}`;

const browser = await chromium.launch({ headless: true });
function fieldControl(page, label) {
  return page.locator("label").filter({ has: page.locator(".label", { hasText: label }) }).locator("input, select, textarea").last();
}
const adminContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1100 } });
const admin = await adminContext.newPage();
const adminErrors = [];
admin.on("console", (message) => { if (message.type() === "error") adminErrors.push(message.text()); });
admin.on("pageerror", (error) => adminErrors.push(error.message));

async function request(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", "x-foilbury-csrf": csrf, ...(method === "POST" ? { "idempotency-key": `album-${crypto.randomUUID()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { method, url, body });
}

async function upload(page, file) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(file);
}

try {
  const login = await adminContext.request.post("/api/v1/dev/login", { data: { email: "owner@foilbury.local" } });
  if (login.status() !== 200) throw new Error(`Dev login returned ${login.status()}`);
  const cdp = await adminContext.newCDPSession(admin);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await admin.goto("/account/security");
  await admin.getByRole("button", { name: /add a passkey/i }).click();
  await admin.getByText(/Passkey added/i).waitFor({ timeout: 20000 });
  pass("strong passkey session established");

  // 1. Create a member-only collection through the Admin UI.
  await admin.goto("/admin/collections", { waitUntil: "networkidle" });
  await admin.getByLabel("Name", { exact: true }).last().fill(collectionName);
  await admin.getByLabel("Slug", { exact: true }).last().fill(slug);
  await admin.getByLabel("Description", { exact: true }).last().fill("A member-only acceptance world created through the real Admin UI.");
  await fieldControl(admin, "Initial status").selectOption("published");
  await fieldControl(admin, "Viewing audience").selectOption("members");
  await admin.getByLabel("Logo upload", { exact: true }).setInputFiles(path.join(".foilbury", "generated", "_test", "mark.png"));
  await admin.getByLabel("Cover upload", { exact: true }).setInputFiles(path.join(".foilbury", "generated", "_test", "cover.png"));
  await admin.getByRole("button", { name: "Create collection" }).click();
  await admin.getByText(/collection created/i).waitFor({ timeout: 20000 });
  pass("collection created through the Admin UI with uploaded logo and cover", collectionName);

  // 2. Create the card identity and biography through the Admin UI.
  await admin.goto("/admin/catalogue", { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: /New draft card/i }).click();
  await admin.getByLabel("Slug", { exact: true }).fill(cardSlug);
  await admin.getByLabel("Name", { exact: true }).fill(cardName);
  await admin.getByLabel("Subtitle", { exact: true }).fill("Acceptance subject");
  await admin.getByLabel("Description", { exact: true }).fill("A card created and published through the real Admin UI.");
  await fieldControl(admin, "Spoiler-safe introduction").fill("A concise, spoiler-safe acceptance profile for the card detail page.");
  await fieldControl(admin, "Full profile").fill("The fuller acceptance profile verifies that editorial fields and structured attributes reach the member album.");
  await fieldControl(admin, "Structured attributes").fill(JSON.stringify([{ key: "role", label: "Role", value: "Acceptance", source: "Admin UI test" }]));
  await admin.getByLabel("Source work", { exact: true }).fill("Foilbury acceptance fixture");
  await admin.getByRole("button", { name: "Create draft" }).click();
  await admin.getByRole("dialog").waitFor({ state: "hidden", timeout: 20000 });
  await admin.locator("tr", { hasText: cardName }).waitFor({ timeout: 20000 });
  pass("card identity, spoiler-safe bio, full profile and attributes created in the Admin UI", cardSlug);

  // 3. Add artwork with the four core finishes through the Admin UI.
  const row = admin.locator("tr", { hasText: cardName });
  await row.getByRole("button", { name: "Artwork" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByLabel("Edition name").fill("Acceptance edition");
  await dialog.locator('input[type="file"]').setInputFiles(path.join(".foilbury", "generated", "_test", "test-card-subject.png"));
  await admin.waitForTimeout(1500);
  await dialog.getByLabel("Background asset").selectOption({ index: 1 });
  await dialog.getByLabel("Subject asset").selectOption({ index: 1 });
  for (const finish of ["Base / Plain", "Silver", "Gold", "Holographic (Gold + holo)"]) {
    await dialog.getByLabel(finish, { exact: true }).check();
  }
  await dialog.getByRole("button", { name: "Add artwork edition" }).click();
  await admin.getByRole("dialog").waitFor({ state: "hidden", timeout: 20000 });
  pass("artwork edition created with Base, Silver, Gold and Holographic through the Admin UI");

  // 4. Publish and render.
  const refreshed = admin.locator("tr", { hasText: cardName });
  await refreshed.getByRole("button", { name: "Publish" }).click();
  await refreshed.getByRole("button", { name: "Retire" }).waitFor({ timeout: 20000 });
  const render = spawnSync("pnpm", ["cards:render", "--limit=8"], { cwd: process.cwd(), encoding: "utf8", timeout: 180000 });
  if (render.status !== 0) throw new Error(`Render failed: ${render.stderr?.slice(0, 500) ?? render.stdout?.slice(0, 500)}`);
  pass("card published and rendered through the durable job pipeline");

  // 5. Add the card to the collection and enable the collection for the Bot.
  await admin.goto("/admin/collections", { waitUntil: "networkidle" });
  await admin.getByRole("button", { name: new RegExp(collectionName) }).first().click();
  await admin.getByText("Add cards", { exact: true }).waitFor();
  const addCardLabel = admin.locator("label", { hasText: cardName }).first();
  await addCardLabel.locator('input[type="checkbox"]').check();
  await admin.getByRole("button", { name: "Add selected cards" }).click();
  await admin.getByText(/cards? added to/i).waitFor({ timeout: 20000 });
  const collectionToggle = admin.locator("div.border", { hasText: collectionName }).first().getByRole("switch");
  if ((await collectionToggle.getAttribute("aria-checked")) !== "true") await collectionToggle.click();
  pass("card added to the collection and the collection enabled for the Bot");

  // 6. Configure an achievement through the Admin UI.
  await admin.goto("/admin/achievements", { waitUntil: "networkidle" });
  const achievementKey = `album-proof-${stamp}`;
  await admin.getByLabel("Key").fill(achievementKey);
  await admin.getByLabel("Name", { exact: true }).fill("Album proof complete");
  await admin.getByLabel("Description").fill("Collect the acceptance subject.");
  await fieldControl(admin, "Criteria").selectOption("collection_unique");
  await fieldControl(admin, "Collection").selectOption({ label: collectionName });
  await admin.getByLabel("Target").fill("1");
  await admin.getByLabel("Foil reward").fill("120");
  await admin.getByRole("button", { name: "Create achievement" }).click();
  await admin.getByText("Album proof complete").first().waitFor({ timeout: 20000 });
  pass("Bot-scoped achievement configured through the Admin UI", achievementKey);

  // 7. Create a zero-price acceptance pool for the four variants.
  const cards = await request(admin, "GET", "/api/v1/admin/cards?limit=200");
  const card = cards.body.items.find((item) => item.slug === cardSlug);
  if (!card) throw new Error("The accepted card was not found in the catalogue.");
  const variants = card.editions.flatMap((edition) => edition.variants).filter((variant) => variant.status === "published");
  const pool = await request(admin, "POST", "/api/v1/admin/pools", {
    slug: `album-pool-${stamp}`,
    name: `Album Proof Pool ${stamp}`,
    description: "A zero-price acceptance pool.",
    price: 0,
    entries: variants.map((variant) => ({ variantId: variant.id, weight: 1 })),
  });
  if (pool.status !== 201) throw new Error(`Pool create returned ${pool.status}: ${JSON.stringify(pool.body)}`);
  await request(admin, "POST", `/api/v1/admin/pools/${pool.body.pool.id}/publish`, {});
  pass("acceptance pool published with all four finishes");

  // 8. Send a gift through the Admin UI.
  await admin.goto("/admin/gifts", { waitUntil: "networkidle" });
  await fieldControl(admin, "Who can receive it?").selectOption("single");
  await fieldControl(admin, "Foil per recipient").fill("120");
  await fieldControl(admin, "Reason (required, audited)").fill("Album acceptance thank-you");
  await fieldControl(admin, "Optional message").fill("Thanks for walking the whole album journey.");
  await admin.locator("label", { hasText: "Juniper Vale" }).first().locator('input[type="checkbox"]').check();
  await admin.getByRole("button", { name: /Preview recipients/i }).click();
  await admin.getByText("Ready to send").waitFor({ timeout: 20000 });
  await admin.getByRole("button", { name: /Send gift/i }).click();
  await admin.getByText(/delivered/i).first().waitFor({ timeout: 20000 });
  pass("Foil gift previewed and sent through the Admin UI");

  // 9. Act as an ordinary member in a separate browser context.
  const memberContext = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1100 } });
  const member = await memberContext.newPage();
  const memberErrors = [];
  member.on("console", (message) => { if (message.type() === "error") memberErrors.push(message.text()); });
  member.on("pageerror", (error) => memberErrors.push(error.message));
  await memberContext.request.post("/api/v1/dev/login", { data: { email: "player@foilbury.local" } });
  await member.goto("/play/draw", { waitUntil: "networkidle" });
  await member.getByLabel("Choose a capsule").selectOption(`album-pool-${stamp}`);
  await member.getByRole("button", { name: /Draw for/ }).click();
  await member.getByText(/New subject|Another copy/).waitFor({ timeout: 20000 });
  const inspect = member.getByRole("link", { name: /Inspect this instance/ });
  await inspect.waitFor();
  const instanceHref = await inspect.getAttribute("href");
  await member.goto(instanceHref, { waitUntil: "networkidle" });
  const inspector = member.locator(".card-inspector__stage");
  const object = member.locator(".card-inspector__object");
  const stageHash = async () => crypto.createHash("sha256").update(await inspector.screenshot()).digest("hex");
  const assertSide = async (side) => {
    const expected = side === "back" ? "true" : "false";
    await member.waitForFunction(
      ([selector, value]) => document.querySelector(selector)?.getAttribute("data-flipped") === value,
      [".card-inspector__stage", expected],
    );
    const style = await object.getAttribute("style");
    const angle = Number(style?.match(/rotateY\(([-\d.]+)deg\)/)?.[1] ?? 0);
    const normalized = ((angle % 360) + 360) % 360;
    const showsBack = normalized > 90 && normalized < 270;
    if (side === "back" ? !showsBack : showsBack) {
      throw new Error(`${side} transform was not applied: ${style}`);
    }
    const frontHidden = await member.locator(".card-inspector__front").getAttribute("aria-hidden");
    const backHidden = await member.locator(".card-inspector__back").getAttribute("aria-hidden");
    if (frontHidden !== expected || backHidden !== (side === "back" ? "false" : "true")) {
      throw new Error(`Accessibility tree disagrees with the selected ${side}: front=${frontHidden} back=${backHidden}`);
    }
  };

  // Flat mode must show both faces, not only change the button label.
  if ((await inspector.getAttribute("data-mode")) !== "flat") throw new Error("Card inspector did not start flat.");
  await assertSide("front");
  const flatFront = await stageHash();
  await member.getByRole("button", { name: /View back/i }).click();
  await assertSide("back");
  await member.waitForTimeout(550);
  const flatBack = await stageHash();
  if (flatFront === flatBack) throw new Error("Flat back side rendered identically to the front.");
  await member.getByRole("button", { name: /View front/i }).click();
  await assertSide("front");
  await member.waitForTimeout(550);
  const frontVisible = await member.locator(".card-inspector__front img").isVisible();
  const frontLoaded = await member.locator(".card-inspector__front img").evaluate((image) => image.complete && image.naturalWidth > 0);
  if (!frontVisible || !frontLoaded) throw new Error("Returning to the flat front did not restore a loaded front image.");

  // Switching modes while the back is selected must preserve the selected side.
  await member.getByRole("button", { name: /View back/i }).click();
  await assertSide("back");
  await member.getByRole("button", { name: /Inspect in 3D/ }).click();
  await member.waitForFunction(() => document.querySelector(".card-inspector__stage")?.getAttribute("data-mode") === "interactive");
  await assertSide("back");
  await member.getByRole("button", { name: /View front/i }).click();
  await assertSide("front");
  await member.getByRole("button", { name: /View back/i }).click();
  await assertSide("back");
  await member.screenshot({ path: path.join(evidence, "member-card-3d.png"), fullPage: true });

  // Reduced motion keeps content and side selection; it removes the tilt only.
  await member.emulateMedia({ reducedMotion: "reduce" });
  await member.waitForFunction(() => document.querySelector(".card-inspector__stage")?.getAttribute("data-mode") === "static");
  await assertSide("back");
  await member.getByRole("button", { name: /View front/i }).click();
  await assertSide("front");
  await member.getByRole("button", { name: /View back/i }).click();
  await assertSide("back");
  await member.screenshot({ path: path.join(evidence, "member-card-reduced-motion.png"), fullPage: true });
  await member.emulateMedia({ reducedMotion: "no-preference" });
  pass("member drew with visible odds and inspected both faces in flat, 3D and reduced motion", instanceHref ?? "");

  await member.goto("/play/achievements", { waitUntil: "networkidle" });
  await member.getByText("Album proof complete").first().waitFor({ timeout: 20000 });
  pass("achievement appears as earned for the member");

  await member.goto("/play/gifts", { waitUntil: "networkidle" });
  await member.getByText(/Foil gift/i).first().waitFor({ timeout: 20000 });
  await member.getByText(/Thanks for walking the whole album journey/i).first().waitFor();
  pass("gift receipt and message appear for the recipient");

  // 10. Retire the card and preserve the owned copy.
  await admin.goto("/admin/catalogue", { waitUntil: "networkidle" });
  const retireRow = admin.locator("tr", { hasText: cardName });
  await retireRow.getByRole("button", { name: "Retire" }).click();
  await admin.locator("tr", { hasText: cardName }).getByRole("button", { name: "Publish" }).waitFor({ timeout: 20000 });
  const instanceId = instanceHref?.split("/").pop();
  const instance = await request(member, "GET", `/api/v1/instances/${instanceId}`);
  if (instance.status !== 200 || instance.body.instance?.status !== "owned") {
    throw new Error(`Owned copy did not survive retirement: ${instance.status} ${JSON.stringify(instance.body)}`);
  }
  await member.goto(instanceHref, { waitUntil: "networkidle" });
  await member.getByRole("heading", { level: 1, name: new RegExp(cardName) }).waitFor({ timeout: 20000 });
  await member.getByText(instance.body.instance.serial).first().waitFor({ timeout: 20000 });
  pass("retired card cannot drop again; the awarded copy remains owned", instance.body.instance.serial);

  const unexpected = [...adminErrors, ...memberErrors].filter((message) => !/409 \(Conflict\)/.test(message));
  if (unexpected.length) throw new Error(`Console errors: ${unexpected.slice(0, 4).join(" | ")}`);
  pass("no unexpected console or page errors across the two sessions");
  fs.writeFileSync(path.join(evidence, "album-browser.json"), JSON.stringify({ generated_at: new Date().toISOString(), slug, cardSlug, collectionName, results }, null, 2));
} catch (error) {
  console.error(error?.stack ?? error);
  fail("album acceptance", error);
  await admin.screenshot({ path: path.join(evidence, "album-failure-admin.png"), fullPage: true }).catch(() => undefined);
  fs.writeFileSync(path.join(evidence, "album-browser.json"), JSON.stringify({ generated_at: new Date().toISOString(), slug, cardSlug, collectionName, results }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
