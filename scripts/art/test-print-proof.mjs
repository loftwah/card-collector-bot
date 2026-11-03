#!/usr/bin/env node
/**
 * Focused browser proof for the multi-print collecting slice.
 *
 *   node scripts/art/test-print-proof.mjs
 *
 * Local only. Logs in through the loopback development door, opens the newest
 * owned print, verifies the saved front and back renders, the print title and
 * the 5:7 card geometry at desktop and mobile sizes, then writes screenshots
 * under .foilbury/evidence/print-proof/.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { ensureServer } from "../lib/api.mjs";

const base = process.env.FOILBURY_URL ?? "http://localhost:5173";
const outDir = path.join(process.cwd(), ".foilbury/evidence/print-proof");
fs.mkdirSync(outDir, { recursive: true });
await ensureServer();

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const device of [
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ]) {
    const context = await browser.newContext({ viewport: device.viewport });
    const login = await context.request.post(`${base}/api/v1/dev/login`, {
      data: { email: "player@foilbury.local" },
    });
    if (!login.ok()) throw new Error(`Dev login failed (${login.status()}).`);
    const inventory = await (await context.request.get(`${base}/api/v1/inventory?search=Tux&limit=20`)).json();
    const item = inventory.items?.find((row) => row.edition_name?.includes("Rooftop Relay")) ?? inventory.items?.[0];
    if (!item) throw new Error("No owned Tux print found. Run the provisioning and draw steps first.");
    const page = await context.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${base}/play/card/${item.id}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(outDir, `${device.name}-front.png`), fullPage: true });
    const heading = await page.locator("h1").first().innerText();
    const subtitle = await page.locator("p.text-lg").first().innerText();
    const images = page.locator(".card-inspector__face img");
    const front = await images.nth(0).getAttribute("src");
    const back = await images.nth(1).getAttribute("src");
    const box = await page.locator(".card-inspector__face").first().boundingBox();
    await page.getByRole("button", { name: /View back/i }).click();
    await page.waitForTimeout(150);
    const flipped = await page.locator(".card-inspector__stage").getAttribute("data-flipped");
    if (flipped !== "true") throw new Error("Card inspector did not flip to the back face.");
    const decodedBack = await images.nth(1).evaluate((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    await page.screenshot({ path: path.join(outDir, `${device.name}-back.png`), fullPage: true });
    const ratio = box ? box.width / box.height : null;
    results.push({
      device: device.name,
      heading,
      subtitle,
      front,
      back,
      back_differs: front !== back,
      decoded_back: decodedBack,
      card_ratio: ratio ? Number(ratio.toFixed(3)) : null,
      console_errors: errors,
    });
    await context.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
const failed = results.some(
  (row) =>
    !row.front?.includes("/media/render/") ||
    !row.back?.includes("/media/back/") ||
    !row.back_differs ||
    !row.decoded_back?.width ||
    Math.abs((row.card_ratio ?? 0) - 5 / 7) > 0.02 ||
    row.console_errors.length > 0,
);
if (failed) process.exitCode = 1;
