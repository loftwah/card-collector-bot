import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("wishlist rows keep details, actions and saved card geometry usable on small screens", async (t) => {
  const root = process.cwd(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-wishlist-layout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  const source = fs.readFileSync(path.join(root, "src/pages/play/wishlist.astro"), "utf8");
  const getClass = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `missing page markup ${pattern}`);
    return match[1];
  };
  const rowClass = getClass(/<li class="([^"]+)"/),
    imageClass = getClass(/<img\s+class="([^"]+)"/),
    headingClass = getClass(/<h3 class="([^"]+)"/),
    pathClass = getClass(/<a\s+class="(badge [^"]+)"/);
  assert.match(source, /class="col-start-2 sm:col-start-auto"/);
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wishlist fixture</title></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    `@import "${path.join(root, "src/styles/global.css")}"; @source "${path.join(root, "src")}";`,
  );
  const component = `/@fs${path.join(root, "src/components/player/WishlistRemoveButton.tsx")}`;
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import React from 'react';import {createRoot} from 'react-dom/client';import Remove from ${JSON.stringify(component)};import './fixture.css';const name='A VERY LONG UNBROKEN '+ 'W'.repeat(42);createRoot(document.getElementById('root')).render(<main style={{padding:20}}><ul><li className={${JSON.stringify(rowClass)}}><figure className="m-0"><img className={${JSON.stringify(imageClass)}} src="/brand/card-back.webp" alt={name} width="750" height="1050"/></figure><div className="min-w-0"><h1 className={${JSON.stringify(headingClass)}}>{name}</h1><p>Wanted: Holographic</p><a className={${JSON.stringify(pathClass)}} href="/play/draw?pool=test-pool">${"W".repeat(55)} · ✦ 80</a><p>Availability can change.</p></div><div className="col-start-2 sm:col-start-auto"><Remove cardId="fixture-card" name={name}/></div></li></ul></main>);`,
  );
  const server = await createServer({
    root: dir,
    configFile: false,
    cacheDir: path.join(dir, ".vite"),
    publicDir: path.join(root, "public"),
    logLevel: "silent",
    plugins: [tailwindcss()],
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": path.join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, dir] } },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    colorScheme: "dark",
  });
  t.after(() => context.close());
  const page = await context.newPage();
  let attempts = 0;
  const bodies = [];
  await page.route("**/api/v1/wishlist", async (route) => {
    attempts++;
    bodies.push(route.request().postDataJSON());
    await route.fulfill(
      attempts === 1
        ? {
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Please try again." } }),
          }
        : { status: 200, contentType: "application/json", body: "{}" },
    );
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const image = page.locator("figure img"),
    heading = page.getByRole("heading"),
    link = page.getByRole("link"),
    remove = page.getByRole("button", { name: /Remove .* from wishlist/ });
  await remove.waitFor();
  for (const size of [
    { width: 320, height: 568 },
    { width: 375, height: 812 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    const dimensions = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.equal(dimensions.scroll, dimensions.client, `overflow at ${size.width}px`);
    const art = await image.boundingBox(),
      text = await heading.boundingBox(),
      target = await link.boundingBox(),
      action = await remove.boundingBox();
    assert.ok(art && text && target && action);
    assert.ok(Math.abs(art.width / art.height - 5 / 7) < 0.02);
    assert.ok(text.x >= art.x + art.width, `heading overlaps art at ${size.width}px`);
    assert.ok(
      target.height >= 44 && action.height >= 44,
      `touch target too short at ${size.width}px`,
    );
  }
  await page.setViewportSize({ width: 320, height: 568 });
  const axe = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  );
  await page.keyboard.press("Tab");
  assert.equal(await link.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press("Tab");
  assert.equal(await remove.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press("Enter");
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /Please try again/);
  assert.equal(await remove.isEnabled(), true);
  const retry = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/wishlist") && response.request().method() === "POST",
  );
  await remove.click();
  await retry;
  assert.equal(attempts, 2);
  assert.deepEqual(bodies, [
    { cardId: "fixture-card", wanted: false },
    { cardId: "fixture-card", wanted: false },
  ]);
});
