#!/usr/bin/env node
/**
 * Reproducible local performance readings for the repaired journeys.
 * It records browser timings, resource weight, long tasks and layout shift.
 * These are local numbers, not a production benchmark.
 *
 *   node scripts/measure-product-performance.mjs
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
const outDir = path.join(".foilbury", "evidence", "performance");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 900 },
  colorScheme: "light",
});
const login = await context.request.post("/api/v1/dev/login", {
  data: { email: "owner@foilbury.local" },
});
if (login.status() !== 200) throw new Error(`login ${login.status()}`);
const page = await context.newPage();

await page.addInitScript(() => {
  const state = { lcp: 0, cls: 0, longTasks: [] };
  window.__perf = state;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.lcp = Math.max(state.lcp, entry.startTime);
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) state.cls += entry.value || 0;
    }
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration >= 50)
        state.longTasks.push({
          start: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
        });
    }
  }).observe({ type: "longtask", buffered: true });
});

const routes = [
  "/play",
  "/play/collections",
  "/play/collection",
  "/play/draw",
  "/play/achievements",
  "/admin",
];
const report = {
  generated_at: new Date().toISOString(),
  base_url: baseURL,
  viewport: "1440x900",
  routes: [],
};

for (const route of routes) {
  const responseBytes = { document: 0, script: 0, image: 0, font: 0, other: 0 };
  const onResponse = async (response) => {
    try {
      const length = Number(response.headers()["content-length"] || 0);
      if (!length) return;
      const type = response.request().resourceType();
      if (type in responseBytes) responseBytes[type] += length;
      else responseBytes.other += length;
    } catch {
      // A closed response is not a reason to fail the measurement.
    }
  };
  page.on("response", onResponse);
  await page.goto(route, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const byType = { script: 0, style: 0, image: 0, font: 0, fetch: 0, other: 0 };
    let transfer = 0;
    for (const entry of resources) {
      transfer += entry.transferSize || 0;
      const type = entry.initiatorType;
      if (type in byType) byType[type] += entry.transferSize || 0;
      else byType.other += entry.transferSize || 0;
    }
    return {
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd || 0),
      load: Math.round(nav?.loadEventEnd || 0),
      ttfb: Math.round(nav?.responseStart || 0),
      resources: resources.length,
      transfer_bytes: transfer,
      by_type: byType,
      perf: window.__perf,
      document_bytes: document.documentElement.outerHTML.length,
      images: [...document.images].filter((image) => image.complete && image.naturalWidth > 0)
        .length,
    };
  });
  page.off("response", onResponse);
  const mediaBytes = responseBytes.image + responseBytes.font;
  report.routes.push({ route, ...result, response_bytes: responseBytes, media_bytes: mediaBytes });
  console.log(
    `${route}: ttfb=${result.ttfb}ms load=${result.load}ms LCP=${Math.round(result.perf.lcp)}ms CLS=${result.perf.cls.toFixed(4)} images=${(responseBytes.image / 1024).toFixed(0)}KB fonts=${(responseBytes.font / 1024).toFixed(0)}KB longTasks=${result.perf.longTasks.length}`,
  );
}

const inventory = await (await context.request.get("/api/v1/inventory?limit=1")).json();
if (inventory.items?.[0]) {
  const route = `/play/card/${inventory.items[0].id}`;
  await page.goto(route, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const result = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    return {
      resources: resources.length,
      transfer_bytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      perf: window.__perf,
    };
  });
  report.routes.push({ route: "/play/card/:id", ...result });
  console.log(
    `/play/card/:id: LCP=${Math.round(result.perf.lcp)}ms CLS=${result.perf.cls.toFixed(4)} transfer=${(result.transfer_bytes / 1024).toFixed(0)}KB`,
  );
}

await context.close();
await browser.close();
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nwrote ${path.join(outDir, "report.json")}`);
