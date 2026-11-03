#!/usr/bin/env node
/**
 * Renders real screens for visual review. Writes PNGs and a compact metric
 * report. No credentials are stored in the output.
 *
 *   node scripts/visual-baseline.mjs [outDir] [label]
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const outDir = process.argv[2] ?? path.join(".foilbury", "evidence", "visual-current");
const label = process.argv[3] ?? "current";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const report = { label, baseURL, capturedAt: new Date().toISOString(), screens: [] };

async function login(context, email = "owner@foilbury.local") {
  const response = await context.request.post("/api/v1/dev/login", { data: { email } });
  if (response.status() !== 200) throw new Error(`dev login ${response.status()}`);
}

async function capture(page, name, url, viewport, scheme, fullPage = true) {
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  const response = await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(350);
  const metrics = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const surfaces = [...document.querySelectorAll(".surface, .surface-flat, .card-rail, .panel")].slice(0, 12).map((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderColor };
    });
    return {
      title: document.title,
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      doc: { width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight },
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      surfaces,
      headings: [...document.querySelectorAll("h1,h2")].slice(0, 10).map((h) => ({ tag: h.tagName, text: h.textContent?.trim().slice(0, 90), size: getComputedStyle(h).fontSize })),
      images: [...document.images].slice(0, 60).map((img) => ({ src: img.currentSrc.slice(-70), natural: [img.naturalWidth, img.naturalHeight], box: [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)], complete: img.complete })),
    };
  });
  page.off("pageerror", onError);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  report.screens.push({ name, url, viewport, scheme, status: response?.status() ?? null, errors, ...metrics, file });
  console.log(`${name}: ${metrics.doc.width}x${metrics.doc.height} overflowX=${metrics.overflowX} errors=${errors.length}`);
}

try {
  for (const scheme of ["light", "dark"]) {
    const desktop = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await desktop.newPage();
    await capture(page, `public-home-${scheme}`, "/", { w: 1440, h: 900 }, scheme);
    await capture(page, `public-cabinet-${scheme}`, "/cabinet", { w: 1440, h: 900 }, scheme);
    await desktop.close();

    const authed = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
    await login(authed);
    const member = await authed.newPage();
    const routes = [
      ["play", "/play"],
      ["worlds", "/play/collections"],
      ["collection", "/play/collection"],
      ["draw", "/play/draw"],
      ["achievements", "/play/achievements"],
      ["profile", "/play/profile"],
      ["studio", "/studio"],
      ["admin", "/admin"],
    ];
    for (const [name, url] of routes) await capture(member, `${name}-${scheme}`, url, { w: 1440, h: 900 }, scheme);
    const instance = await member.evaluate(async () => {
      const response = await fetch("/api/v1/inventory?limit=1");
      return (await response.json()).items?.[0]?.id;
    });
    if (instance) await capture(member, `card-${scheme}`, `/play/card/${instance}`, { w: 1440, h: 900 }, scheme);
    await authed.close();

    const mobile = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await login(mobile);
    const phone = await mobile.newPage();
    await capture(phone, `play-mobile-${scheme}`, "/play", { w: 390, h: 844 }, scheme);
    await capture(phone, `worlds-mobile-${scheme}`, "/play/collections", { w: 390, h: 844 }, scheme);
    await mobile.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nwrote ${path.join(outDir, "report.json")}`);
