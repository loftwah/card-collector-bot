#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readVarFile, ROOT } from "./lib/local.mjs";

const json = process.argv.includes("--json");
const checks = { missing: [], configured: [], locallyVerified: [], liveVerified: [], unverified: [] };
const add = (bucket, name, detail) => checks[bucket].push({ name, detail });

function command(bin, args, options = {}) {
  return spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", ...options });
}
function readNames(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith("#")).map((line) => line.split("=")[0].trim());
}
function values(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0 && !line.trimStart().startsWith("#")) map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return map;
}
function localQuery(sql) {
  const emptyEnv = path.join(ROOT, ".foilbury/empty.env");
  fs.mkdirSync(path.dirname(emptyEnv), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(emptyEnv)) fs.writeFileSync(emptyEnv, "# empty\n", { mode: 0o600 });
  const result = command(path.join(ROOT, "node_modules/.bin/wrangler"), ["d1", "execute", "DB", "--local", "--command", sql, "--json", "--env-file", emptyEnv]);
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)[0]?.results?.[0] ?? null; } catch { return null; }
}

const node = process.version.replace(/^v/, "");
const pnpmResult = command("pnpm", ["--version"]);
const pnpm = (pnpmResult.stdout || "").trim();
const nodeOk = /^22\.(2[3-9]|[3-9][0-9])\./.test(node) || /^24\.(2[2-9]|[3-9][0-9])\./.test(node);
if (nodeOk) add("locallyVerified", "Node toolchain", `v${node}`);
else add("missing", "Node toolchain", `v${node}; expected 22.23.4+ or a compatible supported release`);
if (pnpm.startsWith("10.")) add("locallyVerified", "pnpm toolchain", pnpm);
else add("missing", "pnpm toolchain", pnpm || "pnpm not found");
if (fs.existsSync(path.join(ROOT, "pnpm-lock.yaml"))) add("locallyVerified", "Lockfile", "pnpm-lock.yaml present");
else add("missing", "Lockfile", "pnpm-lock.yaml missing");

const envNames = readNames(path.join(ROOT, ".env"));
const envValues = values(path.join(ROOT, ".env"));
const configuredNames = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "CF_ACCESS_KEY_ID", "CF_SECRET_ACCESS_KEY", "CF_S3_API_ENDPOINT", "FAL_AI_API_KEY", "ELEVENLABS_API_KEY", "RESEND_API_KEY", "RESEND_FROM_ADDRESS", "ADMIN_DISCORD_WEBHOOK_URL", "DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY"];
for (const name of configuredNames) {
  if (envValues.get(name)) add("configured", name, "present in private .env; value not read into this report");
  else if (name === "RESEND_FROM_ADDRESS") add("missing", name, "expected foilbury@loftwah.com");
  else add("missing", name, "not set in private .env");
}
const canonical = envValues.get("ADMIN_DISCORD_WEBHOOK_URL") ?? "";
const alias = envValues.get("DISCORD_WEBHOOK_URL") ?? "";
if (canonical && alias && canonical !== alias) add("missing", "Admin webhook alias", "canonical and alias are both set to different values; resolve explicitly");
else if (canonical) add("locallyVerified", "Admin webhook name", "ADMIN_DISCORD_WEBHOOK_URL is canonical; value not printed");
else if (alias) add("unverified", "Admin webhook name", "only the migration alias is set; setup can migrate it safely");
else add("missing", "Admin webhook name", "no admin webhook configured (optional)");

const devVars = readVarFile(path.join(ROOT, ".dev.vars"));
if (fs.existsSync(path.join(ROOT, ".dev.vars"))) {
  const mode = fs.statSync(path.join(ROOT, ".dev.vars")).mode & 0o777;
  add(mode === 0o600 ? "locallyVerified" : "missing", ".dev.vars permissions", mode.toString(8));
  add(devVars.get("FOILBURY_LOCAL_MODE") === "true" ? "locallyVerified" : "missing", "Local mode", "explicit FOILBURY_LOCAL_MODE=true");
  add(devVars.get("FOILBURY_SESSION_SECRET") ? "locallyVerified" : "missing", "Session secret", "present, value not printed");
  add(devVars.get("FOILBURY_AGENT_TOKEN_PEPPER") ? "locallyVerified" : "missing", "Agent token pepper", "present, value not printed");
  add(devVars.get("EMDASH_ENCRYPTION_KEY")?.startsWith("emdash_enc_v1_") ? "locallyVerified" : "missing", "EmDash encryption key", "valid-format key present, value not printed");
} else add("missing", ".dev.vars", "run pnpm setup:local");

for (const file of [".env", ".dev.vars", ".foilbury", "public/cards", "node_modules"]) {
  const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  if (file.startsWith(".foilbury") ? gitignore.includes(".foilbury") : gitignore.includes(file)) add("locallyVerified", `Ignore ${file}`, "present in .gitignore");
  else add("missing", `Ignore ${file}`, "not covered by .gitignore");
}

const schema = localQuery("SELECT value FROM fb_schema_meta WHERE key = 'domain_schema_version'");
if (schema?.value) add("locallyVerified", "D1 domain schema", `version ${schema.value}`);
else add("missing", "D1 domain schema", "local migrations not applied");
const tenant = localQuery("SELECT COUNT(*) AS count FROM fb_tenants");
if (tenant?.count > 0) add("locallyVerified", "Local tenant bootstrap", `${tenant.count} tenants`);
else add("missing", "Local tenant bootstrap", "run pnpm setup:local");
const release = localQuery("SELECT version, checksum FROM fb_catalogue_releases WHERE status = 'active' ORDER BY version DESC LIMIT 1");
if (release?.version) add("locallyVerified", "Catalogue release", `v${release.version} ${String(release.checksum).slice(0, 12)}…`);
else add("unverified", "Catalogue release", "no active release; publish when the catalogue is ready");
const emdash = localQuery("SELECT COUNT(*) AS count FROM users");
if (emdash?.count > 0) add("locallyVerified", "EmDash owner", `${emdash.count} local CMS user(s)`);
else add("unverified", "EmDash owner", "CMS setup/dev bypass not completed");

const setup = fs.existsSync(path.join(ROOT, ".foilbury/setup.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, ".foilbury/setup.json"), "utf8")) : null;
const url = setup?.url ?? process.env.FOILBURY_URL ?? "http://127.0.0.1:4321";
try {
  const response = await fetch(`${url}/api/v1/status`, { signal: AbortSignal.timeout(1500) });
  const status = await response.json();
  add(response.ok ? "locallyVerified" : "missing", "Local server", `${url} · HTTP ${response.status} · configured=${status.configured}`);
  if (status.providers?.discordApplication) add("configured", "Discord application", "ID/public key retained; Discord disabled");
  if (status.providers?.discordBot) add("configured", "Discord bot token", "present; not used");
  add("unverified", "Discord delivery", "not connected; no live check");
  add("unverified", "Email delivery", "local outbox only; no send performed");
  add("unverified", "Image generation", "no recorded ceiling; no billed job submitted");
} catch {
  add("missing", "Local server", `not reachable at ${url}; run pnpm dev`);
}

const result = {
  generatedAt: new Date().toISOString(),
  url,
  toolchain: { node: node, pnpm },
  checks,
  note: "Default checks are local and read-only. No Cloudflare, Discord, email or generation request was made. Provider presence does not imply live verification.",
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`Foilbury doctor · ${url}`);
  console.log(`  Node ${node} · pnpm ${pnpm}\n`);
  for (const [bucket, label] of [["missing", "Missing"], ["configured", "Configured"], ["locallyVerified", "Locally verified"], ["liveVerified", "Live verified"], ["unverified", "Unverified"]]) {
    console.log(`${label}:`);
    if (!checks[bucket].length) console.log("  — none");
    for (const check of checks[bucket]) console.log(`  ${check.name.padEnd(26)} ${check.detail}`);
    console.log("");
  }
  console.log("No secrets were printed. Default checks are local and read-only.");
}
process.exit(checks.missing.some((check) => ["Node toolchain", "pnpm toolchain", "D1 domain schema", "Local tenant bootstrap", ".dev.vars"].includes(check.name)) ? 1 : 0);
