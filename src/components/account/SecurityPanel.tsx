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

export default function SecurityPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [totp, setTotp] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>([]);

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

  async function revokeOthers() {
    setBusy("others"); setError(""); setMessage("");
    try {
      await api("/api/v1/security/sessions/revoke-others", { method: "POST", body: {} });
      await load();
      setMessage("All other sessions were revoked.");
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  if (!data) return <div className="surface-flat skeleton h-64" />;

  return (
    <div className="grid gap-6">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="success-box" role="status">{message}</div> : null}

      <section className="surface p-6">
        <p className="eyebrow">Account</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Display name</p><p className="mt-1 text-lg font-semibold">{data.user.displayName}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Role</p><p className="mt-1 text-lg font-semibold">{data.user.role_label}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Primary email</p><p className="mt-1 break-all">{data.user.email}</p><p className="mt-1 text-xs text-[var(--muted)]">{data.user.email_verified ? "Verified" : "Not verified"}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Cloudflare Access identity</p><p className="mt-1 break-all">{data.access.linked ? data.access.email : "Not linked"}</p><p className="mt-1 text-xs text-[var(--muted)]">{data.access.linked ? `Linked ${date(data.access.linked_at ?? null)}` : "Used only for administration; not a player login."}</p></div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--line)] pt-4">
          <span className={`badge ${data.assurance === "passkey" || data.assurance === "access" || data.assurance === "mfa" ? "badge-rare" : ""}`}>Session assurance: {data.assurance ?? "unknown"}</span>
          <a className="btn btn-secondary btn-sm" href="/logout">Sign out of Foilbury</a>
          <a className="btn btn-ghost btn-sm" href="https://jolly-cake-2b85.cloudflareaccess.com/cdn-cgi/access/logout">Sign out of Cloudflare Access ↗</a>
        </div>
      </section>

      <section className="surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow">Passkeys</p><h2 className="display-sm mt-1 text-2xl">Fast, phishing-resistant sign-in.</h2><p className="mt-1 text-sm text-[var(--muted)]">Use this device, a security key or your platform authenticator. Passkeys also satisfy sensitive Bot actions.</p></div>
          <Button size="sm" onClick={addPasskey} disabled={Boolean(busy)}>{busy === "passkey" ? <><Loader2 className="animate-spin" size={14} /> Waiting…</> : <><KeyRound size={14} /> Add a passkey</>}</Button>
        </div>
        <div className="mt-4 grid gap-2">
          {data.passkeys.length === 0 ? <p className="text-sm text-[var(--muted)]">No passkeys yet. Add one before creating a Bot.</p> : null}
          {data.passkeys.map((passkey) => (
            <div key={passkey.id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--line)] px-4 py-3">
              <div><p className="font-semibold">{passkey.name}</p><p className="text-xs text-[var(--muted)]">Added {date(passkey.created_at)} · Last used {date(passkey.last_used_at)}</p></div>
              <Button size="sm" variant="secondary" onClick={() => removePasskey(passkey.id)} disabled={Boolean(busy)}><Trash2 size={14} /> Remove</Button>
            </div>
          ))}
        </div>
      </section>

      <section className="surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow">Authenticator</p><h2 className="display-sm mt-1 text-2xl">A six-digit backup for strong actions.</h2><p className="mt-1 text-sm text-[var(--muted)]">Add a TOTP authenticator. Cloudflare Access remains the administrative boundary; this is your Foilbury step-up.</p></div>
          {!data.totp.configured ? <Button size="sm" onClick={startTotp} disabled={Boolean(busy)}>{busy === "totp-start" ? "Starting…" : "Set up authenticator"}</Button> : <span className="badge badge-rare"><ShieldCheck size={13} /> Configured</span>}
        </div>
        {totp ? (
          <div className="mt-4 border border-[var(--line)] p-4">
            <p className="text-sm">Add this secret to your authenticator app, then enter the current code.</p>
            <code className="mt-2 block break-all bg-[var(--paper-3)] px-3 py-2 font-mono text-sm">{totp.secret}</code>
            <details className="mt-2"><summary className="cursor-pointer text-xs text-[var(--muted)]">Show otpauth link</summary><code className="mt-1 block break-all text-xs">{totp.otpauth_url}</code></details>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Six-digit code"><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} /></Field>
              <Button onClick={confirmTotp} disabled={busy === "totp-confirm" || code.length !== 6}>{busy === "totp-confirm" ? "Checking…" : "Confirm"}</Button>
            </div>
          </div>
        ) : null}
        {data.totp.configured ? (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-[var(--line)] pt-4">
            <Field label="Confirm a strong action" hint="Enter a current authenticator code to upgrade this session."><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} /></Field>
            <Button onClick={verifyStepUp} disabled={busy === "step-up" || code.length !== 6}>{busy === "step-up" ? "Checking…" : "Confirm code"}</Button>
            <span className="text-xs text-[var(--muted)]">{data.recovery_codes_remaining} recovery codes remaining</span>
          </div>
        ) : null}
        {recovery.length > 0 ? (
          <div className="mt-4 border border-[var(--brass)] bg-[var(--paper-3)] p-4">
            <p className="font-semibold">Save these recovery codes now.</p>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">{recovery.map((item) => <code key={item}>{item}</code>)}</div>
          </div>
        ) : null}
      </section>

      <section className="surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow">Sessions</p><h2 className="display-sm mt-1 text-2xl">Know where the cabinet is open.</h2><p className="mt-1 text-sm text-[var(--muted)]">Revoke anything you do not recognise. Cloudflare Access sessions are managed separately at the Access logout link above.</p></div>
          <Button size="sm" variant="secondary" onClick={revokeOthers} disabled={Boolean(busy)}><LogOut size={14} /> Revoke other sessions</Button>
        </div>
        <div className="mt-4 grid gap-2">
          {data.sessions.map((session) => (
            <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--line)] px-4 py-3">
              <div>
                <p className="font-semibold">{session.current ? "This device" : session.auth_method.replaceAll("_", " ")}</p>
                <p className="text-xs text-[var(--muted)]">Assurance {session.assurance} · Last seen {date(session.last_seen_at)} · Expires {date(session.expires_at)}</p>
                {session.user_agent ? <p className="mt-1 max-w-xl truncate text-xs text-[var(--muted)]">{session.user_agent}</p> : null}
              </div>
              {session.current || session.revoked_at ? <span className="badge">{session.current ? "Current" : "Revoked"}</span> : <Button size="sm" variant="secondary" onClick={() => revoke(session.id)} disabled={Boolean(busy)}>Revoke</Button>}
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-2 text-xs text-[var(--muted)]"><MonitorSmartphone size={13} /> Revoking an application session does not end your Cloudflare Access SSO session.</p>
      </section>
    </div>
  );
}
