#!/usr/bin/env node
/**
 * Trusted production provisioning for a short-lived, scoped content agent.
 * This creates the credential only; all catalogue edits still pass the normal
 * domain services, scopes and audit trail.
 *
 *   node scripts/provision-production-agent.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/local.mjs";

const apply = process.argv.includes("--apply");
const secretsFile = path.join(ROOT, ".foilbury", "production-secrets.json");
const outputFile = path.join(ROOT, ".foilbury", "production-agent.json");
if (!fs.existsSync(secretsFile)) throw new Error("Missing .foilbury/production-secrets.json");
const secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
const pepper = secrets.FOILBURY_AGENT_TOKEN_PEPPER;
if (!pepper) throw new Error("FOILBURY_AGENT_TOKEN_PEPPER is missing from the production secrets file.");

function d1(sql) {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "foilbury", "--remote", "--config", "wrangler.production.jsonc", "--json", "--command", sql],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  return parsed[0]?.results ?? [];
}

const user = d1("SELECT id, email, display_name FROM fb_users WHERE id = 'usr_prod_owner'");
const tenant = d1("SELECT id, slug FROM fb_tenants WHERE slug = 'cabinet'");
if (!user[0] || !tenant[0]) throw new Error("Production owner or cabinet tenant was not found.");
const existing = d1(
  "SELECT g.id, t.prefix FROM fb_agent_grants g LEFT JOIN fb_agent_tokens t ON t.grant_id = g.id WHERE g.agent_name = 'launch-content-2026-11' AND g.status = 'active'",
);
if (existing.length && !process.argv.includes("--rotate")) {
  console.log(JSON.stringify({ status: "exists", grant_id: existing[0].id, prefix: existing[0].prefix, note: "Use --rotate to issue a new token." }, null, 2));
  process.exit(0);
}

const grantId = `agt_${crypto.randomBytes(10).toString("hex")}`;
const agentId = `agent_${crypto.randomBytes(10).toString("hex")}`;
const token = `fba_${crypto.randomBytes(32).toString("base64url")}`;
const tokenHash = crypto.createHmac("sha256", pepper).update(token).digest("hex");
const prefix = token.slice(0, 12);
const scopes = [
  "content:read",
  "content:write",
  "catalogue:publish",
  "import:write",
  "render:write",
  "economy:read",
  "economy:write",
  "economy:grant",
  "inventory:read",
  "settings:write",
  "ops:read",
];
const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
const createdAt = new Date().toISOString();
const sql = `
INSERT INTO fb_agent_grants (id, tenant_id, agent_name, agent_id, represented_user_id, scopes_json, status, expires_at, created_by, created_at)
VALUES ('${grantId}', '${tenant[0].id}', 'launch-content-2026-11', '${agentId}', '${user[0].id}', '${JSON.stringify(scopes)}', 'active', '${expiresAt}', '${user[0].id}', '${createdAt}');
INSERT INTO fb_agent_tokens (id, grant_id, token_hash, prefix, created_at)
VALUES ('tok_${crypto.randomBytes(10).toString("hex")}', '${grantId}', '${tokenHash}', '${prefix}', '${createdAt}');
INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
VALUES ('aud_${crypto.randomBytes(10).toString("hex")}', '${tenant[0].id}', 'system', 'provision-script', '${user[0].id}', 'agent.grant.created', 'agent_grant', '${grantId}', '${JSON.stringify({ agent_name: "launch-content-2026-11", scopes, expires_at: expiresAt })}', 'provision-production-agent', '${createdAt}');
`;
if (!apply) {
  console.log(JSON.stringify({ dry_run: true, grantId, represented: user[0].email, tenant: tenant[0].slug, scopes, expiresAt, sql_preview: sql.slice(0, 200) }, null, 2));
  process.exit(0);
}
d1(sql);
fs.writeFileSync(outputFile, JSON.stringify({ token, grantId, prefix, expiresAt, scopes }, null, 2), { mode: 0o600 });
fs.chmodSync(outputFile, 0o600);
console.log(JSON.stringify({ created: true, output: outputFile, grantId, prefix, expiresAt, scopes }, null, 2));
