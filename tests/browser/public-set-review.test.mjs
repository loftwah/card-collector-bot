import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("review requires an exact snapshot and explicit action; stale and revoke paths remain honest", async (t) => {
  const root = process.cwd(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-set-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<meta name="foilbury-csrf" content="fixture"><div id="root"></div><script type="module" src="/entry.jsx"></script>',
  );
  const component = `/@fs${path.join(root, "src/components/platform/PublicSetReview.tsx")}`;
  const css = `/@fs${path.join(root, "src/styles/global.css")}`;
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import React from 'react';import {createRoot} from 'react-dom/client';import ${JSON.stringify(css)};import Review from ${JSON.stringify(component)};createRoot(document.getElementById('root')).render(<main className="container py-8"><h1 className="sr-only">Platform administration</h1><Review tenantSlug="fixture-bot" /></main>);`,
  );
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: path.join(dir, "vite-cache"),
    logLevel: "silent",
    plugins: [
      {
        name: "review-fixture",
        configureServer(server) {
          server.middlewares.use("/__fixture", (_req, res) => {
            res.setHeader("content-type", "text/html");
            res.end(
              `<html lang="en"><head><title>Set review fixture</title><meta name="foilbury-csrf" content="fixture"></head><body><div id="root"></div><script type="module" src="/@fs${path.join(dir, "entry.jsx")}"></script></body></html>`,
            );
          });
        },
      },
      tailwindcss(),
    ],
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": path.join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, dir] } },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await context.newPage();
  const hash = "a".repeat(64),
    calls = [];
  let stale = true,
    recorded = false,
    revoked = false,
    denied = false;
  await page.route("**/api/v1/platform/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    calls.push({ method: req.method(), path: url.pathname, body: req.postDataJSON() });
    if (denied)
      return route.fulfill({
        status: 403,
        json: { error: { message: "A current passkey or MFA session is required." } },
      });
    if (url.pathname.endsWith("/public-set-review-candidates"))
      return route.fulfill({
        json: {
          items: [
            { id: "set-1", name: "Fixture set", version: 3, eligible: true, has_history: false },
            {
              id: "history-only",
              name: "Past set",
              version: 2,
              eligible: false,
              has_history: true,
            },
          ],
        },
      });
    if (url.pathname.endsWith("/public-reviews"))
      return route.fulfill({
        json: {
          items: recorded
            ? [
                {
                  id: "release-1",
                  set_version: 3,
                  snapshot_hash: hash,
                  review_note: "Reviewed all cards and the reward.",
                  reviewed_by: "fixture-reviewer",
                  reviewed_at: "2026-01-01T00:00:00Z",
                  revoked_at: revoked ? "2026-01-02T00:00:00Z" : null,
                  reason: revoked ? "Roster no longer suitable for release." : null,
                },
              ]
            : [],
        },
      });
    if (url.pathname.endsWith("/public-review") && req.method() === "GET")
      return route.fulfill({
        json: {
          snapshot: {
            id: "set-1",
            version: 3,
            slug: "fixture-set",
            name: "Fixture set",
            description: "A review fixture.",
            reward: 250,
            roster: [
              ["card-1", "card-one", "Card One", 1],
              ["card-2", "card-two", "Card Two", 2],
            ],
          },
          snapshot_hash: hash,
        },
      });
    if (url.pathname.endsWith("/public-review") && req.method() === "POST") {
      if (stale) {
        stale = false;
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "public_set_changed",
              message: "The reviewed set changed; review it again.",
            },
          },
        });
      }
      recorded = true;
      return route.fulfill({ status: 201, json: { id: "release-1", snapshot_hash: hash } });
    }
    if (url.pathname.endsWith("/revoke") && req.method() === "POST") {
      revoked = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: "Unexpected fixture request" } },
    });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__fixture`);
  assert.equal(calls.length, 0, "nothing is fetched or approved before choosing a set");
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Find sets" })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  await page.getByLabel("Available sets").selectOption("set-1");
  assert.equal(await page.getByLabel("Set ID").inputValue(), "set-1");
  assert.equal(await page.getByRole("option", { name: /Past set.*history only/ }).count(), 1);
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByRole("heading", { name: "Fixture set" }).waitFor();
  assert.equal(await page.getByText("Card One", { exact: true }).count(), 1);
  assert.equal(await page.getByText(hash, { exact: true }).count(), 1);
  assert.equal(await page.getByText(hash, { exact: true }).isVisible(), false);
  await page.getByText("Technical snapshot hash").click();
  assert.equal(await page.getByText(hash, { exact: true }).isVisible(), true);
  await page.getByText("Technical snapshot hash").click();
  const approve = page.getByRole("button", { name: "Record public-set review" });
  assert.equal(await approve.isDisabled(), true);
  await page
    .getByLabel("Review note · at least 20 characters")
    .fill("Reviewed all cards and the reward.");
  assert.equal(await approve.isDisabled(), true);
  await page.getByRole("checkbox").check();
  assert.equal(await approve.isEnabled(), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "mobile must not overflow horizontally",
  );
  const accessibility = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(
    accessibility.violations.map((v) => v.id),
    [],
    "loaded fixture should have no axe violations",
  );
  const evidenceRoot = path.join(root, ".foilbury/evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, "public-set-review-"));
  await page.screenshot({
    path: path.join(evidence, "mobile-fixture.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: path.join(evidence, "desktop-fixture.png"),
    fullPage: true,
  });
  await approve.click();
  await page
    .getByRole("alert")
    .getByText(/reviewed set changed/i)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Record public-set review" }).count(), 0);
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByRole("heading", { name: "Fixture set" }).waitFor();
  await page
    .getByLabel("Review note · at least 20 characters")
    .fill("Reviewed all cards and the reward.");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Record public-set review" }).click();
  await page
    .getByRole("status")
    .getByText(/Review recorded/)
    .waitFor();
  const posts = calls.filter((x) => x.method === "POST" && x.path.endsWith("/public-review"));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, {
    snapshotHash: hash,
    note: "Reviewed all cards and the reward.",
  });
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByText("Recorded · not revoked", { exact: false }).waitFor();
  const revoke = page.getByRole("button", { name: "Revoke review" });
  assert.equal(await revoke.isDisabled(), true);
  await page
    .getByLabel("Revocation reason · at least 20 characters")
    .fill("Roster no longer suitable for release.");
  await revoke.click();
  await page
    .getByRole("status")
    .getByText(/Revocation recorded/)
    .waitFor();
  assert.equal(calls.filter((x) => x.method === "POST" && x.path.endsWith("/revoke")).length, 1);
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByText("Version 3 · Revoked").waitFor();
  assert.equal(await page.getByRole("button", { name: "Revoke review" }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.body.style.zoom = "2";
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "200% zoom must not overflow",
  );
  denied = true;
  await page.getByLabel("Set ID").fill("denied-set");
  await page.getByRole("button", { name: "Load review" }).click();
  await page
    .getByRole("alert")
    .first()
    .getByText(/current passkey or MFA session/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Record public-set review" }).count(), 0);
});
