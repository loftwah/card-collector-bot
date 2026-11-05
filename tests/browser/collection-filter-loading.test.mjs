import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const item = (id) => ({
  id,
  card_name: `${id} subject`,
  card_slug: id,
  edition_name: "",
  variant_name: "Plain",
  material_key: "plain",
  effect_key: null,
  rarity_name: null,
  serial: id,
  status: "owned",
  favourite: 0,
  locked: 0,
  render_url: null,
  thumbnail_url: null,
  acquired_at: "2026-01-01",
});
test(
  "changing filters replaces old cards until the selected results load",
  { timeout: 60000 },
  async () => {
    const cwd = process.cwd();
    await mkdir(path.join(cwd, ".foilbury/tmp"), { recursive: true });
    const dir = await mkdtemp(path.join(cwd, ".foilbury/tmp/collection-filter-test-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<html lang="en"><head><title>Collection fixture</title></head><body><main class="container" id="root"></main><script type="module" src="./main.tsx"></script></body></html>',
    );
    await writeFile(
      path.join(dir, "main.tsx"),
      `import React from 'react';import{createRoot}from'react-dom/client';import CollectionBrowser from ${JSON.stringify(path.join(cwd, "src/components/player/CollectionBrowser.tsx"))};import ${JSON.stringify(path.join(cwd, "src/styles/global.css"))};function Fixture(){const[scope,setScope]=React.useState('account-a:bot-a');return <><button onClick={()=>setScope('account-b:bot-a')}>Switch fixture account</button><button onClick={()=>setScope('account-a:bot-b')}>Switch fixture Bot</button><CollectionBrowser scopeKey={scope} initialItems={location.search.includes('fixture_large') ? ${JSON.stringify(Array.from({ length: 200 }, (_, i) => item(`card-${i}`)))} : ${JSON.stringify([item("old")])}} initialTotal={location.search.includes('fixture_large') ? 200 : location.search.includes('fixture_append') ? 2 : 1} sets={[]} collections={[{slug:'alpha',name:'Alpha',logo_url:null},{slug:'beta',name:'Beta',logo_url:null}]}/></>}createRoot(document.getElementById('root')!).render(<Fixture/>);`,
    );
    await writeFile(
      path.join(dir, "vite.config.mjs"),
      `import{defineConfig}from'vite';import tailwindcss from'@tailwindcss/vite';export default defineConfig({plugins:[tailwindcss()],root:${JSON.stringify(cwd)},esbuild:{jsx:'automatic',tsconfigRaw:{compilerOptions:{jsx:'react-jsx'}}},resolve:{alias:{'@':${JSON.stringify(path.join(cwd, "src"))}}},server:{host:'127.0.0.1',port:0}});`,
    );
    const server = spawn(
      path.join(cwd, "node_modules/.bin/vite"),
      ["--config", path.join(dir, "vite.config.mjs")],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("startup timeout")), 15000);
      const onData = (c) => {
        out = stripVTControlCharacters(out + String(c));
        const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      server.stdout.on("data", onData);
      server.stderr.on("data", onData);
      server.once("exit", () => reject(Error(out)));
    }).catch((e) => {
      server.kill();
      throw e;
    });
    const browser = await chromium.launch();
    try {
      for (const [label, width, height] of [
        ["desktop", 1280, 900],
        ["phone", 390, 844],
        ["short", 320, 568],
        ["zoom", 390, 844],
      ]) {
        const context = await browser.newContext({ viewport: { width, height } }),
          page = await context.newPage();
        let pending = [],
          writes = 0;
        await page.route("**/api/v1/**", async (route) => {
          if (route.request().method() !== "GET") {
            writes++;
            await route.abort();
            return;
          }
          pending.push(route);
        });
        await page.goto(new URL(path.relative(cwd, dir) + "/index.html", url).href);
        await page.waitForSelector('[data-hydrated="true"]');
        if (label === "zoom")
          await page.evaluate(() => {
            document.body.style.zoom = "2";
          });
        const original = await page.locator(".card-face").boundingBox();
        await page.locator("select[name=collection]").focus();
        await page.locator("select[name=collection]").selectOption("alpha");
        await page.getByText("Loading your cards…").waitFor();
        assert.equal(
          await page
            .locator("select[name=collection]")
            .evaluate((el) => document.activeElement === el),
          true,
        );
        assert.equal(await page.getByText("old subject").count(), 0);
        assert.equal(await page.locator(".card-grid[aria-hidden=true] .skeleton").count(), 3);
        assert.ok(
          Math.abs(
            (await page.locator(".card-grid .skeleton").first().boundingBox()).height -
              original.height,
          ) < 2,
        );
        assert.equal(await page.locator('a[href^="/play/card/"]').count(), 0);
        await page.screenshot({ path: path.join(dir, `${label}-loading.png`), fullPage: true });
        const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((x) =>
          ["serious", "critical"].includes(x.impact),
        );
        assert.deepEqual(violations, []);
        await pending
          .at(-1)
          .fulfill({ status: 500, json: { error: { message: "Fixture failure" } } });
        await page.getByRole("alert").waitFor();
        assert.ok(
          await page
            .getByText("The selected filters could not be loaded. Try again to see your cards.")
            .isVisible(),
        );
        assert.equal(await page.getByText("old subject").count(), 0);
        await page.getByRole("button", { name: "Try again" }).click();
        await page.getByText("Loading your cards…").waitFor();
        await new Promise((r) => setTimeout(r, 100));
        await pending.at(-1).fulfill({ json: { items: [item("new")], total: 1 } });
        await page.getByText("new subject").waitFor();
        assert.equal(await page.getByText("old subject").count(), 0);
        await page.locator("select[name=collection]").selectOption("beta");
        await page.locator("select[name=collection]").selectOption("alpha");
        await new Promise((r) => setTimeout(r, 100));
        const latest = pending.at(-1),
          superseded = pending.at(-2);
        await latest.fulfill({ json: { items: [], total: 0 } });
        await page.getByText("No cards match this view.").waitFor();
        await superseded.fulfill({ json: { items: [item("stale")], total: 1 } }).catch(() => {});
        assert.equal(await page.getByText("stale subject").count(), 0);
        await page.locator("select[name=collection]").selectOption("beta");
        await page.getByText("Loading your cards…").waitFor();
        assert.ok((await page.locator(".card-grid[aria-hidden=true] .skeleton").count()) > 0);
        await pending.at(-1).fulfill({ json: { items: [item("final")], total: 1 } });
        await page.getByText("final subject").waitFor();
        await page.locator("select[name=collection]").selectOption("alpha");
        await page.getByText("Loading your cards…").waitFor();
        await page
          .getByRole("button", {
            name:
              label === "phone" || label === "zoom"
                ? "Switch fixture account"
                : "Switch fixture Bot",
          })
          .click();
        assert.equal(await page.getByText("final subject").count(), 0);
        await pending
          .at(-1)
          .fulfill({ json: { items: [item("late")], total: 1 } })
          .catch(() => {});
        assert.equal(await page.getByText("late subject").count(), 0);
        assert.ok(
          await page
            .getByRole("alert")
            .getByText(
              "Your account or Bot changed. Reload this page to view the current collection.",
            )
            .isVisible(),
        );
        assert.equal(writes, 0);
        await context.close();
      }
      const context = await browser.newContext(),
        page = await context.newPage();
      let requests = [];
      await page.route("**/api/v1/inventory?**", (route) => {
        requests.push(route);
      });
      await page.goto(new URL(path.relative(cwd, dir) + "/index.html?fixture_append=1", url).href);
      await page.waitForSelector('[data-hydrated="true"]');
      await page.getByRole("button", { name: "Load 1 more" }).click();
      await requests
        .at(-1)
        .fulfill({ status: 500, json: { error: { message: "Fixture failure" } } });
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("old subject").count(), 1);
      await page.getByRole("button", { name: "Try again" }).click();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(new URL(requests.at(-1).request().url()).searchParams.get("offset"), "1");
      await requests
        .at(-1)
        .fulfill({ status: 403, json: { error: { message: "Access changed" } } });
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("old subject").count(), 0);
      await context.close();
      const large = await browser.newContext({ viewport: { width: 390, height: 844 } }),
        largePage = await large.newPage();
      let hold;
      await largePage.route("**/api/v1/inventory?**", (route) => {
        hold = route;
      });
      await largePage.goto(
        new URL(path.relative(cwd, dir) + "/index.html?fixture_large=1", url).href,
      );
      await largePage.waitForSelector('[data-hydrated="true"]');
      const gridBefore = await largePage.locator(".card-grid").boundingBox();
      await largePage.locator("select[name=collection]").selectOption("alpha");
      await largePage.getByText("Loading your cards…").waitFor();
      const skeleton = largePage.locator(".card-grid[aria-hidden=true]");
      assert.equal(await skeleton.locator(".skeleton").count(), 72);
      assert.ok(Math.abs((await skeleton.boundingBox()).height - gridBefore.height) < 2);
      assert.equal(await largePage.getByText("card-0 subject").count(), 0);
      await hold.fulfill({ json: { items: [], total: 0 } });
      await largePage.getByText("No cards match this view.").waitFor();
      await large.close();
      console.log(`Evidence: ${dir}`);
    } finally {
      await browser.close();
      server.kill("SIGTERM");
    }
  },
);
