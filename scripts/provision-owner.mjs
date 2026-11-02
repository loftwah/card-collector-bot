#!/usr/bin/env node
/**
 * Audited, idempotent production identity migration and Super Admin provisioning.
 *
 * This script refuses to run unless the Discord link, Cloudflare Access identity
 * and Access policy all resolve to the same person. It never prints credentials
 * or session tokens. Run with --apply to mutate production D1.
 *
 *   node scripts/provision-owner.mjs --apply --email dean@deanlofts.xyz
 */
import "dotenv/config";

const apply = process.argv.includes("--apply");
const email = (process.argv.find((arg) => arg.startsWith("--email="))?.split("=")[1] || process.argv[process.argv.indexOf("--email") + 1] || "dean@deanlofts.xyz").trim().toLowerCase();
const userId = "usr_prod_owner";
const discordUserId = "707281352818425929";
const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const databaseId = process.env.FOILBURY_D1_ID || "b67bb3d4-ace6-43f1-821a-f5620936bd3c";
if (!account || !token) throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required.");
const d1 = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`;
const accessBase = `https://api.cloudflare.com/client/v4/accounts/${account}/access`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function query(sql, params = []) {
  const response = await fetch(d1, { method: "POST", headers, body: JSON.stringify({ sql, params }) });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error(`${response.status} ${JSON.stringify(body.errors)}`);
  return body.result?.[0]?.results ?? [];
}
async function cf(path) {
  const response = await fetch(`${accessBase}${path}`, { headers });
  const body = await response.json();
  if (!response.ok || body.success === false) throw new Error(`${response.status} ${JSON.stringify(body.errors)}`);
  return body.result;
}
function say(label, value) {
  console.log(`${apply ? "APPLY" : "CHECK"} ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const userRows = await query("SELECT id, email, display_name, platform_admin, email_verified_at, disabled_at FROM fb_users WHERE id = ?", [userId]);
assert(userRows.length === 1, `Expected exactly one ${userId}; found ${userRows.length}.`);
const before = userRows[0];
say("before account", { id: before.id, email: before.email, display_name: before.display_name, platform_admin: before.platform_admin, email_verified: Boolean(before.email_verified_at) });

const duplicate = await query("SELECT id, email FROM fb_users WHERE lower(email) = lower(?) AND id <> ?", [email, userId]);
assert(duplicate.length === 0, `Another account already uses ${email}: ${duplicate.map((row) => row.id).join(", ")}`);

const discord = await query("SELECT tenant_id, discord_user_id, user_id, revoked_at FROM fb_discord_identities WHERE discord_user_id = ?", [discordUserId]);
assert(discord.length === 1, "The recorded Discord identity is missing or duplicated.");
assert(discord[0].user_id === userId, `Discord ${discordUserId} resolves to ${discord[0].user_id}, not ${userId}.`);
assert(!discord[0].revoked_at, "The Discord identity is revoked.");
say("Discord identity", { discord_user_id: discordUserId, user_id: discord[0].user_id, tenant_id: discord[0].tenant_id });

const accessUsers = await cf(`/users?limit=100`);
const accessUser = accessUsers.find((row) => String(row.email).toLowerCase() === email);
assert(accessUser, `No Cloudflare Access identity exists for ${email}.`);
assert(accessUser.access_seat !== false, "The Access user does not have a seat.");
say("Access identity", { id: accessUser.id, email: accessUser.email, last_successful_login: accessUser.last_successful_login ?? null });

const apps = await cf("/apps");
const relevantApps = apps.filter((app) => ["Foilbury Administration", "Foilbury Admin API", "Foilbury Platform Administration", "Foilbury Platform Admin API", "Foilbury Editorial"].includes(app.name));
assert(relevantApps.length >= 5, `Expected the five Foilbury Access applications; found ${relevantApps.length}.`);
for (const app of relevantApps) {
  const policies = await cf(`/apps/${app.id}/policies`);
  const allowed = policies.some((policy) => policy.decision === "allow" && policy.include?.some((rule) => rule.email?.email?.toLowerCase() === email));
  assert(allowed, `${app.name} does not allow ${email}.`);
}
say("Access policies", relevantApps.map((app) => ({ name: app.name, domain: app.domain })));

const otherSuperAdmins = await query("SELECT id, email FROM fb_users WHERE platform_admin = 1 AND id <> ?", [userId]);
assert(otherSuperAdmins.length === 0, `Another Super Admin exists: ${otherSuperAdmins.map((row) => row.id).join(", ")}`);
const tenant = await query("SELECT id, slug, name FROM fb_tenants WHERE slug = 'cabinet'");
assert(tenant.length === 1, "The cabinet tenant is missing.");
const tenantId = tenant[0].id;
const bot = await query("SELECT id, name, tenant_id FROM fb_bots WHERE tenant_id = ?", [tenantId]);
assert(bot.length === 1, "The cabinet Bot is missing; apply migration 0006 first.");
const membership = await query("SELECT role, status, capabilities_json FROM fb_memberships WHERE tenant_id = ? AND user_id = ?", [tenantId, userId]);
assert(membership.length === 1 && membership[0].role === "owner", "The owner membership is missing.");
say("ownership", { tenant: tenant[0].slug, bot: bot[0].id, membership: membership[0].role, discord: discordUserId });

if (!apply) {
  console.log(JSON.stringify({ ready: true, action: "rerun with --apply" }, null, 2));
  process.exit(0);
}

const now = new Date().toISOString();
await query("UPDATE fb_users SET email = ?, display_name = 'Dean', email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", [email, now, userId]);
await query(
  `INSERT INTO fb_access_emails (email, user_id, added_by, created_at, revoked_at)
   VALUES (?, ?, 'provision-owner.mjs', ?, NULL)
   ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, revoked_at = NULL`,
  [email, userId, now],
);
await query("UPDATE fb_users SET platform_admin = 1 WHERE id = ?", [userId]);
await query(
  `INSERT INTO fb_platform_admins (user_id, provisioned_by, provisioned_at, reason, status, revoked_at)
   VALUES (?, 'provision-owner.mjs', ?, 'Explicit directive: Dean is the sole Foilbury Super Admin after verified Discord, Access identity and account relationship checks.', 'active', NULL)
   ON CONFLICT(user_id) DO UPDATE SET status = 'active', revoked_at = NULL, provisioned_at = excluded.provisioned_at, reason = excluded.reason`,
  [userId, now],
);
await query(
  `UPDATE fb_memberships SET capabilities_json = '["content","publish","economy","members","settings","inventory","grants"]', status = 'active', accepted_at = COALESCE(accepted_at, ?), revoked_at = NULL
   WHERE tenant_id = ? AND user_id = ?`,
  [now, tenantId, userId],
);
for (const [action, objectType, metadata] of [
  ["identity.primary_email.migrated", "user", { before: before.email, after: email, discord_user_id: discordUserId, access_user_id: accessUser.id }],
  ["super_admin.provisioned", "user", { reason: "explicit directive", sole: true }],
]) {
  await query(
    `INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
     VALUES (?, ?, 'system', 'provision-owner.mjs', ?, ?, ?, ?, ?, 'provision-owner', ?)`,
    [`aud_${crypto.randomUUID().slice(0, 18)}`, tenantId, userId, action, objectType, userId, JSON.stringify(metadata), now],
  );
}

const after = (await query("SELECT id, email, display_name, platform_admin, email_verified_at FROM fb_users WHERE id = ?", [userId]))[0];
const access = await query("SELECT id, email, user_id, linked_at, revoked_at FROM fb_access_identities WHERE user_id = ?", [userId]);
const counts = (await query(`SELECT
  (SELECT COUNT(*) FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND status = 'owned') AS owned,
  (SELECT COUNT(*) FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ?) AS ledger,
  (SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?) AS balance,
  (SELECT COUNT(*) FROM fb_platform_admins WHERE status = 'active') AS super_admins`, [tenantId, userId, tenantId, userId, tenantId, userId]))[0];
say("after account", { id: after.id, email: after.email, display_name: after.display_name, platform_admin: after.platform_admin, email_verified: Boolean(after.email_verified_at) });
say("Access identity links", access);
say("preserved ownership", counts);
console.log(JSON.stringify({ ok: true, email, userId, tenantId, botId: bot[0].id, discord_user_id: discordUserId, super_admins: counts.super_admins, access_identity_pending_first_admin_request: access.length === 0 }, null, 2));
