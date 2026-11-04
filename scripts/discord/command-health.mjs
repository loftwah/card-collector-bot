#!/usr/bin/env node
/**
 * Command-execution health gate.
 *
 * Runs the emitted-Worker test (`dist/server/entry.mjs`) through the real
 * signed Discord interaction route with an isolated D1/R2 fixture. This is the
 * default, safe gate: it draws against the test database only, never
 * production, and never calls a paid provider.
 *
 *   node scripts/discord/command-health.mjs
 *
 * The preflight reads `.foilbury/evidence/discord-command-health.json` and
 * reports the layer honestly. A live production draw is a separate,
 * authorised human step and is never inferred from this receipt.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";
import { sourceState } from "../lib/source-identity.mjs";

const startedAt = new Date().toISOString();
const source = sourceState();
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.production-path.config.ts",
    "tests/production-path/discord-worker.test.ts",
  ],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const passed = result.status === 0;
const tests = [...output.matchAll(/(\d+)\s+passed/g)].map((match) => Number(match[1]));
const receipt = {
  schema_version: 1,
  layer: "emitted-worker-fixture",
  generated_at: new Date().toISOString(),
  started_at: startedAt,
  source_sha: source.sha,
  source_tree_hash: source.tree_hash,
  exit_code: result.status ?? 1,
  passed,
  tests_passed: tests.length ? Math.max(...tests) : 0,
  note: passed
    ? "Signed fixture drew through the emitted Worker with an isolated D1/R2 fixture. This is not a live production draw."
    : "The emitted-Worker command path did not pass. Do not claim real command execution.",
};
const dir = path.join(ROOT, ".foilbury", "evidence");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "discord-command-health.json");
fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  `${passed ? "PASS" : "FAIL"} emitted Worker command health · ${receipt.tests_passed} test(s) · ${path.relative(ROOT, file)}`,
);
if (!passed) {
  console.error(output.slice(-4000));
  process.exit(result.status ?? 1);
}
