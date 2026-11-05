#!/usr/bin/env node
/**
 * Production corrective release entrypoint.
 * `node scripts/deploy-production.mjs --technical --check` runs a fresh,
 * isolated qualification and read-only production checks without uploading.
 * Omitting --check is deployment and remains approval-gated. The exact tested
 * artifact is used without rebuilding. This never asserts product acceptance.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { ROOT } from "./lib/local.mjs";
import {
  readJson,
  sha256File,
  sourceState,
  sourceTreeHash,
} from "./lib/source-identity.mjs";
import { inspectBundle } from "./lib/release-artifact.mjs";
import { readPostPropagationBaseline } from "./lib/post-propagation-baseline.mjs";
import { validateTechnicalReceipt, priorVerifiedSource, requireCorrectivePaths, assertRegularArtifactTree, TECHNICAL_IMAGE, requireUnchangedMigrations, singleServingVersion, reportedUploadVersion, requireSameSource, requireSameDeployment, TECHNICAL_PRIOR_RECEIPT_SHA256 } from "./lib/technical-release-receipt.mjs";
import {
  changedPaths,
  resolveRollback,
  scopeForPaths,
  verifyFreshRemote,
} from "./lib/release-scope.mjs";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
if([...args].some(arg=>!["--check","--technical"].includes(arg)) || !args.has("--technical")) {
  console.error("Legacy acceptance recording is held. Use --technical for a fresh supervised run in this process.");
  process.exit(2);
}
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
    if(!Array.isArray(parsed) || parsed.length!==1 || parsed[0]?.success!==true || !Array.isArray(parsed[0]?.results) || parsed[0].results.some(row=>typeof row?.name!=="string")) throw new Error("Unexpected D1 migration response.");
    remote = parsed[0].results.map((row) => row.name);
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

// Run the fixed offline supervisor synchronously in this release process.
// A pre-existing receipt, even a signed one, cannot substitute for execution.
let technicalFile,technicalDigest,technical,bundle;
try {
  const output=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["scripts/technical-release-supervisor.mjs",TECHNICAL_IMAGE],{cwd:ROOT,stdio:["ignore","pipe","inherit"]});
    let collected="";
    child.stdout.on("data",chunk=>{ const text=String(chunk); process.stdout.write(text); collected+=text; if(collected.length>1_000_000) child.kill("SIGTERM"); });
    child.on("error",reject);
    child.on("exit",(code,signal)=>code===0&&!signal?resolve(collected):reject(new Error("Fresh supervised qualification failed.")));
  });
  const line=output.trim().split("\n").at(-1)??"";
  const match=line.match(/^Technical candidate receipt: (.+) · sha256 ([a-f0-9]{64})$/);
  if(!match) throw new Error("Supervisor did not return an exact candidate receipt.");
  [,technicalFile,technicalDigest]=match;
  requireSameSource(source,sourceState());
  technical=validateTechnicalReceipt({file:technicalFile,receiptSha256:technicalDigest,source});
  bundle=technical.artifact;
} catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }
const migrations = migrationState(env);
const previous = deploymentList(env);
let rollback;
try {
  rollback = resolveRollback(previous);
  if(singleServingVersion(previous?.[0])!==rollback.version_id.toLowerCase()) throw new Error("Rollback target is not the sole serving version.");
} catch (error) {
  console.error(`Refusing release: ${error.message}`);
  process.exit(2);
}

function previousReleaseReceipts() {
  const receipts = fs
    .readdirSync(evidenceDir)
    .filter((name) => /^release-receipt-.*\.json$/.test(name))
    .map((name) => {
      const file = path.join(evidenceDir, name);
      try {
        if(fs.lstatSync(file).isSymbolicLink() || sha256File(file)!==TECHNICAL_PRIOR_RECEIPT_SHA256) return null;
        const value = readJson(file);
        return { file, value };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.value.generated_at ?? 0) - Date.parse(left.value.generated_at ?? 0));
  return receipts.map(entry=>entry.value);
}

const priorReceipts=previousReleaseReceipts();
async function readLiveSource() {
  const response=await fetch('https://foilbury.loftwah.com/',{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'cache-control':'no-cache'}});
  if(response.status!==200) throw new Error('Production source read-back failed.');
  return response.headers.get('x-foilbury-build');
}
// Only this pinned release may use the supplemental path; all other versions
// retain the original verified-receipt gate.
if(rollback.version_id.toLowerCase()==='1bf907c5-ee50-48c4-8dd5-bbedf3eb2896') {
  try { priorReceipts.push(readPostPropagationBaseline(evidenceDir,previous?.[0],await readLiveSource())); }
  catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }
}
let previousSha;
try {
  previousSha=priorVerifiedSource(priorReceipts,rollback.version_id);
  capture("git",["merge-base","--is-ancestor",previousSha,source.sha]);
} catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }
const scope = scopeForPaths(
  previousSha
    ? changedPaths({ from: previousSha, capture })
    : capture("git", ["show", "--name-only", "--pretty=format:", "HEAD"])
        .split(/\r?\n/)
        .filter(Boolean),
);
let scopeEvidence;
try {
  scopeEvidence = {criteria:["technical-candidate"],files:requireCorrectivePaths(scope.files),product_acceptance:"not_claimed"};
} catch (error) {
  console.error(`Refusing release: ${error.message}`);
  process.exit(2);
}
const artifacts = [{path:path.resolve(technicalFile),sha256:technicalDigest}];

try { requireUnchangedMigrations(migrations.local,migrations.remote,priorReceipts,rollback.version_id); }
catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }

function recheckProductionState() {
  const refreshed=capture("git",["ls-remote","origin","refs/heads/main"]).split(/\s+/)[0];
  verifyFreshRemote({localOriginMain:source.origin_main,remoteSha:refreshed,fetchedAt:new Date().toISOString()});
  requireSameSource(source,sourceState());
  const latest=deploymentList(env);
  requireSameDeployment(previous?.[0],latest?.[0]);
  const currentMigrations=migrationState(env);
  requireUnchangedMigrations(currentMigrations.local,currentMigrations.remote,priorReceipts,rollback.version_id);
  validateTechnicalReceipt({file:technicalFile,receiptSha256:technicalDigest,source});
}
try { recheckProductionState(); if(priorReceipts.some(r=>r.kind==='post-propagation-baseline')) readPostPropagationBaseline(evidenceDir,deploymentList(env)?.[0],await readLiveSource()); }
catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }
const runId=randomUUID();

const plan = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  mode: checkOnly ? "check" : "deploy",
  source,
  remote: { fetched_at: fetchedAt, sha: remoteSha },
  tree_hash: treeHash,
  scope,
  scope_evidence: scopeEvidence,
  evidence: {kind:"technical-candidate",sha256:technicalDigest,product_acceptance:"not_claimed",live_discord:"not_tested"},
  evidence_artifacts: artifacts,
  bundle,
  migrations,
  previous_deployment: previous?.[0] ?? null,
  baseline_evidence: priorReceipts.filter(r=>r.kind==='post-propagation-baseline'),
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
    acceptance_evidence_current: false,
    technical_evidence_current: true,
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

const planFile = path.join(evidenceDir, `release-plan-${source.sha.slice(0, 12)}-${runId}.json`);
fs.writeFileSync(planFile, JSON.stringify(plan, null, 2),{flag:"wx",mode:0o600});
console.log(JSON.stringify(plan, null, 2));
console.log(`Release plan written to ${path.relative(ROOT, planFile)}`);

if (checkOnly) {
  console.log("Release check passed. No deployment or production mutation was performed.");
  process.exit(0);
}

if(technical) {
  try {
    // Never overwrite a pre-existing build. A fresh checkout may adopt the
    // qualified artifact; an existing build must already be byte-identical.
    const dest=path.join(ROOT,"dist");
    try { if(fs.lstatSync(dest).isSymbolicLink()) throw new Error("Deployment artifact destination is a symlink."); }
    catch(error) { if(error.code!=="ENOENT") throw error; fs.cpSync(technical.dist,dest,{recursive:true,errorOnExist:true,force:false}); }
    assertRegularArtifactTree(dest);
    const copy=inspectBundle({treeHash,contentHash:source.content_hash,sha:source.sha});
    if(copy.artifact.sha256!==bundle.artifact.sha256 || copy.sha256!==bundle.sha256) throw new Error("Deployment artifact differs from the qualified bytes.");
    validateTechnicalReceipt({file:technicalFile,receiptSha256:technicalDigest,source:sourceState()});
  } catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }
}

// The supervised run can take minutes. Recheck the remote source, current
// Worker and unchanged schema immediately before the upload.
try { recheckProductionState(); if(priorReceipts.some(r=>r.kind==='post-propagation-baseline')) readPostPropagationBaseline(evidenceDir,deploymentList(env)?.[0],await readLiveSource()); }
catch(error) { console.error(`Refusing release: ${error.message}`); process.exit(2); }
const upload=spawnSync(path.join(ROOT,"node_modules/.bin/wrangler"),[
  "deploy","--config",config,"--var",`FOILBURY_BUILD_SHA:${source.sha}`,
],{cwd:ROOT,env:{...env,FORCE_COLOR:"0"},encoding:"utf8",maxBuffer:32*1024*1024});
if (upload.error || upload.status !== 0) {
  console.error(`wrangler deploy failed or was interrupted (${upload.status ?? "unknown"}); inspect production before retrying.`);
  process.exit(3);
}
const uploadedVersion=reportedUploadVersion(upload.stdout);
const after = deploymentList(env);
const deployed = after?.[0] ?? null;
let deployedVersion=null;
try {deployedVersion=singleServingVersion(deployed);} catch { /* reported as unverified */ }
const uploadMatches=Boolean(uploadedVersion && deployedVersion===uploadedVersion);


// A read-only smoke run is bound to the exact source SHA through the public
// x-foilbury-build header. No draw, grant, message or content mutation.
const smokeEnv = { ...env, FOILBURY_URL: plan.origin, FOILBURY_EXPECTED_BUILD: source.sha, FOILBURY_SMOKE_RUN_ID: runId };
const smokeStatus = run("node", ["scripts/test-deployed.mjs"], { env: smokeEnv });
let smoke = null;
const smokeFile = path.join(evidenceDir, `deployed-smoke-${runId}.json`);
if (fs.existsSync(smokeFile)) {
  smoke = { path: path.relative(ROOT, smokeFile), sha256: sha256File(smokeFile), results: readJson(smokeFile) };
}

const postSmoke=deploymentList(env);
let activeAfterSmoke=null;
try {activeAfterSmoke=singleServingVersion(postSmoke?.[0]);} catch { /* reported as unverified */ }
const stableAfterSmoke=Boolean(uploadedVersion && activeAfterSmoke===uploadedVersion && postSmoke?.[0]?.id===deployed?.id);
const verified = uploadMatches && stableAfterSmoke && smokeStatus === 0;
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
  upload_version: uploadedVersion,
  active_version_after_smoke: activeAfterSmoke,
  readback_limit: "The source header and deployment metadata do not independently prove the bytes served to every client; external deployments can race these reads.",
  deployment_status: uploadMatches ? "matched_upload" : "unverified",
  previous_deployment: previous?.[0] ?? null,
  baseline_evidence: plan.baseline_evidence,
  rollback,
  smoke,
  verified,
  unverified_reason: verified
    ? null
    : "Upload version, active deployment, or source-header smoke did not verify. Header readback alone does not establish served artifact bytes.",
};
const receiptFile = path.join(evidenceDir, `release-receipt-${source.sha.slice(0, 12)}-${runId}.json`);
fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2),{flag:"wx",mode:0o600});
console.log(`Release receipt written to ${path.relative(ROOT, receiptFile)}`);

if (!verified) {
  console.error(
    "Release outcome is UNVERIFIED. Do not claim deployed acceptance; inspect the receipt and production read-back.",
  );
  process.exit(3);
}
console.log("Technical release verified: tested upload, active version and source-header smoke agree; served bytes are not independently verified.");
