#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { apiJson, agentToken, ensureServer } from "./lib/api.mjs";
import { startDevServer } from "./lib/local.mjs";

const json = process.argv.includes("--json");
await ensureServer();

async function snapshot(agent) {
  const token = agentToken(agent);
  const [me, wallet, inventory, sets] = await Promise.all([
    apiJson("/api/v1/me", { token }),
    apiJson("/api/v1/wallet", { token }),
    apiJson("/api/v1/inventory", { token }),
    apiJson("/api/v1/sets", { token }),
  ]);
  return {
    email: me.user.email,
    balance: wallet.balance,
    instanceIds: inventory.items.map((item) => item.id).sort(),
    ledgerCount: wallet.ledger.length,
    setProgress: sets.items.map((set) => ({ slug: set.slug, version: set.version, owned: set.progress?.owned ?? 0, claimed: set.progress?.claimed ?? false })),
  };
}

try {
  const before = { owner: await snapshot("owner"), player: await snapshot("player") };
  const stop = spawnSync(path.join(process.cwd(), "node_modules/.bin/astro"), ["dev", "stop"], { cwd: process.cwd(), encoding: "utf8" });
  if (stop.status !== 0) throw new Error("Could not stop the local dev server for the persistence check.");
  const started = await startDevServer(4321);
  await ensureServer();
  const after = { owner: await snapshot("owner"), player: await snapshot("player") };
  const report = {
    ok: JSON.stringify(before) === JSON.stringify(after),
    checkedAt: new Date().toISOString(),
    restarted: started.started,
    before,
    after,
    note: "Compared inventory instance IDs, Foil balances, recent ledger counts and set progress across a full local server stop/start.",
  };
  fs.mkdirSync(path.join(process.cwd(), "docs/evidence"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "docs/evidence/persistence.json"), JSON.stringify(report, null, 2) + "\n");
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(report.ok ? "Persistence across server restart: passed" : "Persistence across server restart: FAILED");
  if (!report.ok) process.exit(1);
} catch (error) {
  console.error(`test:persistence failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
