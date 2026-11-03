/**
 * Reconcile one Access application without replacing its identity or settings.
 *
 * Cloudflare documents GET -> full-body PUT for application MFA changes:
 * https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
 * An absent application override inherits the organisation's MFA setting. It is
 * deliberately not `mfa_disabled: true`, which would override future global MFA.
 * Read-back must confirm that the API actually cleared the application override.
 */
export async function ensureAccessApplication(
  { api, apps, apply, log },
  name,
  domain,
  allowedIdps,
  options = {},
) {
  const listed = apps.find((app) => app.name === name);
  const current = listed ? await api(`/access/apps/${listed.id}`) : null;
  if (current && (current.domain !== domain || current.type !== "self_hosted")) {
    throw new Error(`Access application ${name} does not match the expected self-hosted domain ${domain}.`);
  }
  const body = {
    ...(current ?? { name, domain, type: "self_hosted" }),
    session_duration: "8h",
    allowed_idps: allowedIdps,
    auto_redirect_to_identity: options.autoRedirect ?? false,
    app_launcher_visible: false,
    skip_interstitial: true,
  };
  if (options.inheritMfa) delete body.mfa_config;

  // The full snapshot may contain settings unsuitable for logs. Report only the
  // intended authentication change and public application identifiers.
  log(`${current ? "update" : "create"} app · ${name}`, {
    name,
    domain,
    id: current?.id,
    aud: current?.aud,
    allowed_idps: allowedIdps,
    auto_redirect_to_identity: body.auto_redirect_to_identity,
    ...(options.inheritMfa ? { mfa: "inherit organisation setting" } : {}),
  });
  if (!apply) return current;

  const written = await api(current ? `/access/apps/${current.id}` : "/access/apps", {
    method: current ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  const expected = current ?? written;
  if (!expected?.id) throw new Error(`Cloudflare did not return an application ID for ${name}.`);
  const verified = await api(`/access/apps/${expected.id}`);
  if (
    verified.id !== expected.id ||
    (expected.aud && verified.aud !== expected.aud) ||
    verified.name !== name ||
    verified.domain !== domain ||
    verified.type !== "self_hosted"
  ) {
    throw new Error(`Access application identity changed unexpectedly for ${name}; inspect the application before continuing.`);
  }
  if (options.inheritMfa && verified.mfa_config != null && Object.keys(verified.mfa_config).length > 0) {
    throw new Error(`Cloudflare retained an MFA override for ${name}. Restore "Respect global enforcement setting" and verify before continuing.`);
  }
  return verified;
}
