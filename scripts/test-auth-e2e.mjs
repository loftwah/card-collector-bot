#!/usr/bin/env node
/**
 * Real Chromium acceptance for the passwordless account journey.
 *
 * Exercises: dev session bootstrap, virtual passkey registration, TOTP
 * confirmation, recovery-code step-up, session revocation, live magic-link
 * redemption/replay rejection, and passkey sign-in. It writes sanitised
 * screenshots only; no cookies, tokens or recovery codes are persisted.
 */
import { chromium } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const evidence = path.join("docs", "evidence");
fs.mkdirSync(evidence, { recursive: true });

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 127) << 24) | ((hmac[offset + 1] & 255) << 16) | ((hmac[offset + 2] & 255) << 8) | (hmac[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

const results = [];
function pass(name, detail = "") {
  results.push({ name, status: "PASS", detail });
  console.log(`PASS ${name}${detail ? ` · ${detail}` : ""}`);
}
function fail(name, error) {
  results.push({ name, status: "FAIL", detail: String(error?.message ?? error) });
  console.error(`FAIL ${name} · ${error?.message ?? error}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/v1/dev/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@foilbury.local" }) }));
  await page.goto("/account/security");
  await page.getByText("Fast, phishing-resistant sign-in.").waitFor();
  pass("dev account enters the security surface");

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.getByRole("button", { name: /add a passkey/i }).click();
  await page.getByText(/Passkey added/i).waitFor({ timeout: 20000 });
  pass("passkey registration and session upgrade");

  const passkeyCount = await page.locator("section", { hasText: "Passkeys" }).locator("text=Remove").count();
  if (passkeyCount < 1) throw new Error("The registered passkey is not listed");
  pass("passkey appears in account security");

  const authenticator = page.locator("section", { hasText: "Authenticator" });
  await authenticator.getByRole("button", { name: /set up authenticator/i }).click();
  const secret = (await authenticator.locator("code").first().textContent())?.trim() ?? "";
  if (!secret) throw new Error("TOTP secret was not displayed");
  const code = totp(secret);
  await authenticator.locator('input[autocomplete="one-time-code"]').fill(code);
  await authenticator.getByRole("button", { name: /^confirm$/i }).click();
  await page.getByText(/Authenticator configured/i).waitFor({ timeout: 15000 });
  pass("TOTP authenticator confirmation");

  const recoveryCodes = await page.locator("section", { hasText: "Authenticator" }).locator("code").allTextContents();
  const recovery = recoveryCodes.map((value) => value.trim()).find((value) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(value));
  if (!recovery) throw new Error("Recovery codes were not displayed once");
  const recoveryResult = await page.evaluate(async (recoveryCode) => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch("/api/v1/security/recovery/consume", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": csrf }, body: JSON.stringify({ code: recoveryCode }) });
    return { status: response.status, body: await response.text() };
  }, recovery);
  if (recoveryResult.status !== 200) throw new Error(`Recovery code step-up failed: ${recoveryResult.status} ${recoveryResult.body}`);
  await page.reload();
  await page.getByText(/Session assurance: mfa/i).waitFor({ timeout: 10000 });
  pass("single-use recovery code upgrades assurance to MFA");

  await page.screenshot({ path: path.join(evidence, "account-security.png"), fullPage: true });

  const revokeResponse = await page.evaluate(async () => {
    const csrf = document.querySelector('meta[name="foilbury-csrf"]')?.getAttribute("content") ?? "";
    const response = await fetch("/api/v1/security/sessions/revoke-others", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": csrf }, body: "{}" });
    return response.status;
  });
  if (revokeResponse !== 200) throw new Error(`Session revocation returned ${revokeResponse}`);
  pass("other sessions revoked");

  await page.goto("/logout");
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill("dean@deanlofts.xyz");
  const [magicResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/v1/auth/magic-link") && response.request().method() === "POST"),
    page.getByRole("button", { name: /email me a sign-in link/i }).click(),
  ]);
  const magicBody = await magicResponse.json();
  if (!magicBody.ok || !magicBody.dev_token) throw new Error("Magic-link request did not return a local test token");
  await page.goto(`/auth/email/verify?token=${encodeURIComponent(magicBody.dev_token)}`);
  await page.getByRole("button", { name: /sign in to foilbury/i }).click();
  await page.waitForURL(/\/play$/);
  pass("magic-link delivery accepted, link redeemed to /play");

  await page.goto(`/auth/email/verify?token=${encodeURIComponent(magicBody.dev_token)}`);
  await page.getByText(/invalid, used or expired/i).waitFor();
  pass("magic-link replay rejected");

  await page.goto("/logout");
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill("owner@foilbury.local");
  await page.getByRole("button", { name: /sign in with a passkey/i }).click();
  await page.waitForURL(/\/play$/, { timeout: 20000 });
  pass("passkey sign-in returns to the cabinet");

  if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
  pass("no browser console errors during the journey");
} catch (error) {
  fail("auth browser journey", error);
  await page.screenshot({ path: path.join(evidence, "account-security-failure.png"), fullPage: true }).catch(() => undefined);
} finally {
  await browser.close();
}

const report = { generated_at: new Date().toISOString(), base_url: baseURL, results };
fs.writeFileSync(path.join(evidence, "auth-browser.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
