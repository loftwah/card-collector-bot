import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const pool = (slug) => ({
  id: slug,
  slug,
  name: `${slug} capsule`,
  description: "A test capsule.",
  revision: 1,
  price: 80,
  status: "active",
});
const preview = (slug, channel = "") => ({
  pool: pool(slug),
  revision: 1,
  expected_revision: 1,
  distribution_fingerprint: `digest-${slug}-${channel}`,
  price: 80,
  eligible_count: 1,
  total_weight: 1,
  entries: [
    {
      variant_id: `v-${slug}`,
      card_id: `c-${slug}`,
      card_name: `${slug} subject`,
      edition_name: null,
      variant_name: "Plain",
      material_key: "plain",
      effect_key: null,
      render_url: null,
      weight: 1,
      probability_bps: 10000,
      tags: [],
      collections: [],
    },
  ],
  filters: {
    channel_key: channel || null,
    excluded_tags: [],
    tenant_excluded_tags: [],
    player_excluded_tags: [],
    player_hidden_collection_ids: [],
    unfiled_count: 0,
    empty_reason: null,
  },
  pity: "none",
  currency: { name: "Foil", symbol: "✦" },
});
test(
  "odds loading reserves previous panel and never enables a stale draw",
  { timeout: 60000 },
  async () => {
    const cwd = process.cwd();
    await mkdir(path.join(cwd, ".foilbury/tmp"), { recursive: true });
    const dir = await mkdtemp(path.join(cwd, ".foilbury/tmp/draw-odds-test-"));
    const source = path.join(cwd, "src/components/player/DrawStudio.tsx"),
      css = path.join(cwd, "src/styles/global.css");
    await writeFile(
      path.join(dir, "index.html"),
      '<html lang="en"><head><title>Draw fixture</title></head><body><main class="container" id="root"></main><script type="module" src="./main.tsx"></script></body></html>',
    );
    await writeFile(
      path.join(dir, "main.tsx"),
      `import React from 'react';import{createRoot}from'react-dom/client';import DrawStudio from ${JSON.stringify(source)};import ${JSON.stringify(css)};function Fixture(){const[account,setAccount]=React.useState('user');return <><button onClick={()=>setAccount('other')}>Switch fixture account</button><DrawStudio pools={${JSON.stringify([pool("alpha"), pool("beta"), pool("gamma")])}} initialBalance={500} environment="test" accountId={account} botId="bot"/><p id="after">After panel</p></>}createRoot(document.getElementById('root')!).render(<Fixture/>);`,
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
    let output = "";
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Vite startup timed out")), 15000);
      const data = (c) => {
        output = stripVTControlCharacters(output + String(c));
        const m = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      server.stdout.on("data", data);
      server.stderr.on("data", data);
      server.once("exit", () => reject(new Error(output)));
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
        ["resize", 390, 844],
        ["reduced", 390, 844],
      ]) {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: label === "reduced" ? "reduce" : "no-preference" }),
          page = await context.newPage();
        let waiting = [];
        let writes = 0;
        let alphaRequests = 0;
        await page.route("**/api/v1/pools/**", async (route) => {
          if (route.request().method() !== "GET") {
            writes++;
            await route.abort();
            return;
          }
          const u = new URL(route.request().url()),
            slug = u.pathname.split("/").at(-1),
            channel = u.searchParams.get("channel") || "";
          if (slug === "alpha" && alphaRequests++ === 0)
            return route.fulfill({ json: preview(slug, channel) });
          waiting.push({ route, slug, channel });
        });
        await page.goto(new URL(path.relative(cwd, dir) + "/index.html", url).href);
        await page.getByText("alpha subject").waitFor();
        if (label === "zoom") await page.evaluate(() => { document.body.style.zoom = "2"; });
        if (label === "resize") await page.setViewportSize({ width: 320, height: 568 });
        await page.evaluate(() => document.fonts.ready);
        if (label === "zoom" || label === "resize") await page.waitForTimeout(200);
        const after = page.locator("#after");
        const before = (await after.boundingBox()).y;
        await page.getByLabel("Choose a capsule").selectOption("beta");
        await page.getByText("Loading the selected capsule’s odds…").waitFor();
        assert.ok(await page.getByRole("button", { name: "Loading odds…" }).isDisabled());
        assert.equal(await page.getByText("alpha subject").count(), 0);
        const during = (await after.boundingBox()).y;
        assert.ok(Math.abs(during - before) < 2, `${label}: ${before} -> ${during}`);
        if (label === "reduced") {
          assert.equal(await page.locator("[aria-hidden=true] .skeleton").first().evaluate(el => getComputedStyle(el).animationName), "none");
        }
        await page.screenshot({ path: path.join(dir, `${label}-loading.png`), fullPage: true });
        const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
          ["serious", "critical"].includes(item.impact),
        );
        assert.deepEqual(violations, []);
        await page.getByLabel("Choose a capsule").selectOption("gamma");
        await page.waitForFunction(() => document.querySelector("select")?.value === "gamma");
        await new Promise((r) => setTimeout(r, 100));
        const gamma = waiting.find((x) => x.slug === "gamma");
        assert.ok(gamma);
        await gamma.route.fulfill({ json: preview("gamma") });
        await page.getByText("gamma subject").waitFor();
        await waiting
          .find((x) => x.slug === "beta")
          .route.fulfill({ json: preview("beta") })
          .catch(() => {});
        assert.equal(await page.getByText("beta subject").count(), 0);
        assert.equal(writes, 0);
        await page.getByLabel("Choose a capsule").selectOption("beta");
        await page.waitForFunction(() => document.querySelector("select")?.value === "beta");
        await new Promise((r) => setTimeout(r, 100));
        await waiting
          .at(-1)
          .route.fulfill({ status: 500, json: { error: { message: "Fixture failed" } } });
        await page.getByRole("alert").waitFor();
        assert.ok(
          await page.getByRole("button", { name: "Retry this capsule preview" }).isVisible(),
        );
        assert.equal(await page.getByText("gamma subject").count(), 0);
        await page.getByRole("button", { name: "Retry this capsule preview" }).click();
        await new Promise((r) => setTimeout(r, 100));
        await waiting.at(-1).route.fulfill({ json: preview("beta") });
        await page.getByText("beta subject").waitFor();
        await page.screenshot({ path: path.join(dir, `${label}-loaded.png`), fullPage: true });
        await page.getByLabel("Community filter").selectOption("family-table");
        assert.equal(await page.getByText("beta subject").count(), 0);
        assert.ok(await page.getByRole("button", { name: "Loading odds…" }).isDisabled());
        await new Promise((r) => setTimeout(r, 100));
        await waiting.at(-1).route.fulfill({ json: preview("beta", "family-table") });
        await page.getByText("beta subject").waitFor();
        await page.getByRole("button", { name: "Switch fixture account" }).click();
        assert.equal(await page.getByText("beta subject").count(), 0);
        assert.ok(await page.getByRole("button", { name: "Loading odds…" }).isDisabled());
        assert.equal(writes, 0);
        await context.close();
      }
      console.log(`Evidence: ${dir}`);
    } finally {
      await browser.close();
      server.kill("SIGTERM");
    }
  },
);
