import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

test("one daily control preserves cooldown, keyboard retry and set claims", async (t) => {
  const root = process.cwd();
  const pageSource = fs.readFileSync(path.join(root, "src/pages/play/rewards.astro"), "utf8");
  assert.equal((pageSource.match(/<ClaimButton\b/g) ?? []).length, 1);
  assert.match(pageSource, /economy\.daily_cooldown_seconds/);
  assert.match(pageSource, /canClaim=\{canClaim\}/);
  assert.match(pageSource, /amount=\{economy\.daily_reward\}/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-rewards-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.jsx"></script>',
  );
  const claim = `/@fs${path.join(root, "src/components/player/ClaimButton.tsx")}`;
  const rewards = `/@fs${path.join(root, "src/components/player/RewardCenter.tsx")}`;
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import React from 'react'; import {createRoot} from 'react-dom/client'; import ClaimButton from ${JSON.stringify(claim)}; import RewardCenter from ${JSON.stringify(rewards)}; const resting=new URLSearchParams(location.search).has('resting'); createRoot(document.getElementById('root')).render(<main><section><h1>Daily allowance</h1><ClaimButton amount={480} canClaim={!resting} nextEligible={resting?'Tomorrow at 10:30':null}/></section><RewardCenter sets={[{id:'ready',release_id:'member-release',name:'Ready set',version:1,reward_amount:250,total:3,owned:3,complete:true,claimed:false}]}/></main>);`,
  );
  const server = await createServer({
    root: dir,
    configFile: false,
    cacheDir: path.join(dir, ".vite"),
    logLevel: "silent",
    esbuild: { jsx: "automatic" },
    resolve: { alias: { "@": path.join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, dir] } },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  let dailyRequests = 0;
  let setBody;
  await page.route("**/api/v1/rewards/claim", async (route) => {
    dailyRequests++;
    await route.fulfill(
      dailyRequests === 1
        ? {
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "fixture_failure", message: "Please try again." },
            }),
          }
        : {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ amount: 480, balance_after: 700 }),
          },
    );
  });
  await page.route("**/api/v1/sets/ready/claim", async (route) => {
    setBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ amount: 250 }),
    });
  });
  await page.goto(url);
  const daily = page.getByRole("button", { name: "Claim daily allowance · ✦ 480" });
  await daily.waitFor();
  assert.equal(await page.getByRole("button", { name: /claim daily allowance/i }).count(), 1);
  await page.keyboard.press("Tab");
  assert.equal(await daily.evaluate((button) => document.activeElement === button), true);
  await page.keyboard.press("Enter");
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /please try again/i);
  assert.equal(await daily.isEnabled(), true);
  await daily.click();
  await page.getByRole("status").waitFor();
  assert.match(await page.getByRole("status").innerText(), /Claimed 480 Foil/);
  assert.equal(dailyRequests, 2);
  await page.goto(`${url}?resting`);
  const resting = page.getByRole("button", { name: "Allowance resting" });
  await resting.waitFor();
  assert.equal(await resting.isDisabled(), true);
  assert.match(await page.locator("main").innerText(), /Next eligible Tomorrow at 10:30/);
  assert.equal(dailyRequests, 2);
  await page.getByRole("button", { name: "Claim completion reward" }).click();
  await page.getByRole("status").waitFor();
  assert.deepEqual(setBody, { memberReleaseId: "member-release" });
  assert.match(await page.getByRole("status").innerText(), /Ready set completion claimed/);
});
