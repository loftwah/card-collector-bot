#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { RELEASE_BUDGET_SECONDS } from "./lib/routine-release.mjs";

const started = performance.now();
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "tests/scripts/release-gate.test.mjs",
    "tests/scripts/routine-release.test.mjs",
    "tests/scripts/cloudflare-access-app.test.mjs",
  ],
  { stdio: "inherit", timeout: RELEASE_BUDGET_SECONDS * 1000, killSignal: "SIGKILL" },
);
const elapsed = (performance.now() - started) / 1000;
console.log(`Focused checks took ${elapsed.toFixed(1)}s of ${RELEASE_BUDGET_SECONDS}s.`);
if (result.error) console.error(result.error.message);
process.exitCode = elapsed > RELEASE_BUDGET_SECONDS ? 1 : (result.status ?? 1);
