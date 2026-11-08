#!/usr/bin/env node
/**
 * Run the independent correctness gates concurrently.
 *
 * `astro check`, the unit suite, the Worker suite and the release/contract
 * script tests do not mutate the same state, so running them in parallel keeps
 * the complete gate without duplicating coverage. Each command still runs in
 * full; only the wall clock changes. Output is grouped per gate so a failure is
 * readable in CI.
 */
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 240_000;
const gates = [
  { name: "access-config", command: "pnpm", args: ["test:access-config"] },
  {
    name: "script-tests",
    command: "node",
    args: [
      "--test",
      "tests/scripts/release-gate.test.mjs",
      "tests/scripts/routine-release.test.mjs",
      "tests/scripts/ci-affected.test.mjs",
      "tests/scripts/api-dispatch-shape.test.mjs",
      "tests/scripts/api-openapi-contract.test.mjs",
      "tests/scripts/api-route-inventory.test.mjs",
    ],
  },
  { name: "acceptance-runner", command: "pnpm", args: ["test:acceptance-runner"] },
  { name: "reveal-presentation", command: "pnpm", args: ["test:reveal"] },
  { name: "types", command: "pnpm", args: ["check:types"] },
  { name: "unit", command: "pnpm", args: ["test:unit"] },
  { name: "workers", command: "pnpm", args: ["test:workers"] },
];

const children = new Set();
let interrupted = false;

function stopChildren(signal = "SIGTERM") {
  for (const child of children) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    stopChildren(signal);
  });
}

function runGate(gate) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(gate.command, gate.args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEFAULT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    children.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const finish = (code, reason = null) => {
      children.delete(child);
      resolve({
        ...gate,
        code: interrupted ? 130 : (code ?? 1),
        reason,
        output,
        seconds: (Date.now() - startedAt) / 1000,
      });
    };
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code, signal) => finish(code, signal ? `terminated by ${signal}` : null));
  });
}

const startedAt = Date.now();
const results = await Promise.all(gates.map(runGate));
const failed = results.filter((result) => result.code !== 0);

for (const result of results) {
  if (result.code === 0) {
    console.log(`PASS ${result.name} ${result.seconds.toFixed(1)}s`);
    continue;
  }
  console.error(
    `FAIL ${result.name} ${result.seconds.toFixed(1)}s${result.reason ? ` · ${result.reason}` : ""}`,
  );
  console.error(result.output.trimEnd());
}

const elapsed = (Date.now() - startedAt) / 1000;
if (failed.length) {
  console.error(
    `\nCheck failed in ${elapsed.toFixed(1)}s: ${failed.map((result) => result.name).join(", ")}.`,
  );
  process.exit(1);
}
console.log(`\nCheck passed in ${elapsed.toFixed(1)}s (${gates.length} gates, run concurrently).`);
