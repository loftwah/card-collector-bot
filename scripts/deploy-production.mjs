#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["build"]);

// Astro/Cloudflare copies .dev.vars into the server output for local preview.
// It must never be uploaded with a production Worker.
const leaked = path.join(ROOT, "dist/server/.dev.vars");
if (fs.existsSync(leaked)) {
  fs.rmSync(leaked, { force: true });
  console.log("removed dist/server/.dev.vars before production upload");
}
if (fs.existsSync(leaked)) throw new Error("The production bundle still contains .dev.vars.");

run(path.join(ROOT, "node_modules/.bin/wrangler"), [
  "deploy",
  "--config",
  "wrangler.production.jsonc",
]);
