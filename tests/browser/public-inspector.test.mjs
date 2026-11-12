import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test(
  "public inspector preserves its card, controls and keyboard state",
  { timeout: 60000 },
  async () => {
    const cwd = process.cwd();
    await mkdir(path.join(cwd, ".foilbury/tmp"), { recursive: true });
    const dir = await mkdtemp(path.join(cwd, ".foilbury/tmp/public-inspector-test-"));
    const source = path.join(cwd, "src/components/PublicVariantViewer.tsx");
    const styles = path.join(cwd, "src/styles/global.css");
    const inspector = path.join(cwd, "src/components/player/CardInspector.tsx");
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><html lang="en"><head><title>Isolated inspector test</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main class="container" id="root"></main><script type="module" src="./main.tsx"></script></body></html>',
    );
    await writeFile(
      path.join(dir, "main.tsx"),
      `import React from 'react';import {createRoot} from 'react-dom/client';import PublicVariantViewer from ${JSON.stringify(source)};import CardInspector from ${JSON.stringify(inspector)};import ${JSON.stringify(styles)};createRoot(document.getElementById('root')!).render(location.search ? <CardInspector name="Fixture subject" finish="Plain" frontUrl="/brand/card-back.webp" backUrl="/brand/card-back.webp" /> : <PublicVariantViewer name="Fixture subject" subtitle="Fixture" description="A synthetic inspector fixture." rarity="Common" setName={null} tags={[]} variants={[{id:'one',name:'Plain',material_key:'plain',effect_key:null,render_url:'/brand/card-back.webp',back_render_url:'/brand/card-back.webp'}]} />);`,
    );
    await writeFile(
      path.join(dir, "vite.config.mjs"),
      `import {defineConfig} from 'vite';import tailwindcss from '@tailwindcss/vite';export default defineConfig({plugins:[tailwindcss()],root:${JSON.stringify(cwd)},publicDir:${JSON.stringify(path.join(cwd, "public"))},esbuild:{jsx:'automatic',tsconfigRaw:{compilerOptions:{jsx:'react-jsx'}}},resolve:{alias:{'@':${JSON.stringify(path.join(cwd, "src"))}}},server:{host:'127.0.0.1',port:0}});`,
    );
    const server = spawn(
      path.join(cwd, "node_modules/.bin/vite"),
      ["--config", path.join(dir, "vite.config.mjs")],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Vite did not start: ${output}`)), 15000);
      const onData = (chunk) => {
        output = stripVTControlCharacters(output + String(chunk));
        const found = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (found) {
          clearTimeout(timeout);
          resolve(found[0]);
        }
      };
      server.stdout.on("data", onData);
      server.stderr.on("data", onData);
      server.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Vite exited ${code}: ${output}`));
      });
    }).catch((error) => {
      server.kill("SIGTERM");
      throw error;
    });
    const browser = await chromium.launch();
    try {
      for (const [label, width, height, motion] of [
        ["phone", 390, 844, "no-preference"],
        ["short", 320, 568, "no-preference"],
        ["desktop", 1280, 900, "no-preference"],
        ["reduced", 390, 844, "reduce"],
        ["zoom", 390, 844, "no-preference"],
      ]) {
        const context = await browser.newContext({
          viewport: { width, height },
          reducedMotion: motion,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(new URL(path.relative(cwd, dir) + "/index.html", url).href, {
          waitUntil: "networkidle",
        });
        if (label === "zoom") await page.evaluate(() => { document.body.style.zoom = "2"; });
        const initial = await page.locator(".card-face").boundingBox();
        assert.ok(initial && Math.abs(initial.width / initial.height - 5 / 7) < 0.01);
        await page.getByRole("button", { name: "Show back" }).click();
        await page.getByRole("button", { name: "Inspect in 3D" }).focus();
        await page.evaluate(() => {
          window.__inspectionFocusGap = false;
          const observer = new MutationObserver(() => {
            const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('Exit 3D'));
            if (button && !button.disabled && document.activeElement !== button) window.__inspectionFocusGap = true;
          });
          observer.observe(document.body, {subtree:true, childList:true, attributes:true});
        });
        await page.keyboard.press("Enter");
        const stage = page.locator(".card-inspector__stage");
        const current = await stage.boundingBox();
        assert.ok(
          current &&
            Math.abs(current.width - initial.width) < 1 &&
            Math.abs(current.height - initial.height) < 1,
          `${label}: card changed size ${JSON.stringify({initial,current})}`,
        );
        assert.equal(await stage.getAttribute("data-flipped"), "true");
        await page.waitForFunction(
          (expected) =>
            document.querySelector(".card-inspector__stage")?.getAttribute("data-mode") ===
            expected,
          motion === "reduce" ? "static" : "interactive",
        );
        assert.equal(
          await stage.getAttribute("data-mode"),
          motion === "reduce" ? "static" : "interactive",
        );
        assert.equal(await page.evaluate(() => window.__inspectionFocusGap), false, `${label}: focus was absent after the enabled inspector appeared`);
        await assert.doesNotReject(() =>
          page.getByRole("button", { name: "Exit 3D" }).evaluate((element) => {
            if (document.activeElement !== element) throw new Error("focus was lost");
          }),
        );
        await page.waitForTimeout(500);
        const hit = await stage.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.getAttribute("alt");
        });
        assert.equal(hit, "Fixture subject back, Plain finish", `${label}: card back is obscured`);
        const expand = page.getByRole("button", { name: "Expand", exact: true });
        await expand.click({ timeout: 2500 });
        const viewer = page.getByRole("dialog", { name: "Fixture subject" });
        await viewer.getByRole("link", { name: "Download Fixture subject back" }).waitFor();
        await page.keyboard.press("Escape");
        await viewer.waitFor({ state: "hidden" });
        assert.equal(await stage.getAttribute("data-flipped"), "true");
        assert.equal(await expand.evaluate((button) => button === document.activeElement), true);
        await page.screenshot({ path: path.join(dir, `${label}-interactive.png`), fullPage: true });
        await stage.focus();
        await page.keyboard.press("f");
        assert.equal(await stage.getAttribute("data-flipped"), "false");
        await page.keyboard.press("Escape");
        assert.equal(await stage.getAttribute("data-mode"), "flat");
        const controls = await page.locator(".card-inspector__controls").boundingBox();
        assert.ok(
          controls && controls.y >= current.y + current.height - 1,
          `${label}: controls overlap card`,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${label}: horizontal overflow`,
        );
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const violations = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
          ["serious", "critical"].includes(item.impact),
        );
        assert.deepEqual(violations, []);
        assert.deepEqual(errors, []);
        await page.getByRole("button", { name: "Inspect in 3D" }).hover();
        await page.waitForTimeout(300);
        const hovered = (await new AxeBuilder({ page }).analyze()).violations.filter((item) =>
          ["serious", "critical"].includes(item.impact),
        );
        assert.deepEqual(hovered, []);
        await page.screenshot({ path: path.join(dir, `${label}.png`), fullPage: true });
        await page.goto(new URL(path.relative(cwd, dir) + "/index.html", url).href, {
          waitUntil: "networkidle",
        });
        await page.getByRole("button", { name: "Inspect in 3D" }).click();
        assert.equal(await page.locator(".card-inspector__stage").getAttribute("data-flipped"), "false");
        await page.goto(new URL(path.relative(cwd, dir) + "/index.html?direct=1", url).href, {
          waitUntil: "networkidle",
        });
        assert.equal(
          await page.locator(".card-inspector__stage").getAttribute("data-mode"),
          "flat",
          `${label}: default inspector changed`,
        );
        await page.getByRole("button", { name: "Inspect in 3D" }).click();
        await page.waitForFunction(
          (expected) =>
            document.querySelector(".card-inspector__stage")?.getAttribute("data-mode") ===
            expected,
          motion === "reduce" ? "static" : "interactive",
        );
        assert.equal(
          await page.locator(".card-inspector__stage").getAttribute("data-flipped"),
          "false",
        );
        await context.close();
      }
      console.log(`Synthetic inspector evidence: ${dir}`);
    } finally {
      await browser.close();
      server.kill("SIGTERM");
    }
  },
);
