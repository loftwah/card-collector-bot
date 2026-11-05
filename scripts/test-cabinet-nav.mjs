#!/usr/bin/env node
// Local synthetic fixture only: never authenticate or mutate production.
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const base = process.env.FOILBURY_URL ?? "http://localhost:5173";
const target = new URL(base);
assert.ok(
  target.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(target.hostname) &&
    !target.username &&
    !target.password &&
    !target.search &&
    !target.hash &&
    target.pathname === "/",
  "Local fixture origin required",
);
const evidence = fs.mkdtempSync(
  path.join(fs.mkdirSync(".foilbury/tmp", { recursive: true }) || ".foilbury/tmp", "cabinet-nav-"),
);
const browser = await chromium.launch({ headless: true });
try {
  for (const [label, width, height, zoom, js] of [
    ["phone", 390, 844, 1, true],
    ["short", 320, 568, 1, true],
    ["desktop", 1440, 900, 1, true],
    ["zoom", 390, 844, 2, true],
    ["nojs", 320, 568, 1, false],
  ]) {
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width, height },
      javaScriptEnabled: js,
      reducedMotion: "reduce",
    });
    try {
      const login = await context.request.post("/api/v1/dev/login", {
        data: { email: "owner@foilbury.local" },
      });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/play");
      await page.getByRole("navigation", { name: "Cabinet sections" }).waitFor();
      if (zoom !== 1) await page.evaluate((z) => (document.body.style.zoom = String(z)), zoom);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.locator(".cabinet-nav").evaluate((nav) => {
        const b = nav.getBoundingClientRect();
        return {
          nav: { left: b.left, right: b.right },
          items: [...nav.querySelectorAll(":scope > a")].map((e) => {
            const r = e.getBoundingClientRect();
            return {
              label: e.textContent.trim(),
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          }),
          scroll: document.documentElement.scrollWidth,
          viewport: innerWidth,
        };
      });
      assert.equal(geometry.items.length, 5);
      if (geometry.scroll > geometry.viewport + 1)
        console.log(
          `NOTE ${label}: page-level overflow ${geometry.scroll}/${geometry.viewport}; nav tested independently`,
        );
      for (const item of geometry.items)
        assert.ok(
          item.left >= geometry.nav.left - 1 && item.right <= geometry.nav.right + 1,
          `${label}: clipped ${item.label}`,
        );
      const menu = page.locator(".cabinet-more__summary");
      await menu.focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".cabinet-more").evaluate((e) => e.open), true);
      const box = await page.locator(".cabinet-more__menu").boundingBox();
      assert.ok(
        box && box.x >= -1 && box.x + box.width <= width + 1,
        `${label}: menu outside viewport ${JSON.stringify(box)}`,
      );
      if (js) {
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".cabinet-more").evaluate((e) => e.open), false);
        assert.equal(await menu.evaluate((e) => document.activeElement === e), true);
      } else {
        await page.keyboard.press("Enter");
        assert.equal(await page.locator(".cabinet-more").evaluate((e) => e.open), false);
      }
      if (js) {
        const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((x) =>
          ["serious", "critical"].includes(x.impact),
        );
        assert.deepEqual(violations, []);
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(evidence, `${label}.png`), fullPage: true });
      await page
        .locator(".cabinet-nav")
        .screenshot({ path: path.join(evidence, `${label}-nav.png`) });
      console.log(`PASS ${label}: visible primary links, menu and focus`);
    } finally {
      await context.close();
    }
  }
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser.close();
}
