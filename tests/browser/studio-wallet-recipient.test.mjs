import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { chromium } from "@playwright/test";

test("Studio grant form sends the selected API member id", { timeout: 30000 }, async () => {
  const root = process.cwd();
  await mkdir(path.join(root, ".foilbury/tmp"), { recursive: true });
  const dir = await mkdtemp(path.join(root, ".foilbury/tmp/studio-wallet-recipient-"));
  await writeFile(
    path.join(dir, "index.html"),
    '<div id="root"></div><script type="module" src="./main.tsx"></script>',
  );
  await writeFile(
    path.join(dir, "main.tsx"),
    `import React from 'react'; import {createRoot} from 'react-dom/client'; import StudioWallet from ${JSON.stringify(path.join(root, "src/components/studio/StudioWallet.tsx"))}; window.__FOILBURY_STUDIO__ = true; createRoot(document.getElementById('root')!).render(<StudioWallet userId="usr_owner" tenantId="tenant_fixture" canSelfGrant={true} grantLimit={100} canGrant={true} />);`,
  );
  await writeFile(
    path.join(dir, "vite.config.mjs"),
    `import {defineConfig} from 'vite'; export default defineConfig({root:${JSON.stringify(root)},esbuild:{jsx:'automatic'},resolve:{alias:{'@':${JSON.stringify(path.join(root, "src"))}}},server:{host:'127.0.0.1',port:0}});`,
  );
  const server = spawn(
    path.join(root, "node_modules/.bin/vite"),
    ["--config", path.join(dir, "vite.config.mjs")],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Vite startup timed out")), 15000);
      const read = (chunk) => {
        output = stripVTControlCharacters(output + chunk);
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      server.stdout.on("data", read);
      server.stderr.on("data", read);
      server.once("exit", () => reject(new Error(output)));
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const requests = [];
      await page.route("**/api/v1/studio/**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "POST") {
          requests.push({ pathname, body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
          if (requests.length === 1) {
            await route.abort("failed"); // Simulate a response lost after a server commit.
            return;
          }
          await route.fulfill({ json: { balance_after: 200 } });
          return;
        }
        if (pathname.endsWith("/economy"))
          await route.fulfill({
            json: { currency_name: "Foil", currency_symbol: "✦", version: 1 },
          });
        else if (pathname.endsWith("/wallet-recipients"))
          await route.fulfill({
            json: {
              items: [
                {
                  id: "usr_owner",
                  display_name: "Owner",
                },
                {
                  id: "usr_target",
                  display_name: "Player",
                },
              ],
            },
          });
        else if (pathname.endsWith("/wallets/usr_owner"))
          await route.fulfill({ json: { balance: 100 } });
        else
          await route.fulfill({
            status: 404,
            json: { error: { message: "Unexpected fixture request" } },
          });
      });
      await page.goto(new URL(path.relative(root, path.join(dir, "index.html")), url).href);
      const select = page.getByLabel("Recipient");
      await select.waitFor();
      assert.equal(await select.locator('option[value="usr_target"]').count(), 1);
      assert.equal(await page.getByRole("button", { name: "Record one grant" }).isDisabled(), true);
      await select.selectOption("usr_target");
      await page.getByLabel("Amount (✦)").fill("1.5");
      assert.equal(await page.getByRole("button", { name: "Record one grant" }).isDisabled(), true);
      await page.getByLabel("Amount (✦)").fill("100");
      await page.screenshot({ path: path.join(dir, "recipient.png"), fullPage: true });
      console.log(`Synthetic component evidence: ${dir}`);
      await page.getByRole("button", { name: "Record one grant" }).click();
      await page.getByRole("alert").waitFor();
      await page.reload();
      await page.getByText(/previous grant could not be confirmed/).waitFor();
      assert.equal(await page.getByLabel("Recipient").inputValue(), "usr_target");
      await page.getByRole("button", { name: "Record one grant" }).click();
      await page.getByText(/Grant recorded once/).waitFor();
      assert.equal(requests.length, 2);
      assert.ok(requests[0].key);
      assert.equal(requests[0].key, requests[1].key);
      assert.equal(requests[0].pathname, "/api/v1/studio/wallets/usr_target/adjust");
      assert.equal(requests[0].body.amount, 100);
      await page.unrouteAll();
      await page.route("**/api/v1/studio/**", (route) => route.fulfill({ status: 500, json: { error: { message: "Fixture unavailable" } } }));
      await page.reload();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.locator(".skeleton").count(), 0);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
});
