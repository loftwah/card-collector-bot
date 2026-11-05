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
      const links = page.locator(".cabinet-nav > a:visible");
      const expectedLinks = width <= 480 ? 3 : 5;
      assert.equal(await links.count(), expectedLinks);
      for (let i = 0; i < expectedLinks; i++) {
        const link = links.nth(i);
        await link.focus();
        const state = await link.evaluate((el) => {
          const item = el.getBoundingClientRect();
          const nav = el.closest("nav").getBoundingClientRect();
          return {
            focused: document.activeElement === el,
            left: item.left,
            right: item.right,
            navLeft: nav.left,
            navRight: nav.right,
            fontSize: parseFloat(getComputedStyle(el).fontSize),
            height: item.height,
          };
        });
        assert.ok(
          state.focused && state.left >= state.navLeft - 1 && state.right <= state.navRight + 1,
          `${label}: keyboard focus must reveal link ${i}: ${JSON.stringify(state)}`,
        );
        if (width <= 480 && zoom === 1)
          assert.ok(
            state.fontSize >= 14 && state.height >= 44,
            `${label}: readable touch target ${i}`,
          );
      }
      const menu = page.locator(".cabinet-more__summary");
      await menu.focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".cabinet-more").evaluate((e) => e.open), true);
      if (width <= 480) {
        await assert.equal(
          await page.locator(".cabinet-more__menu").getByRole("link", { name: "Worlds" }).count(),
          1,
        );
        await assert.equal(
          await page.locator(".cabinet-more__menu").getByRole("link", { name: "Rewards" }).count(),
          1,
        );
      }
      const box = await page.locator(".cabinet-more__menu").boundingBox();
      assert.ok(
        box && box.x >= -1 && box.x + box.width <= width + 1,
        `${label}: menu outside viewport ${JSON.stringify(box)}`,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await page
          .locator(".cabinet-more__menu a:visible")
          .first()
          .evaluate((e) => document.activeElement === e),
        true,
        `${label}: first menu link receives keyboard focus`,
      );
      if (js) {
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".cabinet-more").evaluate((e) => e.open), false);
        assert.equal(await menu.evaluate((e) => document.activeElement === e), true);
      } else {
        await menu.focus();
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
      if (label === "phone" || label === "nojs") {
        for (const [route, name] of [
          ["/play/collections", "Worlds"],
          ["/play/rewards", "Rewards"],
        ]) {
          await page.goto(route);
          const currentMenu = page.locator(".cabinet-more__summary");
          assert.match(
            await currentMenu.ariaSnapshot(),
            new RegExp(`More cabinet sections\\s*, current page: ${name}`),
            `${label}: current page announced`,
          );
          await currentMenu.focus();
          await page.keyboard.press("Enter");
          const destination = page.locator(".cabinet-more__menu").getByRole("link", { name });
          assert.equal(await destination.getAttribute("href"), route);
          assert.equal(await destination.getAttribute("aria-current"), "page");
        }
        await page.goto("/play");
      }
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
