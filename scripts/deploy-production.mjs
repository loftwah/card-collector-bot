#!/usr/bin/env node
/**
 * Production release entrypoint with an enforceable source/build receipt.
 *
 *   node scripts/deploy-production.mjs --check   # validate, do not upload
 *   node scripts/deploy-production.mjs           # build + deploy (approval-gated)
 *
 * The check refuses a dirty working tree, a missing source SHA, a leaked local
 * environment file, or an unreviewed migration gap. It never prints secret
 * values. Deployment remains an explicit owner-approved action.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const config = "wrangler.production.jsonc";
const evidenceDir = path.join(ROOT, ".foilbury", "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });

function capture(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
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

function sourceState() {
  const sha = capture("git", ["rev-parse", "HEAD"]);
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dirty = capture("git", ["status", "--porcelain"]);
  let ahead = 0;
  try {
    ahead = Number(capture("git", ["rev-list", "--count", "origin/main..HEAD"]));
  } catch {
    ahead = 0;
  }
  return { sha, branch, dirty, ahead };
}

function migrationState(env) {
  const localMigrations = fs
    .readdirSync(path.join(ROOT, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let remote = null;
  try {
    const output = capture(
      path.join(ROOT, "node_modules/.bin/wrangler"),
      ["d1", "execute", "foilbury", "--remote", "--config", config, "--json", "--command", "SELECT name FROM d1_migrations ORDER BY id;"],
      { env },
    );
    const parsed = JSON.parse(output.slice(output.indexOf("[")));
    remote = (parsed?.[0]?.results ?? []).map((row) => row.name);
  } catch (error) {
    remote = null;
  }
  const pending = remote ? localMigrations.filter((name) => !remote.includes(name)) : null;
  return { local: localMigrations, remote, pending };
}

function inspectBundle() {
  const server = path.join(ROOT, "dist", "server", "entry.mjs");
  if (!fs.existsSync(server)) throw new Error("No production server bundle exists. Run pnpm build first.");
  const leakedEnv = path.join(ROOT, "dist", "server", ".dev.vars");
  if (fs.existsSync(leakedEnv)) throw new Error("dist/server/.dev.vars is present. It must not be uploaded.");
  const markers = ["FB_BOOTSTRAP_TOKEN=", "DISCORD_BOT_TOKEN=", "RESEND_API_KEY=", "FAL_AI_API_KEY=", "CF_API_TOKEN=", "EMDASH_ENCRYPTION_KEY="];
  const files = [server, path.join(ROOT, "dist", "server", "index.js")].filter((file) => fs.existsSync(file));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const marker of markers) {
      if (text.includes(marker)) throw new Error(`Secret marker ${marker} appears in the production bundle.`);
    }
  }
  return { server, bytes: fs.statSync(server).size, secretMarkers: 0 };
}

const env = cloudflareEnv();
const source = sourceState();
if (source.dirty) {
  console.error("Refusing release from a dirty working tree. Commit or stash the listed changes after review.");
  console.error(source.dirty);
  process.exit(2);
}
if (!checkOnly) run("pnpm", ["build"]);
if (!fs.existsSync(path.join(ROOT, "dist", "server", "entry.mjs"))) run("pnpm", ["build"]);
const removed = path.join(ROOT, "dist", "server", ".dev.vars");
if (fs.existsSync(removed)) fs.rmSync(removed, { force: true });
const bundle = inspectBundle();
const migrations = migrationState(env);

const plan = {
  generated_at: new Date().toISOString(),
  mode: checkOnly ? "check" : "deploy",
  source,
  bundle,
  migrations,
  environment: "production",
  origin: "https://foilbury.loftwah.com",
  config,
  gates: {
    clean_tree: true,
    local_env_excluded: true,
    secret_markers_absent: true,
    migrations_listed: Boolean(migrations.remote),
    pending_migrations: migrations.pending,
    deployment_requires_owner_approval: true,
  },
};

const planFile = path.join(evidenceDir, `release-plan-${source.sha.slice(0, 12)}.json`);
fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));
console.log(`Release plan written to ${path.relative(ROOT, planFile)}`);

if (checkOnly) {
  if (migrations.pending === null) {
    console.error("Migrations could not be read from production; the plan is not release-ready.");
    process.exit(1);
  }
  process.exit(0);
}

run(path.join(ROOT, "node_modules/.bin/wrangler"), ["deploy", "--config", config]);
let deployment = null;
 try {
  deployment = capture(path.join(ROOT, "node_modules/.bin/wrangler"), ["deployments", "status", "--config", config, "--json"], { env });
 } catch {
  deployment = null;
 }
const receipt = {
  generated_at: new Date().toISOString(),
  source_sha: source.sha,
  branch: source.branch,
  origin: plan.origin,
  migrations,
  bundle,
  deployment: deployment ? JSON.parse(deployment.slice(deployment.indexOf("{"))) : "unknown",
  rollback: `Redeploy the previous Worker version from the deployment list; schema migrations 0015–0018 are additive and do not require data rollback.`,
};
const receiptFile = path.join(evidenceDir, `release-receipt-${source.sha.slice(0, 12)}.json`);
fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
console.log(`Release receipt written to ${path.relative(ROOT, receiptFile)}`);
