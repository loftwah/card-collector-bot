import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("trade dialog names each side from the viewer's perspective", async (t) => {
  const root = process.cwd(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-trade-perspective-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trade fixture</title></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    `@import "${path.join(root, "src/styles/global.css")}"; @source "${path.join(root, "src")}";`,
  );
  const component = `/@fs${path.join(root, "src/components/player/TradeDesk.tsx")}`;
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import React from 'react';import {createRoot} from 'react-dom/client';import TradeDesk from ${JSON.stringify(component)};import './fixture.css';const base={status:'open',revision:1,expires_at:'2026-11-10T00:00:00.000Z',updated_at:'2026-11-05T00:00:00.000Z',item_count:2};createRoot(document.getElementById('root')).render(<main><TradeDesk currentUserId="viewer" initialTrades={[{...base,id:'mine',proposer_id:'viewer',recipient_id:'other',proposer_name:'You',recipient_name:'Morgan'},{...base,id:'theirs',proposer_id:'other',recipient_id:'viewer',proposer_name:'Morgan',recipient_name:'You'},{...base,id:'observer',proposer_id:'a',recipient_id:'b',proposer_name:'A',recipient_name:'B'}]} inventory={[]} members={[]} initialGifts={[]}/></main>);`,
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
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type()==='error') browserErrors.push(message.text()); });
  const requested = [];
  await page.route("**/api/v1/trades/*", async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    assert.equal(route.request().method(), "GET");
    const id = route.request().url().split("/").pop(),
      mine = id === "mine",
      observer = id === "observer";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id,
        proposer_id: observer ? "a" : mine ? "viewer" : "other",
        recipient_id: observer ? "b" : mine ? "other" : "viewer",
        status: "open",
        revision: 1,
        expires_at: "2026-11-10T00:00:00.000Z",
        items: [
          {
            id: "p",
            side: "proposer",
            card_name: mine ? "My card" : "Their card",
            variant_name: "Plain",
            serial: "SERIAL-P",
          },
          {
            id: "r",
            side: "recipient",
            card_name: mine ? "Their card" : "My card",
            variant_name: "Silver",
            serial: "SERIAL-R",
          },
        ],
        acceptances: [],
      }),
    });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const view = (label) =>
    page.getByRole("article").filter({ hasText: label }).getByRole("button", { name: "View" });
  const proposer = view("You → Morgan");
  await proposer.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  try { await dialog.waitFor(); }
  catch (error) {
    const alerts=await page.locator('[role="alert"]').allTextContents();
    throw new Error(`Trade dialog did not open; requests=${JSON.stringify(requested)} alerts=${JSON.stringify(alerts)} browserErrors=${JSON.stringify(browserErrors)}`, {cause:error});
  }
  const group = (label) => dialog.getByText(label, { exact: true }).locator("..");
  assert.match(await group("You offer").innerText(), /My card.*SERIAL-P/s);
  assert.match(await group("They offer").innerText(), /Their card.*SERIAL-R/s);
  assert.equal(await dialog.getByRole("button", { name: "Cancel offer" }).count(), 1);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  );
  const evidenceRoot = path.join(root, '.foilbury/evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'trade-dialog-'));
  await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
  console.log('Private mocked evidence:', evidence);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.count(), 0);
  await page.waitForFunction((el) => document.activeElement === el, await proposer.elementHandle());
  await view("Morgan → You").click();
  await dialog.waitFor();
  assert.match(await group("They offer").innerText(), /Their card.*SERIAL-P/s);
  assert.match(await group("You offer").innerText(), /My card.*SERIAL-R/s);
  assert.equal(await dialog.getByRole("button", { name: "Decline" }).count(), 1);
  await page.keyboard.press("Escape");
  await view("A → B").click();
  await dialog.waitFor();
  assert.match(await group("Proposer offers").innerText(), /Their card.*SERIAL-P/s);
  assert.match(await group("Recipient offers").innerText(), /My card.*SERIAL-R/s);
  assert.equal(await dialog.getByText("You offer", { exact: true }).count(), 0);
  assert.match(await dialog.innerText(), /between other members/);
  assert.equal(await dialog.getByRole("button", { name: "Accept this revision" }).count(), 0);
});
