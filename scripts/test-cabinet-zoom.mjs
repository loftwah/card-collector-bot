#!/usr/bin/env node
// Run only against a disposable, provider-free local fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const base = process.env.FOILBURY_URL ?? "http://127.0.0.1:5173";
const target = new URL(base);
assert.ok(
  target.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(target.hostname) &&
    !target.username &&
    !target.password &&
    target.pathname === "/" &&
    !target.search &&
    !target.hash,
);
assert.equal(process.env.CI, "true", "Use a disposable CI fixture");
const statusResponse = await fetch(new URL("/api/v1/status", target), {
  redirect: "error",
  signal: AbortSignal.timeout(10000),
});
assert.equal(statusResponse.ok, true);
const status = await statusResponse.json();
assert.equal(status.local, true);
assert.equal(status.dev_login, true);
assert.equal(status.configured, true);
assert.ok(
  status.providers && Object.values(status.providers).every((enabled) => enabled === false),
  "Providers must be disabled",
);
const evidence = fs.mkdtempSync(
  path.join(fs.mkdirSync(".foilbury/tmp", { recursive: true }) || ".foilbury/tmp", "cabinet-zoom-"),
);
const browser = await chromium.launch();
try {
  for (const [label, width, zoom, js, theme] of [
    ["320-zoom", 320, 2, true, "light"],
    ["390-zoom", 390, 2, true, "dark"],
    ["320-nojs", 320, 2, false, "light"],
    ["phone", 390, 1, true, "light"],
    ["desktop", 1440, 1, true, "light"],
  ]) {
    const context = await browser.newContext({
      baseURL: base,
      viewport: { width, height: 844 },
      javaScriptEnabled: js,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    try {
      assert.equal(
        (
          await context.request.post("/api/v1/dev/login", {
            data: { email: "owner@foilbury.local" },
          })
        ).status(),
        200,
      );
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/play");
      await page.evaluate((z) => {
        document.body.style.zoom = String(z);
      }, zoom);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(
        geometry.scroll <= geometry.viewport + 1,
        `${label}: page overflow ${JSON.stringify(geometry)}`,
      );
      for (const selector of [
        ".site-header__inner",
        ".cabinet-home .kpi-grid",
        ".cabinet-home__shortcuts",
      ]) {
        const escapes = await page
          .locator(selector)
          .first()
          .evaluate((container) => {
            const parent = container.getBoundingClientRect();
            return [...container.children]
              .filter((child) => child.getClientRects().length)
              .map((child) => child.getBoundingClientRect())
              .filter((r) => r.left < parent.left - 1 || r.right > parent.right + 1).length;
          });
        assert.equal(escapes, 0, `${label}: children escape ${selector}`);
      }
      const balanceLines = await page
        .locator(".cabinet-home [data-foil-balance]")
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        });
      assert.equal(balanceLines, 1, `${label}: balance should remain on one line`);
      const card = page.locator(".published-card").first();
      if (await card.count()) {
        const rect = await card.boundingBox();
        assert.ok(
          rect && Math.abs(rect.width / rect.height - 5 / 7) < 0.02,
          `${label}: card remains 5:7`,
        );
      }
      if (width < 768) {
        const summary = page.locator(".site-header summary");
        await summary.focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator(".site-header details").evaluate((element) => element.open),
          true,
        );
        const menu = await page.locator(".site-header__menu").boundingBox();
        assert.ok(
          menu && menu.x >= -1 && menu.x + menu.width <= width + 1,
          `${label}: menu outside viewport ${JSON.stringify(menu)}`,
        );
        assert.ok((await page.locator(".site-header__menu a:visible").count()) > 0);
        if (js) {
          await page.keyboard.press("Escape");
          assert.equal(
            await summary.evaluate((element) => document.activeElement === element),
            true,
          );
          const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
            ["serious", "critical"].includes(item.impact),
          );
          assert.deepEqual(violations, []);
        } else {
          await summary.focus();
          await page.keyboard.press("Enter");
          assert.equal(
            await page.locator(".site-header details").evaluate((element) => element.open),
            false,
          );
        }
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(evidence, `${label}.png`), fullPage: true });
      await page.screenshot({ path: path.join(evidence, `${label}-viewport.png`) });
      console.log(`PASS ${label}: no page overflow, menu and keyboard`);
    } finally {
      await context.close();
    }
  }
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser.close();
}
