#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  ensureDevVars,
  migrateWebhookAlias,
  readSecretFile,
  startDevServer,
  statePath,
  stopDevServer,
  writeSecretFile,
} from "./lib/local.mjs";

function fail(message) {
  console.error(`\nFoilbury setup: ${message}\n`);
  process.exit(1);
}

const migration = migrateWebhookAlias();
const vars = ensureDevVars();
fs.mkdirSync(path.join(ROOT, ".foilbury"), { recursive: true, mode: 0o700 });
const emptyEnv = path.join(ROOT, ".foilbury/empty.env");
if (!fs.existsSync(emptyEnv)) fs.writeFileSync(emptyEnv, "# intentionally empty; prevents operator dotenv loading\n", { mode: 0o600 });
fs.chmodSync(emptyEnv, 0o600);
const bootstrapToken = vars.get("FOILBURY_BOOTSTRAP_TOKEN");
if (!bootstrapToken) fail("Could not prepare the local bootstrap token.");

const migrate = spawnSync(
  path.join(ROOT, "node_modules/.bin/wrangler"),
  ["d1", "migrations", "apply", "DB", "--local", "--env-file", emptyEnv],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } },
);
if (migrate.status !== 0) fail("Local D1 migrations failed. No remote database was contacted.");

await stopDevServer();
const server = await startDevServer(5173);
const url = `http://127.0.0.1:${server.port}`;

let response;
try {
  response = await fetch(`${url}/api/v1/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-foilbury-bootstrap": bootstrapToken,
    },
    body: "{}",
  });
} catch (error) {
  fail(`Could not reach the local setup endpoint: ${error instanceof Error ? error.message : "unknown error"}`);
}

const payload = await response.json();
if (response.status === 409) {
  const existing = readSecretFile("local-credentials.json");
  console.log("\nFoilbury is already set up. Existing accounts, balances and library were left untouched.");
  console.log(`Local URL: ${url}`);
  if (existing) console.log("Credentials: .foilbury/local-credentials.json");
  process.exit(0);
}
if (!response.ok) {
  fail(payload?.error?.message ?? `Bootstrap failed with HTTP ${response.status}.`);
}

writeSecretFile("local-credentials.json", {
  url,
  createdAt: new Date().toISOString(),
  note: "Local development accounts. Never commit this file or paste its values into a prompt.",
  accounts: payload.accounts,
  tenants: payload.tenants,
});
writeSecretFile("agents.json", {
  url,
  createdAt: new Date().toISOString(),
  note: "Scoped local agent tokens. Keep this file out of version control.",
  agents: payload.agents,
});
writeSecretFile("setup.json", {
  url,
  testedAt: new Date().toISOString(),
  tenant: "cabinet",
  accounts: payload.accounts.map(({ email, role, tenant }) => ({ email, role, tenant })),
  agents: payload.agents.map(({ name, represented, scopes }) => ({ name, represented, scopes })),
  webhookAlias: migration,
});

console.log("\nFoilbury local setup complete.");
console.log(`Local URL:   ${url}`);
console.log("Owner:       owner@foilbury.local");
console.log("Player:      player@foilbury.local");
console.log("Credentials: .foilbury/local-credentials.json  (mode 600, ignored)");
console.log("Agent keys:  .foilbury/agents.json             (mode 600, ignored)");
console.log("No email, Discord, generation or cloud request was made.");

if (!process.argv.includes("--skip-sources")) {
  console.log("\nImporting the curated source selection and rendering card finishes…");
  const imported = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts/sources/import.mjs"), "--apply", "--publish"],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (imported.status !== 0) {
    console.error("\nSource import did not complete. Existing accounts and local state were preserved; core collection commands remain available.");
    process.exit(1);
  }
  console.log("\nCurated imports, layered renders and the catalogue release are ready.");
}
