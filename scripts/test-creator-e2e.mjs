#!/usr/bin/env node
/**
 * Independent creator journey in real Chromium: magic-link account, passkey,
 * Bot creation, scoped team invitation and a denied Platform Administration
 * attempt. Uses only an ordinary account; no Super Admin session leaks in.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const stamp = Date.now();
const creatorEmail = `creator+${stamp}@example.com`;
const collaboratorEmail = `collaborator+${stamp}@example.com`;
const evidence = path.join("docs", "evidence");
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const pass = (name, detail = "") => { results.push({ name, status: "PASS", detail }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`); };
const fail = (name, error) => { results.push({ name, status: "FAIL", detail: String(error?.message ?? error) }); console.error(`FAIL ${name} · ${error?.message ?? error}`); };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto("/login");
  const link = await page.evaluate(async (email) => {
    const response = await fetch("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, redirectPath: "/play" }) });
    return response.json();
  }, creatorEmail);
  if (!link.dev_token) throw new Error("Local magic link token missing");
  await page.goto(`/auth/email/verify?token=${encodeURIComponent(link.dev_token)}`);
  await page.getByRole("button", { name: /sign in to foilbury/i }).click();
  await page.waitForURL(/\/play$/);
  pass("independent creator creates an account through a one-use email link");

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto("/account/security");
  await page.getByRole("button", { name: /add a passkey/i }).click();
  await page.getByText(/Passkey added/i).waitFor({ timeout: 20000 });
  pass("creator adds a passkey before creating a Bot");

  await page.goto("/create-bot");
  await page.getByRole("heading", { name: /open your own cabinet/i }).waitFor();
  await page.locator('input[placeholder="Late Night Cabinet"]').fill("Independent Cabinet");
  await page.locator('input[placeholder="late-night-cabinet"]').fill(`independent-${stamp}`);
  await page.locator("textarea").fill("A test cabinet owned by an ordinary creator account.");
  await page.getByRole("button", { name: /create bot/i }).click();
  await page.waitForURL(/\/admin$/, { timeout: 20000 });
  await page.getByText(/The cabinet office/i).waitFor();
  pass("creator creates and enters only their new Bot", "tenant switched after creation");

  await page.goto("/admin/team");
  await page.getByText(/Only the Bot you were given/i).waitFor();
  await page.locator('input[type="email"]').fill(collaboratorEmail);
  await page.getByRole("button", { name: /send invitation/i }).click();
  await page.getByText(new RegExp(`Invitation sent to ${collaboratorEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")).waitFor({ timeout: 15000 });
  await page.getByText(collaboratorEmail).first().waitFor();
  pass("Bot Owner sends a scoped invitation bound to the collaborator email");

  const platform = await page.goto("/platform-admin");
  const body = await platform.text();
  if (platform.status() !== 403 || !/Super Admin authority is not provisioned/i.test(body)) {
    throw new Error(`Platform administration was not denied: ${platform.status()}`);
  }
  pass("ordinary creator is denied Platform Administration");

  await page.goto("/admin/collections");
  await page.getByText(/Worlds with a front door/i).waitFor();
  await page.getByText(/Bubbles/i).first().waitFor({ timeout: 15000 });
  pass("creator sees global collections read-only and their own Bot scope");
  await page.screenshot({ path: path.join(evidence, "creator-collections.png"), fullPage: true });

  const unexpected = errors.filter((message) => !/403 \(Forbidden\)/.test(message));
  if (unexpected.length) throw new Error(`Console errors: ${unexpected.slice(0, 3).join(" | ")}`);
  pass("no browser console errors during the creator journey");
} catch (error) {
  fail("independent creator browser journey", error);
  await page.screenshot({ path: path.join(evidence, "creator-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, creator_email: creatorEmail, collaborator_email: collaboratorEmail, results };
fs.writeFileSync(path.join(evidence, "creator-browser.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
