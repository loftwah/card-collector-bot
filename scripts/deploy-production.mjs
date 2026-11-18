#!/usr/bin/env node
/** Build once and verify the released Worker within the routine deadline. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { readVarFile } from "./lib/local.mjs";
import { sourceState } from "./lib/source-identity.mjs";
import { inspectBundle } from "./lib/release-artifact.mjs";
import {
  assertMigrationParity,
  releaseBudget,
  reportedUploadVersion,
  requireSameDeployment,
  requireSameSource,
  resolveRollback,
  RELEASE_BUDGET_SECONDS,
  singleServingVersion,
} from "./lib/routine-release.mjs";
import { readLiveHome, verifyLive } from "./test-deployed.mjs";

if (process.argv.length !== 2) throw new Error("Usage: pnpm deploy:production");

const started = performance.now();
const signal = AbortSignal.timeout(RELEASE_BUDGET_SECONDS * 1000);
const config = "wrangler.production.jsonc";
const wrangler = path.resolve("node_modules/.bin/wrangler");
const exec = promisify(execFile);
const timings = {};
const env = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  FORCE_COLOR: "0",
};
const localEnv = readVarFile(".env");
for (const [local, target] of [
  ["CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"],
  ["CF_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"],
]) {
  if (!env[target] && localEnv.has(local)) env[target] = localEnv.get(local);
}

const elapsed = () => (performance.now() - started) / 1000;

async function command(label, executable, args) {
  signal.throwIfAborted();
  try {
    const { stdout } = await exec(executable, args, { env, signal, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    if (signal.aborted)
      throw new Error(`${label} exceeded the ${RELEASE_BUDGET_SECONDS}s release budget.`);
    throw new Error(`${label} failed (exit ${error.code ?? error.signal ?? "unknown"}).`, {
      cause: error,
    });
  }
}

async function timed(name, action) {
  const phaseStarted = elapsed();
  try {
    return await action();
  } finally {
    timings[`${name}_seconds`] = Number((elapsed() - phaseStarted).toFixed(1));
    console.log(`${name} ${timings[`${name}_seconds`]}s`);
  }
}

async function activeDeployment() {
  const output = await command("Read production deployment", wrangler, [
    "deployments",
    "list",
    "--config",
    config,
    "--json",
  ]);
  const deployments = JSON.parse(output.slice(output.indexOf("[")));
  if (!Array.isArray(deployments) || !deployments.length)
    throw new Error("Production deployments are unreadable.");
  return deployments.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
}

async function productionSchema() {
  const output = await command("Read production migrations", wrangler, [
    "d1",
    "execute",
    "foilbury",
    "--remote",
    "--config",
    config,
    "--json",
    "--command",
    "SELECT name FROM d1_migrations ORDER BY id;",
  ]);
  const data = JSON.parse(output.slice(output.indexOf("[")));
  if (
    !Array.isArray(data) ||
    data.length !== 1 ||
    !data[0].success ||
    !Array.isArray(data[0].results)
  ) {
    throw new Error("Production migrations are unreadable.");
  }
  const local = fs
    .readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return assertMigrationParity(
    local,
    data[0].results.map((row) => row.name),
  );
}

async function requireMain(sha) {
  const output = await command("Read origin/main", "git", [
    "ls-remote",
    "origin",
    "refs/heads/main",
  ]);
  if (output.split(/\s+/)[0] !== sha) throw new Error("Release requires the current origin/main.");
}

async function productionState() {
  const [deployment, schema, home] = await Promise.all([
    activeDeployment(),
    productionSchema(),
    readLiveHome({ signal }),
  ]);
  if (!/^[a-f0-9]{40}$/.test(home.build ?? ""))
    throw new Error("Production build identity is missing.");
  return { deployment, schema, build: home.build };
}

async function waitForBuild(sha) {
  while (!signal.aborted) {
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const home = await readLiveHome({ signal: attempt }).catch(() => null);
    if (home?.build === sha) return home;
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
  throw new Error("Expected build did not answer before the release deadline.");
}

const source = sourceState();
if (source.dirty) throw new Error("Release requires a clean checkout.");
const [before] = await Promise.all([productionState(), requireMain(source.sha)]);
const rollback = resolveRollback(before.deployment);
await command("Check deployed source ancestry", "git", [
  "merge-base",
  "--is-ancestor",
  before.build,
  source.sha,
]);

await timed("build", () =>
  command("Build production artifact", process.execPath, ["scripts/build-production.mjs"]),
);
const [current] = await Promise.all([productionState(), requireMain(source.sha)]);
requireSameSource(source, sourceState());
requireSameDeployment(before.deployment, current.deployment);
if (current.build !== before.build) throw new Error("Production build changed during release.");
assertMigrationParity(before.schema, current.schema);
const bundle = inspectBundle({
  treeHash: source.tree_hash,
  contentHash: source.content_hash,
  sha: source.sha,
});
if (elapsed() > RELEASE_BUDGET_SECONDS - 45) {
  throw new Error(
    `Release preparation took ${elapsed().toFixed(1)}s. The last 45s are reserved for upload and live verification.`,
  );
}

let deployedVersion = null;
let deployment = null;
let smoke = null;
let failure = null;
try {
  const output = await timed("deploy", () =>
    command("Upload production Worker", wrangler, [
      "deploy",
      "--config",
      config,
      "--var",
      `FOILBURY_BUILD_SHA:${source.sha}`,
    ]),
  );
  deployedVersion = reportedUploadVersion(output);
  if (!deployedVersion) throw new Error("Wrangler did not report a unique uploaded version.");
  await timed("verify", async () => {
    const [observed, home] = await Promise.all([activeDeployment(), waitForBuild(source.sha)]);
    deployment = observed;
    if (singleServingVersion(deployment) !== deployedVersion)
      throw new Error("Uploaded version is not the sole serving version.");
    smoke = await verifyLive({ home, expectedBuild: source.sha, signal });
    requireSameDeployment(deployment, await activeDeployment());
  });
} catch (error) {
  failure = error.message;
}

const budget = { ...releaseBudget(elapsed()), ...timings };
const verified = failure === null && budget.within_budget;
const dir = ".foilbury/evidence";
const file = path.join(dir, `release-receipt-${source.sha.slice(0, 12)}-${randomUUID()}.json`);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  file,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      source_sha: source.sha,
      deployment_version: deployedVersion,
      deployment,
      previous_deployment: before.deployment,
      rollback,
      migrations: before.schema,
      artifact_sha256: bundle.artifact.sha256,
      smoke,
      verified,
      verification_scope: "deployment identity and read-only HTTP smoke",
      product_acceptance: "not_assessed",
      unverified_reason: failure ?? (verified ? null : "Exceeded the release budget."),
      elapsed_seconds: budget.elapsed_seconds,
      budget,
    },
    null,
    2,
  ),
  { flag: "wx", mode: 0o600 },
);
if (!verified) {
  throw new Error(
    `Release unverified after ${budget.elapsed_seconds}s: ${failure ?? "Exceeded the release budget."} Inspect production before retrying. Receipt: ${file}`,
  );
}
console.log(
  `Production verified: ${source.sha} / ${deployedVersion} in ${budget.elapsed_seconds}s. Receipt: ${file}`,
);
