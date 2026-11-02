#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const stateDir = path.join(root, ".foilbury");
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const emptyEnv = path.join(stateDir, "empty.env");
if (!fs.existsSync(emptyEnv)) fs.writeFileSync(emptyEnv, "# intentionally empty; prevents operator dotenv loading\n", { mode: 0o600 });
fs.chmodSync(emptyEnv, 0o600);
const result = spawnSync(path.join(root, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "DB", "--local", "--env-file", emptyEnv], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
});
process.exit(result.status ?? 1);
