#!/usr/bin/env node
/**
 * Production release entrypoint with an enforceable source/build/evidence gate.
 *
 *   pnpm build
 *   node scripts/deploy-production.mjs --check   # validate, do not upload
 *   node scripts/deploy-production.mjs           # build + deploy (approval-gated)
 *
 * The gate refuses:
 * - a dirty, unpushed or behind source tree;
 * - a dist artifact whose build stamp does not match the reviewed tree;
 * - missing, stale or cross-tree acceptance evidence;
 * - failed or missing required checks;
 * - an unreadable production migration state;
 * - a deployment whose identity cannot be verified after upload.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";
import {
  readJson,
  sha256File,
  sourceState,
  sourceTreeHash,
} from "./lib/source-identity.mjs";
import { inspectBundle } from "./lib/release-artifact.mjs";
import {
  evidenceSummary,
  validateReleaseEvidence,
} from "./lib/release-evidence.mjs";
import {
  changedPaths,
  evidenceArtifacts,
  requireScopeEvidence,
  resolveRollback,
  scopeForPaths,
  verifyFreshRemote,
} from "./lib/release-scope.mjs";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const config = "wrangler.production.jsonc";
const evidenceDir = path.join(ROOT, ".foilbury", "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

function capture(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
  return result.status ?? 1;
}

function cloudflareEnv() {
  const env = { ...process.env };
  try {
    const file = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const token = file.match(/^CF_API_TOKEN=(.*)$/m)?.[1]?.trim();
    const account = file.match(/^CF_ACCOUNT_ID=(.*)$/m)?.[1]?.trim();
    if (token && !env.CLOUDFLARE_API_TOKEN) env.CLOUDFLARE_API_TOKEN = token;
    if (account && !env.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = account;
  } catch {
    // No local file: use the caller's environment.
  }
  return env;
}

function localMigrations() {
  return fs
    .readdirSync(path.join(ROOT, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function migrationState(env) {
  let remote = null;
  let error = null;
  try {
    const output = capture(
      path.join(ROOT, "node_modules/.bin/wrangler"),
      [
        "d1",
        "execute",
        "foilbury",
        "--remote",
        "--config",
        config,
        "--json",
        "--command",
        "SELECT name FROM d1_migrations ORDER BY id;",
      ],
      { env },
    );
    const parsed = JSON.parse(output.slice(output.indexOf("[")));
    remote = (parsed?.[0]?.results ?? []).map((row) => row.name);
  } catch (cause) {
    error = String(cause?.message ?? cause);
    remote = null;
  }
  const local = localMigrations();
  const pending = remote ? local.filter((name) => !remote.includes(name)) : null;
  return { local, remote, pending, error };
}

function deploymentList(env) {
  try {
    const output = capture(
      path.join(ROOT, "node_modules/.bin/wrangler"),
      ["deployments", "list", "--config", config, "--json"],
      { env },
    );
    const parsed = JSON.parse(output.slice(output.indexOf("[")));
    return Array.isArray(parsed)
      ? [...parsed].sort(
          (left, right) => Date.parse(right.created_on ?? 0) - Date.parse(left.created_on ?? 0),
        )
      : [];
  } catch {
    return null;
  }
}

const env = cloudflareEnv();

// Read a fresh remote ref. Local origin/main is a cache and may be stale; the
// reviewed source must match the branch as it exists now, not as it existed
// when this checkout last fetched.
let fetchedAt = null;
let remoteSha = null;
try {
  capture("git", ["fetch", "--no-tags", "--quiet", "origin", "main"]);
  fetchedAt = new Date().toISOString();
  remoteSha = capture("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0] ?? null;
} catch (error) {
  console.error(`Refusing release: the remote main ref could not be fetched. ${String(error?.message ?? error)}`);
  process.exit(2);
}

const source = sourceState();
try {
  verifyFreshRemote({
    localOriginMain: source.origin_main,
    remoteSha,
    fetchedAt,
  });
} catch (error) {
  console.error(`Refusing release: ${error.message}`);
  process.exit(2);
}
if (source.dirty) {
  console.error("Refusing release from a dirty working tree. Commit or stash the listed changes after review.");
  console.error(source.dirty);
  process.exit(2);
}
if (source.ahead === null || source.behind === null || !source.origin_main) {
  console.error("Refusing release: origin/main is not readable, so review and push state cannot be proven.");
  process.exit(2);
}
if (source.ahead !== 0) {
  console.error(`Refusing release: HEAD is ${source.ahead} commit(s) ahead of origin/main. Push and review first.`);
  process.exit(2);
}
if (source.behind !== 0) {
  console.error(`Refusing release: HEAD is ${source.behind} commit(s) behind origin/main. Reconcile first.`);
  process.exit(2);
}
const treeHash = sourceTreeHash();
if (treeHash !== source.tree_hash) throw new Error("Source tree changed during the release check.");

let evidence;
try {
  evidence = validateReleaseEvidence({ treeHash, contentHash: source.content_hash });
} catch (error) {
  console.error(`Refusing release: ${error.message}`);
  process.exit(2);
}

if (!checkOnly) {
  const status = run("pnpm", ["build"]);
  if (status !== 0) process.exit(status);
}
const bundle = inspectBundle({ treeHash, contentHash: source.content_hash, sha: source.sha });
const migrations = migrationState(env);
const previous = deploymentList(env);
let rollback;
try {
  rollback = resolveRollback(previous);
} catch (error) {
  console.error(`Refusing release: ${error.message}`);
  process.exit(2);
}

function previousReleaseSha() {
  const receipts = fs
    .readdirSync(evidenceDir)
    .filter((name) => /^release-receipt-.*\.json$/.test(name))
    .map((name) => {
      const file = path.join(evidenceDir, name);
      try {
        const value = readJson(file);
        return { file, value };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.value.generated_at ?? 0) - Date.parse(left.value.generated_at ?? 0));
  return receipts[0]?.value?.source_sha ?? null;
}

const previousSha = previousReleaseSha();
const scope = scopeForPaths(
  previousSha
    ? changedPaths({ from: previousSha, capture })
    : capture("git", ["show", "--name-only", "--pretty=format:", "HEAD"])
        .split(/\r?\n/)
        .filter(Boolean),
);
let scopeEvidence;
try {
  scopeEvidence = requireScopeEvidence(scope, evidence.criteria);
} catch (error) {
  console.error(`Refusing release: ${error.message}`);
  process.exit(2);
}
const artifacts = evidenceArtifacts(evidence.criteria);

if (migrations.remote === null) {
  console.error("Refusing release: production migration state could not be read.");
  if (migrations.error) console.error(migrations.error);
  process.exit(2);
}
if (migrations.pending?.length) {
  console.error(
    `Refusing release: ${migrations.pending.length} local migration(s) are not applied in production: ${migrations.pending.join(", ")}.`,
  );
  console.error("Take the JSON D1 backup, apply the reviewed migration, and re-run the release check.");
  process.exit(2);
}

const plan = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  mode: checkOnly ? "check" : "deploy",
  source,
  remote: { fetched_at: fetchedAt, sha: remoteSha },
  tree_hash: treeHash,
  scope,
  scope_evidence: scopeEvidence,
  evidence: evidenceSummary(evidence),
  evidence_artifacts: artifacts,
  bundle,
  migrations,
  previous_deployment: previous?.[0] ?? null,
  rollback,
  environment: "production",
  origin: "https://foilbury.loftwah.com",
  config,
  gates: {
    clean_tree: true,
    pushed_source: true,
    fresh_remote_ref: true,
    source_build_bound: true,
    complete_artifact_digest: true,
    acceptance_evidence_current: true,
    required_checks_passed: true,
    affected_scope_evidence: true,
    local_env_excluded: true,
    secret_markers_absent: true,
    migrations_readable: true,
    pending_migrations: [],
    rollback_target_verified: true,
    deployment_requires_owner_approval: true,
  },
};

const planFile = path.join(evidenceDir, `release-plan-${source.sha.slice(0, 12)}.json`);
fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));
console.log(`Release plan written to ${path.relative(ROOT, planFile)}`);

if (checkOnly) {
  console.log("Release check passed. No deployment or production mutation was performed.");
  process.exit(0);
}

const deployStatus = run(path.join(ROOT, "node_modules/.bin/wrangler"), [
  "deploy",
  "--config",
  config,
  "--var",
  `FOILBURY_BUILD_SHA:${source.sha}`,
]);
if (deployStatus !== 0) {
  console.error(`wrangler deploy failed with exit ${deployStatus}; no release receipt claims success.`);
  process.exit(deployStatus);
}

const after = deploymentList(env);
const deployed = after?.[0] ?? null;
const deployedVersion = deployed?.versions?.[0]?.version_id ?? null;

// A read-only smoke run is bound to the exact source SHA through the public
// x-foilbury-build header. No draw, grant, message or content mutation.
const smokeEnv = { ...env, FOILBURY_URL: plan.origin, FOILBURY_EXPECTED_BUILD: source.sha };
const smokeStatus = run("node", ["scripts/test-deployed.mjs"], { env: smokeEnv });
let smoke = null;
const smokeFile = path.join(evidenceDir, "deployed-smoke.json");
if (fs.existsSync(smokeFile)) {
  smoke = { path: path.relative(ROOT, smokeFile), sha256: sha256File(smokeFile), results: readJson(smokeFile) };
}

const verified = Boolean(deployedVersion) && smokeStatus === 0;
const receipt = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  source_sha: source.sha,
  source_tree_hash: treeHash,
  branch: source.branch,
  origin: plan.origin,
  environment: "production",
  scope,
  remote: plan.remote,
  build: {
    bundle_sha256: bundle.sha256,
    artifact_sha256: bundle.artifact.sha256,
    artifact_files: bundle.artifact.file_count,
    bytes: bundle.bytes,
    built_at: bundle.build.built_at,
    build_nonce: bundle.build.build_nonce,
  },
  migrations,
  acceptance: plan.evidence,
  evidence_artifacts: artifacts,
  deployment: deployed ?? "unknown",
  deployment_version: deployedVersion,
  deployment_status: deployedVersion ? "reported" : "unverified",
  previous_deployment: previous?.[0] ?? null,
  rollback,
  smoke,
  verified,
  unverified_reason: verified
    ? null
    : "Deployment metadata or the build-bound production smoke did not verify.",
};
const receiptFile = path.join(evidenceDir, `release-receipt-${source.sha.slice(0, 12)}.json`);
fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
console.log(`Release receipt written to ${path.relative(ROOT, receiptFile)}`);

if (!verified) {
  console.error(
    "Release outcome is UNVERIFIED. Do not claim deployed acceptance; inspect the receipt and production read-back.",
  );
  process.exit(3);
}
console.log("Release verified: source, artifact, deployment and build-bound smoke agree.");
