#!/usr/bin/env node
/**
 * Temporary, least-privilege Cloudflare Access service token for the headless
 * content import. It is attached only to the "Foilbury Admin API" app, expires
 * in 24 hours, and is removed after the import. The Worker still requires the
 * scoped Foilbury agent token and re-validates it.
 *
 *   node scripts/provision-access-service-token.mjs --apply
 *   node scripts/provision-access-service-token.mjs --cleanup
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
if (!account || !token) throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required.");
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const stateFile = path.join(process.cwd(), ".foilbury", "access-service-token.json");
const apply = process.argv.includes("--apply");
const cleanup = process.argv.includes("--cleanup");

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, { headers, ...options });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error(`${response.status} ${JSON.stringify(body.errors)}`);
  return body.result;
}

if (cleanup) {
  if (!fs.existsSync(stateFile)) throw new Error("No service-token state file.");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  await api(`/access/apps/${state.app_id}/policies/${state.policy_id}`, { method: "DELETE" }).catch(() => undefined);
  await api(`/access/service_tokens/${state.token_id}`, { method: "DELETE" }).catch(() => undefined);
  fs.rmSync(stateFile, { force: true });
  console.log(JSON.stringify({ cleaned: true, app_id: state.app_id, token_id: state.token_id }, null, 2));
  process.exit(0);
}

const apps = await api("/access/apps");
const app = apps.find((item) => item.name === "Foilbury Admin API");
if (!app) throw new Error("Foilbury Admin API Access app not found.");

if (!apply) {
  console.log(JSON.stringify({ dry_run: true, app: { id: app.id, name: app.name, domain: app.domain }, duration: "24h", policy: "non_identity service token" }, null, 2));
  process.exit(0);
}

const serviceToken = await api("/access/service_tokens", {
  method: "POST",
  body: JSON.stringify({ name: `foilbury-content-import-${new Date().toISOString().slice(0, 10)}`, duration: "24h" }),
});
const policy = await api(`/access/apps/${app.id}/policies`, {
  method: "POST",
  body: JSON.stringify({
    name: "Temporary content import service token",
    decision: "non_identity",
    include: [{ service_token: { token_id: serviceToken.id } }],
    require: [],
  }),
});
const state = {
  created_at: new Date().toISOString(),
  app_id: app.id,
  app_name: app.name,
  policy_id: policy.id,
  token_id: serviceToken.id,
  client_id: serviceToken.client_id,
  client_secret: serviceToken.client_secret,
  expires_at: serviceToken.expires_at,
};
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
fs.chmodSync(stateFile, 0o600);
console.log(JSON.stringify({ created: true, output: stateFile, app: app.domain, token_id: state.token_id, expires_at: state.expires_at }, null, 2));
