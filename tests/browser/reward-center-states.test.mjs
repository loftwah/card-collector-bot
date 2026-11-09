import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

test("reward controls distinguish unavailable, ready, claimed and in-progress states", async (t) => {
  const root = process.cwd(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-reward-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<div id="root"></div><script type="module" src="/entry.jsx"></script>',
  );
  const component = `/@fs${path.join(root, "src/components/player/RewardCenter.tsx")}`;
  fs.writeFileSync(
    path.join(dir, "entry.jsx"),
    `import React from 'react'; import {createRoot} from 'react-dom/client'; import RewardCenter from ${JSON.stringify(component)}; const base={version:1,reward_amount:10,total:3,owned:3}; createRoot(document.getElementById('root')).render(<RewardCenter sets={[{...base,id:'unavailable',name:'Unavailable set',complete:null,claimed:null},{...base,id:'ready',name:'Ready set',complete:true,claimed:false},{...base,id:'claimed',name:'Claimed set',complete:true,claimed:true},{...base,id:'in-progress',name:'In progress set',owned:1,complete:false,claimed:false}]}/>);`,
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
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const article = (name) =>
    page.locator("article").filter({ has: page.getByRole("heading", { name }) });
  const unavailable = article("Unavailable set");
  await unavailable.waitFor();
  assert.equal(await unavailable.getByText("Completion unavailable").count(), 2);
  assert.equal(
    await unavailable.getByRole("button", { name: "Completion unavailable" }).isDisabled(),
    true,
  );
  assert.equal(
    await article("Ready set").getByRole("button", { name: "Claim completion reward" }).isEnabled(),
    true,
  );
  assert.equal(
    await article("Claimed set").getByRole("button", { name: "Reward claimed" }).isDisabled(),
    true,
  );
  const browse = article("In progress set").getByRole("link", { name: "Browse eligible capsules" });
  assert.equal(await browse.getAttribute("href"), "/play/draw");
  assert.match(
    await article("In progress set").innerText(),
    /may not contain cards from this set/i,
  );
  assert.equal(await page.getByText("3/3 visible cards").count(), 3);
});
