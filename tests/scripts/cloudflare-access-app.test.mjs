import assert from "node:assert/strict";
import test from "node:test";
import { ensureAccessApplication } from "../../scripts/lib/cloudflare-access-app.mjs";

const name = "Foilbury Platform Administration";
const domain = "foilbury.loftwah.com/platform-admin";
const ownerPolicy = {
  id: "owner-policy",
  name: "Foilbury owner",
  decision: "allow",
  include: [{ email: { email: "dean@deanlofts.xyz" } }],
  require: [],
};

function fixture(overrides = {}) {
  return {
    id: "existing-app",
    aud: "existing-audience",
    name,
    domain,
    type: "self_hosted",
    session_duration: "8h",
    allowed_idps: ["cloudflare-idp"],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    skip_interstitial: true,
    http_only_cookie_attribute: true,
    enable_binding_cookie: true,
    policies: [ownerPolicy],
    mfa_config: { mfa_disabled: false, session_duration: "8h", allowed_authenticators: ["totp", "biometrics", "security_key"] },
    ...overrides,
  };
}

function harness(initial, { apply = true, readBack } = {}) {
  let saved = initial ? structuredClone(initial) : null;
  let written = false;
  const requests = [];
  const logs = [];
  return {
    requests,
    logs,
    context: {
      apps: initial ? [{ id: initial.id, name: initial.name }] : [],
      apply,
      log: (...args) => logs.push(args),
      api: async (path, init = {}) => {
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(init.body) : undefined;
        requests.push({ path, method, body });
        if (method === "GET") return written && readBack ? readBack(structuredClone(saved)) : structuredClone(saved);
        assert.ok(path.startsWith("/access/apps"), "must not write organisation, policies, groups or identity providers");
        saved = method === "POST" ? { ...body, id: "new-app", aud: "new-audience" } : body;
        written = true;
        return structuredClone(saved);
      },
    },
  };
}

const ownerOptions = { autoRedirect: true, inheritMfa: true };

test("removes only the app MFA override from a full GET snapshot and retains identity, owner policy and cookie controls", async () => {
  const original = fixture();
  const h = harness(original);
  const result = await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions);
  assert.deepEqual(h.requests.map(({ method }) => method), ["GET", "PUT", "GET"]);
  const expected = structuredClone(original);
  delete expected.mfa_config;
  assert.deepEqual(h.requests[1].body, expected);
  assert.deepEqual(result, expected);
  assert.deepEqual(original, fixture(), "the input snapshot must remain available for rollback");
  assert.equal(result.id, original.id);
  assert.equal(result.aud, original.aud);
  assert.deepEqual(result.policies, [ownerPolicy]);
});

test("new owner apps use Cloudflare alone and inherit MFA without creating an explicit global-policy exemption", async () => {
  const h = harness(null);
  const result = await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions);
  assert.deepEqual(h.requests.map(({ method }) => method), ["POST", "GET"]);
  const body = h.requests[0].body;
  assert.equal(Object.hasOwn(body, "mfa_config"), false);
  assert.deepEqual(body.allowed_idps, ["cloudflare-idp"]);
  assert.equal(body.auto_redirect_to_identity, true);
  assert.equal(body.type, "self_hosted");
  assert.equal(result.id, "new-app");
});

test("a second application update does not restore the removed MFA override", async () => {
  const h = harness(fixture());
  await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions);
  await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions);
  const writes = h.requests.filter(({ method }) => method === "PUT");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].body, writes[0].body);
  assert.equal(Object.hasOwn(writes[1].body, "mfa_config"), false);
});

test("planning existing and new apps sends no mutation", async () => {
  for (const original of [fixture(), null]) {
    const h = harness(original, { apply: false });
    const result = await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions);
    assert.ok(h.requests.every(({ method }) => method === "GET"));
    assert.deepEqual(result, original);
  }
});

test("preserves MFA configuration on applications not selected for the owner-flow correction", async () => {
  const h = harness(fixture());
  const result = await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], { autoRedirect: true });
  assert.deepEqual(result.mfa_config, fixture().mfa_config);
});

test("fails read-back if Cloudflare retains custom MFA or returns an explicit exemption", async () => {
  for (const mfaConfig of [fixture().mfa_config, { mfa_disabled: true }]) {
    const h = harness(fixture(), { readBack: (app) => ({ ...app, mfa_config: mfaConfig }) });
    await assert.rejects(
      ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions),
      /retained an MFA override/,
    );
  }
});

test("fails read-back if an existing application audience changes", async () => {
  const h = harness(fixture(), { readBack: (app) => ({ ...app, aud: "unexpected-new-audience" }) });
  await assert.rejects(
    ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions),
    /identity changed unexpectedly/,
  );
});

test("refuses to modify an app whose name matches but whose domain does not", async () => {
  const h = harness(fixture({ domain: "other.example/admin" }));
  await assert.rejects(
    ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions),
    /does not match the expected self-hosted domain/,
  );
  assert.ok(h.requests.every(({ method }) => method === "GET"));
});

test("logs the intended change without dumping unrelated application configuration", async () => {
  const h = harness(fixture({ custom_metadata: { value: "private-unrelated-setting" } }), { apply: false });
  await ensureAccessApplication(h.context, name, domain, ["cloudflare-idp"], ownerOptions);
  assert.doesNotMatch(JSON.stringify(h.logs), /private-unrelated-setting/);
  assert.match(JSON.stringify(h.logs), /inherit organisation setting/);
});
