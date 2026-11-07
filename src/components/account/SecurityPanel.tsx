"use client";

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { KeyRound, Loader2, LogOut, MonitorSmartphone, ShieldCheck, Trash2 } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";

interface Overview {
  user: { id: string; email: string; displayName: string; role: string; role_label: string; platform_admin: boolean; email_verified: boolean };
  assurance: string | null;
  passkeys: Array<{ id: string; name: string; created_at: string; last_used_at: string | null }>;
  totp: { configured: boolean };
  recovery_codes_remaining: number;
  access: { linked: boolean; email?: string; linked_at?: string };
  sessions: Array<{ id: string; auth_method: string; assurance: string; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null; user_agent: string | null; current: number }>;
}

function date(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Melbourne" }).format(new Date(value));
}

function authLabel(value: string) {
  const labels: Record<string, string> = {
    password: "Password",
    magic_link: "Magic link",
    passkey: "Passkey",
    discord: "Discord",
    access: "Cloudflare Access",
    totp: "Authenticator",
  };
  return labels[value] ?? value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export default function SecurityPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [totp, setTotp] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [emailLink, setEmailLink] = useState("");
  const [showAllSessions, setShowAllSessions] = useState(false);

  async function load() {
    try {
      const overview = await api<Overview>("/api/v1/security/overview");
      setData(overview);
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  useEffect(() => { void load(); }, []);

  async function addPasskey() {
    setBusy("passkey"); setError(""); setMessage("");
    try {
      const options = await api<Record<string, unknown>>("/api/v1/auth/passkey/register/options", { method: "POST", body: {} });
      const response = await startRegistration({ optionsJSON: options as never });
      await api("/api/v1/auth/passkey/register/verify", { method: "POST", body: { response, name: navigator.platform || "This device" } });
      setMessage("Passkey added. You can now use it to sign in and step up sensitive actions.");
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally { setBusy(""); }
  }

  async function removePasskey(id: string) {
    setBusy(id); setError(""); setMessage("");
    try {
      await api(`/api/v1/security/passkeys/${id}/delete`, { method: "POST", body: {} });
      setMessage("Passkey removed.");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function startTotp() {
    setBusy("totp-start"); setError(""); setMessage(""); setRecovery([]);
    try {
      setTotp(await api<{ secret: string; otpauth_url: string }>("/api/v1/security/totp/start", { method: "POST", body: {} }));
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function confirmTotp() {
    setBusy("totp-confirm"); setError(""); setMessage("");
    try {
      const result = await api<{ recovery_codes: string[] }>("/api/v1/security/totp/confirm", { method: "POST", body: { code } });
      setRecovery(result.recovery_codes);
      setTotp(null);
      setCode("");
      setMessage("Authenticator configured. Store the recovery codes somewhere safe; they are shown once.");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function verifyStepUp() {
    setBusy("step-up"); setError(""); setMessage("");
    try {
      await api("/api/v1/security/totp/verify", { method: "POST", body: { code } });
      setMessage("Strong authentication confirmed for this session.");
      setCode("");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function revoke(id: string) {
    setBusy(id); setError(""); setMessage("");
    try {
      await api(`/api/v1/security/sessions/${id}/revoke`, { method: "POST", body: {} });
      await load();
      setMessage("Session revoked.");
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function requestEmailChange() {
    setBusy("email"); setError(""); setMessage(""); setEmailLink("");
    try {
      const result = await api<{ ok: boolean; dev_token?: string }>("/api/v1/security/email/request", {
        method: "POST",
        body: { email: newEmail },
      });
      setMessage(`Verification link sent to ${newEmail}. Open it while signed in to this account.`);
      if (result.dev_token) setEmailLink(`/auth/email/verify?token=${encodeURIComponent(result.dev_token)}`);
      setNewEmail("");
    } catch (cause) {
      setError(describeError(cause));
    } finally { setBusy(""); }
  }

  async function revokeOthers() {
    setBusy("others"); setError(""); setMessage("");
    try {
      await api("/api/v1/security/sessions/revoke-others", { method: "POST", body: {} });
      await load();
      setMessage("All other sessions were revoked.");
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  if (!data) return <div className="member-panel skeleton h-64" role="status" aria-label="Loading account security" />;

  const strong = data.assurance === "passkey" || data.assurance === "access" || data.assurance === "mfa";
  const sessions = [...data.sessions].sort((a, b) => {
    if (a.current !== b.current) return b.current - a.current;
    return (b.last_seen_at ?? "").localeCompare(a.last_seen_at ?? "");
  });
  const visibleSessions = showAllSessions ? sessions : sessions.slice(0, 8);
  const adminLinks = data.user.platform_admin || ["owner", "editor", "economy_admin"].includes(data.user.role);

  return (
    <div className="grid gap-5">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="success-box" role="status">{message}</div> : null}

      <section className="member-panel">
        <div className="member-panel__head">
          <div>
            <h2 className="member-panel__title">Account</h2>
            <p className="member-panel__note">
              One identity, several ways in. Administration access is a separate boundary.
            </p>
          </div>
          <span className={`badge ${strong ? "badge-rare" : ""}`}>
            Session assurance: {data.assurance ?? "unknown"}
          </span>
        </div>
        <div className="member-panel__pad">
          <dl className="security-dl">
            <div>
              <dt>Display name</dt>
              <dd>{data.user.displayName}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{data.user.role_label}</dd>
            </div>
            <div>
              <dt>Primary email</dt>
              <dd>
                {data.user.email}
                <span className="mt-1 block text-xs font-normal text-[var(--muted)]">
                  {data.user.email_verified ? "Verified" : "Not verified"}
                </span>
              </dd>
            </div>
            <div>
              <dt>Administration identity</dt>
              <dd>
                {data.access.linked ? data.access.email : "Not linked"}
                <span className="mt-1 block text-xs font-normal text-[var(--muted)]">
                  {data.access.linked
                    ? `Linked ${date(data.access.linked_at ?? null)}. Used only for administration.`
                    : "Used only for administration; not a player login."}
                </span>
              </dd>
            </div>
          </dl>

          <details className="mt-5 border-t border-[var(--line)] pt-4">
            <summary className="cursor-pointer text-sm font-semibold">Add or change the primary email</summary>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
              A Discord-only account can use a non-routable placeholder address and still sign in.
              Adding a real email enables magic-link sign-in. The new address is attached only after
              you open a one-use link while signed in; it never merges another Foilbury account.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="New email address">
                <Input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" />
              </Field>
              <Button size="sm" variant="secondary" onClick={requestEmailChange} disabled={busy === "email" || !newEmail.includes("@")}>
                {busy === "email" ? <><Loader2 className="animate-spin" size={14} /> Sending…</> : "Send verification link"}
              </Button>
            </div>
            {emailLink ? <a className="mt-2 inline-block text-xs underline underline-offset-4" href={emailLink}>Open the local verification link</a> : null}
            <p className="mt-2 text-xs text-[var(--muted)]">
              Changing the primary email requires a recent passkey, authenticator or Cloudflare Access
              proof. Adding a passkey below also satisfies that step-up.
            </p>
          </details>

          {adminLinks ? (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-4">
              {data.user.platform_admin ? <a className="btn btn-secondary btn-sm" href="/platform-admin">Platform administration</a> : null}
              {["owner", "editor", "economy_admin"].includes(data.user.role) ? <a className="btn btn-secondary btn-sm" href="/admin">Bot administration</a> : null}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-4">
            <a className="btn btn-secondary btn-sm" href="/logout">Sign out of Foilbury</a>
            <a className="btn btn-ghost btn-sm" href="https://jolly-cake-2b85.cloudflareaccess.com/cdn-cgi/access/logout">Sign out of Cloudflare Access ↗</a>
          </div>
        </div>
      </section>

      <section className="member-panel">
        <div className="member-panel__head">
          <div>
            <h2 className="member-panel__title">Passkeys</h2>
            <p className="member-panel__note">
              Fast, phishing-resistant sign-in. Passkeys also satisfy sensitive Bot actions.
            </p>
          </div>
          <Button onClick={addPasskey} disabled={Boolean(busy)}>
            {busy === "passkey" ? <><Loader2 className="animate-spin" size={14} /> Waiting…</> : <><KeyRound size={14} /> Add a passkey</>}
          </Button>
        </div>
        {data.passkeys.length === 0 ? (
          <div className="member-panel__pad">
            <p className="text-sm text-[var(--muted)]">No passkeys yet. Add one before creating a Bot.</p>
          </div>
        ) : (
          <ul className="member-list">
            {data.passkeys.map((passkey) => (
              <li key={passkey.id} className="security-row">
                <div>
                  <p className="security-row__name">{passkey.name}</p>
                  <p className="security-row__meta">Added {date(passkey.created_at)} · Last used {date(passkey.last_used_at)}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => removePasskey(passkey.id)} disabled={Boolean(busy)}>
                  <Trash2 size={14} /> Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="member-panel">
        <div className="member-panel__head">
          <div>
            <h2 className="member-panel__title">Authenticator</h2>
            <p className="member-panel__note">
              A six-digit backup for strong actions. Cloudflare Access remains the administrative
              boundary; this is your Foilbury step-up.
            </p>
          </div>
          {!data.totp.configured ? (
            <Button onClick={startTotp} disabled={Boolean(busy)}>
              {busy === "totp-start" ? "Starting…" : "Set up authenticator"}
            </Button>
          ) : (
            <span className="badge badge-rare"><ShieldCheck size={13} /> Configured</span>
          )}
        </div>
        <div className="member-panel__pad">
          {totp ? (
            <div className="rounded-[8px] border border-[var(--line)] p-4">
              <p className="text-sm">Add this secret to your authenticator app, then enter the current code.</p>
              <code className="mt-2 block break-all rounded-[6px] bg-[var(--panel-3)] px-3 py-2 font-mono text-sm">{totp.secret}</code>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-[var(--muted)]">Show otpauth link</summary>
                <code className="mt-1 block break-all text-xs">{totp.otpauth_url}</code>
              </details>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Six-digit code">
                  <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} />
                </Field>
                <Button onClick={confirmTotp} disabled={busy === "totp-confirm" || code.length !== 6}>
                  {busy === "totp-confirm" ? "Checking…" : "Confirm"}
                </Button>
              </div>
            </div>
          ) : null}

          {data.totp.configured ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-[var(--line)] pt-4">
              <Field label="Confirm a strong action" hint="Enter a current authenticator code to upgrade this session.">
                <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} />
              </Field>
              <Button onClick={verifyStepUp} disabled={busy === "step-up" || code.length !== 6}>
                {busy === "step-up" ? "Checking…" : "Confirm code"}
              </Button>
              <span className="text-xs text-[var(--muted)]">{data.recovery_codes_remaining} recovery codes remaining</span>
            </div>
          ) : null}

          {!totp && !data.totp.configured ? (
            <p className="mt-3 text-sm text-[var(--muted)]">
              No authenticator is configured. A passkey is enough for most accounts; an authenticator
              adds a typed-code recovery path.
            </p>
          ) : null}

          {recovery.length > 0 ? (
            <div className="mt-4 rounded-[8px] border border-[var(--brass)] bg-[var(--panel-3)] p-4">
              <p className="font-semibold">Save these recovery codes now.</p>
              <div className="security-codes mt-2">{recovery.map((item) => <code key={item}>{item}</code>)}</div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="member-panel">
        <div className="member-panel__head">
          <div>
            <h2 className="member-panel__title">Sessions</h2>
            <p className="member-panel__note">
              Know where the cabinet is open. Revoke anything you do not recognise.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={revokeOthers} disabled={Boolean(busy)}>
            <LogOut size={14} /> Revoke other sessions
          </Button>
        </div>
        <ul className="member-list">
          {visibleSessions.map((session) => (
            <li key={session.id} className="security-row">
              <div className="min-w-0">
                <p className="security-row__name">{session.current ? "This device" : authLabel(session.auth_method)}</p>
                <p className="security-row__meta">
                  Assurance {session.assurance} · Last seen {date(session.last_seen_at)} · Expires {date(session.expires_at)}
                </p>
                {session.user_agent ? <p className="security-row__meta security-row__agent">{session.user_agent}</p> : null}
              </div>
              {session.current || session.revoked_at ? (
                <span className="badge">{session.current ? "Current" : "Revoked"}</span>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => revoke(session.id)} disabled={Boolean(busy)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-3">
          <p className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <MonitorSmartphone size={13} /> Revoking an application session does not end your Cloudflare
            Access SSO session.
          </p>
          {sessions.length > 8 ? (
            <Button size="sm" variant="ghost" onClick={() => setShowAllSessions((value) => !value)}>
              {showAllSessions ? "Show fewer sessions" : `Show all ${sessions.length} sessions`}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
