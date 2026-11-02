#!/usr/bin/env node
/**
 * Idempotently configure Foilbury's Cloudflare Access applications.
 *
 * Requires CF_ACCOUNT_ID and a token with Access apps/policies/groups/IdP write.
 * Prints public identifiers (app IDs and AUD values) only. It never prints tokens
 * or secrets. Run with --apply to mutate; default is a read-only plan.
 */
import "dotenv/config";

const apply = process.argv.includes("--apply");
const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
if (!account || !token) {
  console.error("CF_ACCOUNT_ID and CF_API_TOKEN are required.");
  process.exit(1);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success === false) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(body?.errors ?? body)}`);
  }
  return body.result;
}

function log(action, value) {
  console.log(`${apply ? "APPLY" : "PLAN "} ${action}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

const org = await api("/access/organizations");
log("organization", org.auth_domain);

const providers = await api("/access/identity_providers");
const cloudflare = providers.find((provider) => provider.type === "cloudflare");
if (!cloudflare) throw new Error("Cloudflare identity provider is missing.");
let otp = providers.find((provider) => provider.type === "onetimepin" && provider.name === "Foilbury email code");
if (!otp) {
  log("create one-time PIN identity provider", "Foilbury email code");
  if (apply) {
    otp = await api("/access/identity_providers", {
      method: "POST",
      body: JSON.stringify({ name: "Foilbury email code", type: "onetimepin", config: {} }),
    });
  }
}

const groups = await api("/access/groups");
let creators = groups.find((group) => group.name === "Foilbury creators");
if (!creators) {
  log("create Access group", "Foilbury creators");
  if (apply) {
    creators = await api("/access/groups", {
      method: "POST",
      body: JSON.stringify({
        name: "Foilbury creators",
        include: [{ email: { email: "dean@deanlofts.xyz" } }],
      }),
    });
  }
}

const apps = await api("/access/apps");
const byName = (name) => apps.find((app) => app.name === name);

async function ensurePolicy(app, policy) {
  const current = await api(`/access/apps/${app.id}/policies`);
  const existing = current.find((item) => item.name === policy.name);
  if (existing) {
    log(`policy exists · ${app.name}`, policy.name);
    return existing;
  }
  log(`add policy · ${app.name}`, policy.name);
  if (!apply) return null;
  return api(`/access/apps/${app.id}/policies`, {
    method: "POST",
    body: JSON.stringify({ decision: "allow", ...policy }),
  });
}

async function updateApp(app, changes) {
  const merged = {
    name: app.name,
    domain: app.domain,
    type: app.type,
    session_duration: changes.session_duration ?? app.session_duration,
    allowed_idps: changes.allowed_idps ?? app.allowed_idps,
    auto_redirect_to_identity: changes.auto_redirect_to_identity ?? app.auto_redirect_to_identity,
    app_launcher_visible: changes.app_launcher_visible ?? app.app_launcher_visible,
    skip_interstitial: changes.skip_interstitial ?? app.skip_interstitial,
    ...(changes.mfa_config ? { mfa_config: changes.mfa_config } : {}),
  };
  log(`update app · ${app.name}`, merged);
  if (!apply) return app;
  return api(`/access/apps/${app.id}`, { method: "PUT", body: JSON.stringify(merged) });
}

async function ensureApp(name, domain, allowedIdps, options = {}) {
  let app = byName(name);
  if (!app) {
    log("create app", { name, domain });
    if (!apply) return null;
    app = await api("/access/apps", {
      method: "POST",
      body: JSON.stringify({
        name,
        domain,
        type: "self_hosted",
        session_duration: "8h",
        allowed_idps: allowedIdps,
        auto_redirect_to_identity: options.autoRedirect ?? true,
        app_launcher_visible: false,
        skip_interstitial: true,
      }),
    });
  } else {
    app = await updateApp(app, {
      allowed_idps: allowedIdps,
      auto_redirect_to_identity: options.autoRedirect ?? false,
      app_launcher_visible: false,
      skip_interstitial: true,
      session_duration: "8h",
      ...(options.mfaConfig ? { mfa_config: options.mfaConfig } : {}),
    });
  }
  return app;
}

const dean = { email: { email: "dean@deanlofts.xyz" } };
const otpId = otp?.id ?? "<one-time-pin-id>";
const mfaConfig = { mfa_disabled: false, session_duration: "8h", allowed_authenticators: ["totp", "biometrics", "security_key"] };

const adminApp = await ensureApp("Foilbury Administration", "foilbury.loftwah.com/admin", [cloudflare.id, otpId], {
  autoRedirect: false,
});
const adminApiApp = await ensureApp("Foilbury Admin API", "foilbury.loftwah.com/api/v1/admin", [cloudflare.id, otpId], {
  autoRedirect: false,
});
const platformApp = await ensureApp("Foilbury Platform Administration", "foilbury.loftwah.com/platform-admin", [cloudflare.id], {
  autoRedirect: true,
  mfaConfig,
});
const platformApiApp = await ensureApp("Foilbury Platform Admin API", "foilbury.loftwah.com/api/v1/platform", [cloudflare.id], {
  autoRedirect: true,
  mfaConfig,
});
const editorialApp = await ensureApp("Foilbury Editorial", "foilbury.loftwah.com/_emdash", [cloudflare.id], {
  autoRedirect: true,
  mfaConfig,
});

for (const app of [adminApp, adminApiApp].filter(Boolean)) {
  await ensurePolicy(app, { name: "Foilbury owner", include: [dean], require: [] });
  if (creators) await ensurePolicy(app, { name: "Foilbury creators", include: [{ group: { id: creators.id } }], require: [] });
  if (otp) {
    // Authentication is not authorization: any verified one-time-PIN email may
    // reach the Worker, but the application still requires an active Bot
    // membership and the applicable Bot capability. Platform Administration is
    // deliberately not given this policy.
    await ensurePolicy(app, { name: "Foilbury creator email entry", include: [{ login_method: { id: otp.id } }], require: [] });
  }
}
for (const app of [platformApp, platformApiApp, editorialApp].filter(Boolean)) {
  await ensurePolicy(app, { name: "Foilbury owner", include: [dean], require: [] });
}

// Preserve the existing owner policy if an app already has one under that name.
// Newly created apps receive the policy above. The group policy is additive and
// still requires an active Foilbury Bot Admin membership in the application.
if (apply) {
  const finalApps = await api("/access/apps");
  const report = finalApps
    .filter((app) => ["Foilbury Administration", "Foilbury Admin API", "Foilbury Platform Administration", "Foilbury Platform Admin API", "Foilbury Editorial"].includes(app.name))
    .map((app) => ({ name: app.name, domain: app.domain, id: app.id, aud: app.aud, allowed_idps: app.allowed_idps, auto_redirect_to_identity: app.auto_redirect_to_identity, mfa_config: app.mfa_config ?? null }));
  console.log(JSON.stringify({ apps: report, creators_group_id: creators?.id ?? null, otp_idp_id: otp?.id ?? null }, null, 2));
}
