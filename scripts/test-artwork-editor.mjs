#!/usr/bin/env node
/**
 * Artwork editor acceptance (local only).
 *
 * Exercises the real admin UI: create a draft card, open the artwork editor,
 * confirm a strong-auth gate, step up with the configured TOTP, save a
 * non-destructive composition, reload, and read the persisted value back.
 *
 * It never prints the TOTP secret or a code. The temporary fixture is removed
 * from the local D1 database at the end.
 *
 *   node scripts/test-artwork-editor.mjs
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const outDir = path.join(".foilbury", "evidence", "artwork-editor");
fs.mkdirSync(outDir, { recursive: true });
const slug = `quality-editor-${Date.now()}`;
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, status: condition ? "PASS" : "FAIL", detail });
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
  if (!condition) process.exitCode = 1;
}

function findDatabase() {
  const base = path.join(".wrangler", "state", "v3", "d1");
  for (const entry of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(entry));
    if (!file.endsWith(".sqlite") || file.endsWith("metadata.sqlite")) continue;
    try {
      const table = execFileSync(
        "sqlite3",
        [file, "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_totp_secrets';"],
        { encoding: "utf8" },
      ).trim();
      if (table) return file;
    } catch {
      // Not the application database.
    }
  }
  throw new Error("Local D1 database not found.");
}

function sql(db, statement) {
  return execFileSync("sqlite3", ["-json", db, statement], { encoding: "utf8" });
}

function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index >= 0) bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 30_000) + offset;
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const truncation = digest[digest.length - 1] & 0xf;
  const binary =
    ((digest[truncation] & 0x7f) << 24) |
    (digest[truncation + 1] << 16) |
    (digest[truncation + 2] << 8) |
    digest[truncation + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

async function decryptSecret(encrypted, sessionSecret) {
  const [iv, cipher] = encrypted.split(".");
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`foilbury-totp:${sessionSecret}`),
  );
  const key = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) },
    key,
    fromBase64url(cipher),
  );
  return new TextDecoder().decode(plain);
}

const env = Object.fromEntries(
  fs
    .readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const db = findDatabase();
const secretRow = JSON.parse(
  sql(
    db,
    "SELECT s.secret_enc FROM fb_totp_secrets s JOIN fb_users u ON u.id = s.user_id WHERE u.email = 'owner@foilbury.local';",
  ),
)[0];
if (!secretRow)
  throw new Error("Owner TOTP is not configured; cannot exercise the strong-auth recovery path.");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
const login = await context.request.post("/api/v1/dev/login", {
  data: { email: "owner@foilbury.local" },
});
check("owner session starts", login.status() === 200);
const me = await (await context.request.get("/api/v1/me")).json();
const csrf = me.csrf_token;
const create = await context.request.post("/api/v1/admin/cards", {
  headers: { "x-foilbury-csrf": csrf },
  data: {
    slug,
    name: "Artwork Editor Acceptance",
    description: "Temporary local fixture for the non-destructive artwork editor acceptance.",
    attributes: [],
  },
});
check("temporary draft card created", create.status() === 201, String(create.status()));

const page = await context.newPage();
const consoleErrors = [];
let expectingForbidden = false;
page.on("console", (message) => {
  if (message.type() === "error" && !(expectingForbidden && message.text().includes("403")))
    consoleErrors.push(message.text());
});
await page.goto("/admin/catalogue", { waitUntil: "networkidle" });
await page.getByLabel("Filter catalogue").fill(slug);
await page.waitForTimeout(250);
await page.getByRole("button", { name: "Artwork" }).first().click();
await page.getByRole("dialog").waitFor();
const subject = page.getByLabel("Subject asset");
const options = await subject
  .locator("option")
  .evaluateAll((items) => items.map((item) => item.value).filter(Boolean));
await subject.selectOption(options[0]);
await page.waitForTimeout(300);
const preview = page.locator('[role="dialog"] .layered-card');
check(
  "editor renders the selected artwork",
  await preview
    .locator(".layered-card__subject")
    .evaluate(
      (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
    ),
);
await page.getByLabel("Artwork zoom").fill("1.15");
await page.getByLabel("Artwork horizontal position").fill("5");
await page.getByLabel("Artwork vertical position").fill("-4");

expectingForbidden = true;
await page.getByRole("button", { name: /add artwork edition/i }).click();
const gate = page.getByRole("alert");
await gate.waitFor({ timeout: 10_000 });
check(
  "missing strong auth is explained inside the editor",
  /strong authentication|recent authentication/i.test(await gate.innerText()),
  (await gate.innerText()).slice(0, 180),
);
check(
  "step-up recovery link is present",
  (await gate.getByRole("link", { name: /verify with a passkey/i }).count()) === 1,
);
expectingForbidden = false;

const secret = await decryptSecret(secretRow.secret_enc, env.FOILBURY_SESSION_SECRET);
let verifyStatus = 0;
for (const clockOffset of [-1, 0, 1]) {
  const response = await context.request.post("/api/v1/security/totp/verify", {
    headers: { "x-foilbury-csrf": csrf },
    data: { code: totp(secret, clockOffset) },
  });
  verifyStatus = response.status();
  if (verifyStatus === 200) break;
}
check("authenticator step-up succeeds", verifyStatus === 200, String(verifyStatus));

await page.getByRole("button", { name: /add artwork edition/i }).click();
await page.waitForTimeout(1800);
check("edition saves after step-up", (await page.getByRole("dialog").count()) === 0);

const cards = await (await context.request.get(`/api/v1/admin/cards?limit=500`)).json();
const card = cards.items?.find((item) => item.slug === slug);
const edition = card?.editions?.[0];
check("edition is attached to the card", Boolean(edition));
const composition = edition?.composition_json ? JSON.parse(edition.composition_json) : null;
check(
  "composition is persisted non-destructively",
  composition?.zoom === 1.15 && composition?.offsetX === 5 && composition?.offsetY === -4,
  JSON.stringify(composition),
);

await page.reload({ waitUntil: "networkidle" });
await page.getByLabel("Filter catalogue").fill(slug);
await page.waitForTimeout(250);
await page.getByRole("button", { name: "Edit" }).first().click();
await page.getByRole("dialog").waitFor();
check(
  "edit dialog states the missing-render state honestly",
  /no published render yet/i.test(await page.getByRole("dialog").innerText()),
);
await page.getByRole("button", { name: "Cancel" }).click();
check(
  "no console errors in the editor journey",
  consoleErrors.length === 0,
  consoleErrors.slice(0, 2).join(" | "),
);
await page.screenshot({ path: path.join(outDir, "editor-after-save.png") });
await context.close();
await browser.close();

/* Remove only the temporary fixture created by this run. */
if (!process.env.FOILBURY_KEEP_EDITOR_FIXTURE)
  sql(
    db,
    `DELETE FROM fb_variants WHERE card_id IN (SELECT id FROM fb_card_definitions WHERE slug = '${slug.replaceAll("'", "''")}');
DELETE FROM fb_artwork_editions WHERE card_id IN (SELECT id FROM fb_card_definitions WHERE slug = '${slug.replaceAll("'", "''")}');
DELETE FROM fb_card_definitions WHERE slug = '${slug.replaceAll("'", "''")}';`,
  );

const report = {
  generated_at: new Date().toISOString(),
  base_url: baseURL,
  fixture: slug,
  checks: results,
  console_errors: consoleErrors,
};
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(
  `\n${results.filter((item) => item.status === "PASS").length}/${results.length} checks passed`,
);
