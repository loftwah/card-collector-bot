#!/usr/bin/env node
/**
 * Provision a scoped Global Collection Admin.
 *
 * Dry run by default. This grants ONLY the scoped platform role; it never
 * creates an account, merges identities, changes Super Admin, Access, wallets,
 * inventory or Bot ownership. Re-running is idempotent.
 *
 * Production:
 *   node scripts/provision-scoped-admin.mjs
 *   node scripts/provision-scoped-admin.mjs --apply
 *
 * Local:
 *   node scripts/provision-scoped-admin.mjs --local
 *   node scripts/provision-scoped-admin.mjs --local --apply
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const local = args.includes("--local");
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const email = value("--email", "discord.863331540095467520@players.foilbury.invalid");
const discordId = value("--discord-id", "863331540095467520");
const expectedName = value("--name", "Kaye ⋆˚꩜｡");
const reason = value("--reason", "Owner-approved scoped curation of shared Foilbury collections; no platform root, secrets, Cloudflare or wallet authority.");
const collectionIds = value("--collection-ids", "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
const wrangler = process.platform === "win32" ? "wrangler.cmd" : "npx";
const baseArgs = ["wrangler", "d1", "execute", local ? "foilbury-local" : "foilbury", local ? "--local" : "--remote"];
if (!local) baseArgs.push("--config", "wrangler.production.jsonc");
baseArgs.push("--json");

function query(sql) {
  const output = execFileSync(wrangler, [...baseArgs, "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}

function esc(value) {
  return String(value).replaceAll("'", "''");
}

const user = query(`SELECT id, email, display_name, platform_admin, disabled_at FROM fb_users WHERE email = '${esc(email)}'`)[0];
if (!user) {
  console.error(`No account exists for ${email}. Refusing to invent an identity.`);
  process.exit(1);
}
if (user.email !== email || user.display_name !== expectedName) {
  console.error(`Identity mismatch. Expected ${expectedName} <${email}>, found ${user.display_name} <${user.email}>. Nothing changed.`);
  process.exit(1);
}
if (user.platform_admin) {
  console.error("That account is already a Super Admin. No scoped grant is needed.");
  process.exit(1);
}
if (user.disabled_at) {
  console.error("That account is disabled. Enable it deliberately before assigning a role.");
  process.exit(1);
}
const discord = query(`SELECT discord_user_id, username, revoked_at FROM fb_discord_identities WHERE user_id = '${esc(user.id)}' ORDER BY linked_at DESC LIMIT 1`)[0];
if (!discord || discord.revoked_at || discord.discord_user_id !== discordId) {
  console.error(`The verified Discord identity does not match ${discordId}. Nothing changed.`);
  process.exit(1);
}

const scopes = collectionIds.length ? { all: false, collectionIds } : { all: true, collectionIds: [] };
const scopesJson = JSON.stringify(scopes);
const existing = query(`SELECT id, role, scopes_json, status, granted_at, reason FROM fb_platform_role_assignments WHERE user_id = '${esc(user.id)}' AND role = 'global_collection_admin'`)[0];
const owner = query("SELECT user_id FROM fb_platform_admins WHERE status = 'active' LIMIT 1")[0];
if (!owner) {
  console.error("No active provisioned Super Admin exists. Refusing to create a role without an accountable granter.");
  process.exit(1);
}
const tenant = query(`SELECT tenant_id FROM fb_memberships WHERE user_id = '${esc(user.id)}' AND status = 'active' ORDER BY created_at LIMIT 1`)[0];
const tenantId = tenant?.tenant_id ?? query("SELECT id FROM fb_tenants ORDER BY created_at LIMIT 1")[0]?.id;
if (!tenantId) {
  console.error("No tenant context exists for the audit receipt.");
  process.exit(1);
}
const now = new Date().toISOString();
const stableId = existing?.id ?? `role_kaylee_${user.id.replace(/^usr_/, "")}`;

console.log(JSON.stringify({
  mode: apply ? "APPLY" : "DRY RUN",
  environment: local ? "local" : "production",
  account: { id: user.id, email: user.email, displayName: user.display_name },
  discord: { id: discord.discord_user_id, username: discord.username },
  role: "global_collection_admin",
  scopes,
  existing: existing ? { id: existing.id, status: existing.status, scope: existing.scopes_json, reason: existing.reason } : null,
  willChange: !existing || existing.status !== "active" || existing.scopes_json !== scopesJson,
  authorityExcluded: [
    "Super Admin provisioning",
    "Cloudflare Access, secrets and deployment credentials",
    "Wallet/Foil grants and another member's inventory",
    "Bots outside her own ownership or explicit invitation",
    "Public showcase approval",
  ],
  reason,
}, null, 2));

if (!apply) {
  console.log("\nDry run only. Re-run with --apply after reviewing the scope and reason.");
  process.exit(0);
}

const sql = existing
  ? `UPDATE fb_platform_role_assignments SET scopes_json = '${esc(scopesJson)}', status = 'active', granted_by = '${esc(owner.user_id)}', granted_at = '${now}', reason = '${esc(reason)}', revoked_by = NULL, revoked_at = NULL WHERE id = '${esc(existing.id)}';`
  : `INSERT INTO fb_platform_role_assignments (id, user_id, role, scopes_json, status, granted_by, granted_at, reason) VALUES ('${esc(stableId)}', '${esc(user.id)}', 'global_collection_admin', '${esc(scopesJson)}', 'active', '${esc(owner.user_id)}', '${now}', '${esc(reason)}');`;

query(sql);
query(`INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
       VALUES ('aud_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}', '${esc(tenantId)}', 'system', 'provision-scoped-admin', '${esc(user.id)}', 'platform.role.assigned', 'platform_role', '${esc(stableId)}', '${esc(JSON.stringify({ role: "global_collection_admin", scopes, reason, source: "provision-scoped-admin.mjs" }))}', 'provision-scoped-admin', '${now}');`);
const verified = query(`SELECT id, status, scopes_json, granted_at FROM fb_platform_role_assignments WHERE user_id = '${esc(user.id)}' AND role = 'global_collection_admin'`)[0];
console.log(JSON.stringify({ applied: true, verified }, null, 2));
