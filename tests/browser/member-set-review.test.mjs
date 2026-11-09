import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("Bot owner reviews exact member roster and audiences through explicit actions", async (t) => {
  const root = process.cwd(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-member-set-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  const component = `/@fs${path.join(root, "src/components/studio/MemberSetReview.tsx")}`,
    css = `/@fs${path.join(root, "src/styles/global.css")}`;
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import React from 'react';import {createRoot} from 'react-dom/client';import ${JSON.stringify(css)};import Review from ${JSON.stringify(component)};window.__FOILBURY_STUDIO__=true;createRoot(document.getElementById('root')).render(<main className="container py-8"><h1 className="sr-only">Studio</h1><Review tenantSlug="fixture-bot" /></main>);`,
  );
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: path.join(dir, "vite-cache"),
    logLevel: "silent",
    plugins: [
      {
        name: "member-review-fixture",
        configureServer(s) {
          s.middlewares.use("/__member_fixture", (_req, res) => {
            res.setHeader("content-type", "text/html");
            res.end(
              `<html lang="en"><head><title>Member review fixture</title><meta name="foilbury-csrf" content="fixture"></head><body><div id="root"></div><script type="module" src="/@fs${path.join(dir, "entry.jsx")}"></script></body></html>`,
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
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } }),
    page = await context.newPage();
  const hash = "b".repeat(64),
    calls = [];
  let stale = true,
    recorded = false,
    revoked = false,
    denied = false;
  await page.route("**/api/v1/studio/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    calls.push({ path: url.pathname, method: req.method(), body: req.postDataJSON() });
    if (denied)
      return route.fulfill({
        status: 403,
        json: { error: { message: "A current Bot owner passkey or MFA session is required." } },
      });
    if (url.pathname === "/api/v1/studio/sets")
      return route.fulfill({
        json: { items: [{ id: "set-1", name: "Fixture set", version: 3, status: "published" }] },
      });
    if (url.pathname.endsWith("/member-reviews"))
      return route.fulfill({
        json: {
          items: recorded
            ? [
                {
                  id: "member-release-1",
                  set_version: 3,
                  reviewed_at: "2026-01-01T00:00:00Z",
                  revoked_at: revoked ? "2026-01-02T00:00:00Z" : null,
                },
              ]
            : [],
        },
      });
    if (url.pathname.endsWith("/member-review") && req.method() === "GET")
      return route.fulfill({
        json: {
          snapshot: {
            id: "set-1",
            version: 3,
            reward: 250,
            roster: [["card-1", "card-one", "Card One", 1]],
            collections: [
              [
                "card-1",
                "collection-1",
                "Fixture world",
                "bot",
                "tenant-1",
                "published",
                "members",
                null,
                null,
              ],
            ],
          },
          snapshot_hash: hash,
        },
      });
    if (url.pathname.endsWith("/member-review") && req.method() === "POST") {
      if (stale) {
        stale = false;
        return route.fulfill({
          status: 409,
          json: { error: { message: "The set changed; review it again." } },
        });
      }
      recorded = true;
      return route.fulfill({ status: 201, json: { id: "member-release-1", snapshot_hash: hash } });
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__member_fixture`);
  await page.getByLabel("Set", { exact: true }).waitFor();
  assert.equal(
    calls.some((c) => c.method === "POST"),
    false,
    "discovery must never approve",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.getByLabel("Set", { exact: true }).evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByLabel("Set", { exact: true }).selectOption("set-1");
  assert.equal(await page.getByLabel("Set", { exact: true }).inputValue(), "set-1");
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByRole("heading", { name: "Fixture set" }).waitFor();
  assert.equal(await page.getByText("Card One", { exact: true }).count(), 1);
  assert.equal(await page.getByText(hash, { exact: true }).isVisible(), false);
  await page.getByText("Technical snapshot hash").click();
  assert.equal(await page.getByText(hash, { exact: true }).isVisible(), true);
  await page.getByText("Technical snapshot hash").click();
  assert.equal(await page.getByText(/Fixture world · bot · members · published/).count(), 1);
  const approve = page.getByRole("button", { name: "Record member-set review" });
  assert.equal(await approve.isDisabled(), true);
  await page.getByRole("checkbox").check();
  assert.equal(await approve.isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const axe = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  );
  const evidenceRoot = path.join(root, ".foilbury/evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceRoot, "member-set-review-"));
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
    .getByText(/set changed/i)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Record member-set review" }).count(), 0);
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByRole("heading", { name: "Fixture set" }).waitFor();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Record member-set review" }).click();
  await page
    .getByRole("status")
    .getByText(/Review recorded/)
    .waitFor();
  assert.deepEqual(
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/member-review")).at(-1).body,
    { snapshotHash: hash },
  );
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByText(/Recorded · not revoked/).waitFor();
  const revoke = page.getByRole("button", { name: "Revoke review" });
  assert.equal(await revoke.isDisabled(), true);
  await page.getByRole("checkbox", { name: "Revoke this recorded member-set review." }).check();
  await revoke.click();
  await page
    .getByRole("status")
    .getByText(/Revocation recorded/)
    .waitFor();
  await page.getByRole("button", { name: "Load review" }).click();
  await page.getByText("Version 3 · Revoked").waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => (document.body.style.zoom = "2"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  denied = true;
  await page.getByRole("button", { name: "Load review" }).click();
  await page
    .getByRole("alert")
    .first()
    .getByText(/current Bot owner passkey or MFA/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Record member-set review" }).count(), 0);
});
