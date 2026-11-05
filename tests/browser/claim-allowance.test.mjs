import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import { chromium } from "@playwright/test";

test(
  "disabled allowance cannot be claimed, and an enabled allowance remains available",
  { timeout: 30000 },
  async () => {
    const root = process.cwd();
    await mkdir(path.join(root, ".foilbury/tmp"), { recursive: true });
    const dir = await mkdtemp(path.join(root, ".foilbury/tmp/claim-allowance-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<div id="root"></div><script type="module" src="./main.tsx"></script>',
    );
    await writeFile(
      path.join(dir, "main.tsx"),
      `import React from 'react'; import {createRoot} from 'react-dom/client'; import ClaimButton from ${JSON.stringify(path.join(root, "src/components/player/ClaimButton.tsx"))}; createRoot(document.getElementById('root')!).render(<><section aria-label="disabled"><ClaimButton amount={0} canClaim={true} nextEligible="tomorrow" /></section><section aria-label="ready"><ClaimButton amount={480} canClaim={true} nextEligible={null} /></section><section aria-label="resting"><ClaimButton amount={480} canClaim={false} nextEligible="tomorrow" /></section></>);`,
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
        const onData = (chunk) => {
          output = stripVTControlCharacters(output + chunk);
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        };
        server.stdout.on("data", onData);
        server.stderr.on("data", onData);
        server.once("exit", () => reject(new Error(output)));
      });
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
        await page.goto(new URL(path.relative(root, path.join(dir, "index.html")), url).href);
        const disabled = page.getByRole("region", { name: "disabled" });
        assert.equal(
          await disabled.getByRole("button", { name: "Allowance unavailable" }).isDisabled(),
          true,
        );
        assert.equal(await disabled.getByText("Next eligible", { exact: false }).count(), 0);
        assert.equal(
          await page
            .getByRole("region", { name: "ready" })
            .getByRole("button", { name: /480/ })
            .isEnabled(),
          true,
        );
        assert.equal(
          await page
            .getByRole("region", { name: "resting" })
            .getByRole("button", { name: "Allowance resting" })
            .isDisabled(),
          true,
        );
        assert.equal(await page.getByText("Next eligible tomorrow").isVisible(), true);
      } finally {
        await browser.close();
      }
    } finally {
      server.kill();
    }
  },
);
