import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "vite";
import tailwind from "@tailwindcss/vite";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("review binds both visible images to the snapshot and handles changed and successful decisions", async (t) => {
  const root = process.cwd(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-render-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html lang="en"><head><meta name="foilbury-csrf" content="fixture"></head><body><main id="root"></main><script type="module" src="/entry.jsx"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(dir, "fixture.css"),
    `@import '/@fs${path.join(root, "src/styles/global.css")}';\n@source '${path.join(root, "src")}';`,
  );
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import './fixture.css';import React from 'react';import {createRoot} from 'react-dom/client';import Review from '/@fs${path.join(root, "src/components/studio/BoundRenderReview.tsx")}';window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<Review environment="fixture" accountId={new URLSearchParams(location.search).get('account') || 'account'} botId="bot"/>);`,
  );
  const server = await createServer({
    configFile: false,
    root: dir,
    cacheDir: path.join(dir, ".vite"),
    plugins: [tailwind()],
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": path.join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, dir] } },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  const png = fs.readFileSync(path.join(root, "public/brand/card-back.webp"));
  const digest = crypto.createHash("sha256").update(png).digest("hex");
  let corrupt = true,
    fail = true,
    malformed = true,
    receiptPending = true,
    recoveryConflict = false;
  const posts = [];
  const manifest = {
    collectionId: "collection_fixture",
    cardId: "card_fixture",
    variantId: "variant_fixture",
    editionId: "edition_fixture",
    editionName: "Fixture edition",
    recipeId: "recipe_fixture",
    recipeVersion: 1,
    cardVersion: 1,
    metadata: {
      name: "Fixture card",
      subtitle: "",
      setName: "Fixture world",
      serial: "PUBLIC SHOWCASE",
      material: "gold",
      effect: "none",
    },
  };
  await page.route("**/api/v1/studio/bound-renders/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === "POST") {
      posts.push({ body: req.postDataJSON(), csrf: req.headers()["x-foilbury-csrf"] });
      if (recoveryConflict) {
        recoveryConflict = false;
        return route.fulfill({ status: 409, json: { error: { message: "Access changed." } } });
      }
      if (fail) {
        fail = false;
        return route.fulfill({ status: 409, json: { error: { message: "The render changed." } } });
      }
      if (receiptPending) {
        receiptPending = false;
        return route.fulfill({ status: 409, json: { error: { code: 'render_review_receipt_pending', message: 'The review may have been recorded.' } } });
      }
      if (malformed) {
        malformed = false;
        return route.fulfill({ json: { decision: req.postDataJSON().decision } });
      }
      return route.fulfill({
        json: {
          id: "job_fixture",
          attempt: 2,
          reviewId: "review_fixture",
          decision: req.postDataJSON().decision,
        },
      });
    }
    if (url.pathname.endsWith("/review"))
      return route.fulfill({
        json: {
          manifest,
          manifestSha256: "a".repeat(64),
          attempt: 2,
          front: { sha256: digest, mime: "image/webp" },
          back: { sha256: digest, mime: "image/webp" },
        },
      });
    if (url.pathname.endsWith("/preview/front") || url.pathname.endsWith("/preview/back"))
      return route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: corrupt && url.pathname.endsWith("/back") ? Buffer.from("wrong") : png,
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.getByLabel("Render job ID").fill("job_fixture");
  await page.getByRole("button", { name: "Load render" }).click();
  await page
    .getByRole("alert")
    .getByText(/preview changed/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve render" }).count(), 0);
  corrupt = false;
  await page.getByRole("button", { name: "Load render" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Fixture card" }).waitFor();
  await page.getByText(/human Super Admin/).waitFor();
  await page.getByRole("img", { name: "front of Fixture card" }).waitFor();
  await page.getByRole("img", { name: "back of Fixture card" }).waitFor();
  const confirm = page.getByRole("checkbox");
  await confirm.waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "Approve render" }).isDisabled(), true);
  assert.equal(await confirm.isDisabled(), true);
  await page.getByText("Exact render manifest and digests").click();
  await confirm.check();
  await page.getByLabel("Review note (optional)").fill("Checked both sides");
  const axe = await new AxeBuilder({ page }).include("main").analyze();
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const evidenceRoot = path.join(root, ".foilbury/evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, "bound-render-review-"));
  await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
  console.log("Private mocked evidence:", evidence);
  await page.getByRole("button", { name: "Approve render" }).click();
  await page
    .getByRole("alert")
    .getByText(/render changed/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve render" }).count(), 0);
  await page.getByRole("button", { name: "Load render" }).click();
  await page.getByText("Exact render manifest and digests").click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Approve render" }).click();
  await page
    .getByRole("alert")
    .getByText(/outcome could not be confirmed/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Load render" }).isDisabled(), true);
  await page.reload();
  await page.getByText(/review decision needs confirmation/i).waitFor();
  assert.equal(await page.getByRole("button", { name: "Load render" }).isDisabled(), true);
  await page.getByText('Pending decision details').click();
  await page.getByText('Note: Checked both sides').waitFor();
  assert.deepEqual((await new AxeBuilder({page}).include('main').analyze()).violations.map(v=>v.id), []);
  await page.screenshot({ path: path.join(evidence, "mobile-recovered.png"), fullPage: true });
  const second = await context.newPage();
  await second.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await second.getByText(/review decision needs confirmation/i).waitFor();
  assert.equal(await second.getByRole("button", { name: "Load render" }).isDisabled(), true);
  await second.close();
  const otherAccount = await context.newPage();
  await otherAccount.goto(`http://127.0.0.1:${server.httpServer.address().port}/?account=other`);
  await otherAccount.getByRole('button', {name:'Load render'}).waitFor({state:'visible'});
  await otherAccount.waitForFunction(() => !document.querySelector('button')?.disabled);
  assert.equal(await otherAccount.getByText(/review decision needs confirmation/i).count(), 0);
  await otherAccount.close();
  recoveryConflict = true;
  await page.getByRole("button", { name: "Retry same decision" }).click();
  await page.getByRole('alert').getByText(/outcome could not be confirmed/).waitFor();
  await page.reload();
  await page.getByText(/review decision needs confirmation/i).waitFor();
  await page.getByRole("button", { name: "Retry same decision" }).click();
  await page.getByRole('alert').getByText(/outcome could not be confirmed/).waitFor();
  await page.reload();
  await page.getByText(/review decision needs confirmation/i).waitFor();
  await page.getByRole("button", { name: "Retry same decision" }).click();
  await page
    .getByRole("status")
    .getByText(/does not publish/)
    .waitFor();
  assert.equal(posts.length, 5);
  assert.equal(posts[4].csrf, "fixture");
  assert.deepEqual(posts[4].body, {
    decision: "approved",
    manifestSha256: "a".repeat(64),
    frontSha256: digest,
    backSha256: digest,
    note: "Checked both sides",
  });
  assert.deepEqual(posts[4].body, posts[1].body);
  manifest.metadata.serial = "MEMBER EDITION";
  await page.getByRole("button", { name: "Load render" }).click();
  await page.getByText(/scoped creative review/).waitFor();
  await page.getByText("Exact render manifest and digests").click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Reject render" }).click();
  await page
    .getByRole("status")
    .getByText(/Review rejected/)
    .waitFor();
  assert.equal(posts[5].body.decision, "rejected");
  const blocked = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await blocked.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new Error('storage blocked'); } }));
  const blockedPage = await blocked.newPage();
  await blockedPage.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await blockedPage.getByRole('alert').waitFor();
  assert.equal(await blockedPage.getByRole('button', {name:'Load render'}).isDisabled(), true);
  await blocked.close();
});
