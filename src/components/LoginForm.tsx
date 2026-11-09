"use client";

import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { ArrowRight, Fingerprint, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/input";

export default function LoginForm({
  next,
  devLoginEnabled = false,
  discordOAuth = false,
}: {
  next: string;
  devLoginEnabled?: boolean;
  discordOAuth?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [devLink, setDevLink] = useState("");
  const [busy, setBusy] = useState("");

  const destination = next.startsWith("/") && !next.startsWith("//") ? next : "/play";

  async function devLogin(account: string) {
    setError("");
    setBusy("dev");
    try {
      await api("/api/v1/dev/login", { method: "POST", body: { email: account } });
      window.location.href = destination;
    } catch (cause) {
      setError(describeError(cause));
      setBusy("");
    }
  }

  async function sendLink(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSent("");
    setDevLink("");
    setBusy("email");
    try {
      const result = await api<{ ok: boolean; dev_token?: string }>("/api/v1/auth/magic-link", {
        method: "POST",
        body: { email, redirectPath: destination },
      });
      setSent("If that address can use Foilbury, a one-use sign-in link is on its way. It expires in 15 minutes.");
      if (result.dev_token) setDevLink(`/auth/email/verify?token=${encodeURIComponent(result.dev_token)}`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function passkey() {
    setError("");
    setBusy("passkey");
    try {
      const options = await api<Record<string, unknown>>("/api/v1/auth/passkey/login/options", {
        method: "POST",
        body: email ? { email } : {},
      });
      const response = await startAuthentication({ optionsJSON: options as never });
      await api("/api/v1/auth/passkey/login/verify", { method: "POST", body: { response } });
      window.location.href = destination;
    } catch (cause) {
      setError(describeError(cause));
      setBusy("");
    }
  }

  async function passwordLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy("password");
    try {
      await api("/api/v1/auth/login", { method: "POST", body: { email, password } });
      window.location.href = destination;
    } catch (cause) {
      setError(describeError(cause));
      setBusy("");
    }
  }

  return (
    <div className="grid gap-4">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {sent ? (
        <div className="success-box" role="status">
          <p>{sent}</p>
          {devLink ? <a className="mt-2 inline-block font-semibold underline" href={devLink}>Local development: open the sign-in link</a> : null}
        </div>
      ) : null}

      {discordOAuth ? (
        <a className="btn btn-primary w-full" href={`/auth/discord/start?next=${encodeURIComponent(destination)}`}>
          <span className="grid h-5 w-5 place-items-center rounded-full bg-white/10 text-[0.7rem] font-bold">D</span>
          Continue with Discord
          <ArrowRight size={16} />
        </a>
      ) : null}

      <form onSubmit={sendLink} className="grid gap-3">
        <Field label="Email me a sign-in link" hint="A one-use link, valid for 15 minutes. No password to remember.">
          <Input type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </Field>
        <Button type="submit" variant="secondary" className="w-full" disabled={Boolean(busy) || !email}>
          {busy === "email" ? <><Loader2 className="animate-spin" size={16} /> Sending…</> : <><Mail size={16} /> Email me a sign-in link</>}
        </Button>
      </form>

      <div className="flex items-center gap-3 text-[0.62rem] uppercase tracking-[0.14em] text-[var(--muted)]">
        <span className="h-px flex-1 bg-[var(--line)]" />
        or
        <span className="h-px flex-1 bg-[var(--line)]" />
      </div>

      <Button type="button" variant="secondary" className="w-full" onClick={passkey} disabled={Boolean(busy)}>
        {busy === "passkey" ? <><Loader2 className="animate-spin" size={16} /> Waiting for your passkey…</> : <><Fingerprint size={16} /> Sign in with a passkey</>}
      </Button>
      <p className="text-center text-xs leading-relaxed text-[var(--muted)]">
        Discord and email sign-in resolve your existing Foilbury identity. A passkey is optional until you create or administer a Bot.
      </p>

      <a className="mt-1 flex items-center justify-between gap-3 border border-[var(--line)] px-4 py-3 text-sm no-underline hover:border-[var(--brass)]" href="/admin">
        <span className="flex items-center gap-2"><ShieldCheck size={16} className="text-[var(--green)]" /> Administrator? Continue with Cloudflare Access</span>
        <ArrowRight size={15} />
      </a>

      <details className="mt-1 border-t border-[var(--line)] pt-3">
        <summary className="cursor-pointer font-mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--muted)]">Legacy password fallback</summary>
        <form onSubmit={passwordLogin} className="mt-3 grid gap-3">
          <p className="text-xs leading-relaxed text-[var(--muted)]">Retained only for the existing bootstrap owner while the replacement access and recovery paths are verified. It is not the normal sign-in journey.</p>
          <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Button type="submit" variant="ghost" size="sm" disabled={busy === "password"}>{busy === "password" ? <><Loader2 className="animate-spin" size={14} /> Opening…</> : <><KeyRound size={14} /> Use legacy password</>}</Button>
        </form>
      </details>

      {devLoginEnabled ? (
        <div className="mt-2 border-t border-[var(--line)] pt-4">
          <p className="eyebrow mb-2">Local development sign-in</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => devLogin("owner@foilbury.local")} disabled={Boolean(busy)}>Owner</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => devLogin("player@foilbury.local")} disabled={Boolean(busy)}>Player</Button>
          </div>
          <p className="mt-2 text-[0.66rem] leading-relaxed text-[var(--muted)]">Loopback only. Enabled by FOILBURY_LOCAL_MODE and FOILBURY_DEV_LOGIN; set the latter to false to revoke. It is never part of a production configuration.</p>
        </div>
      ) : null}
    </div>
  );
}
