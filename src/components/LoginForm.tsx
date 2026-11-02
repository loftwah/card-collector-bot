"use client";

import { useState } from "react";
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
  const [busy, setBusy] = useState(false);

  async function devLogin(email: string) {
    setError("");
    setBusy(true);
    try {
      await api("/api/v1/dev/login", { method: "POST", body: { email } });
      window.location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/play";
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/v1/auth/login", { method: "POST", body: { email, password } });
      window.location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/play";
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      <Field label="Email">
        <Input type="email" autoComplete="username" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </Field>
      <Field label="Password">
        <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus />
      </Field>
      <Button type="submit" disabled={busy} className="mt-2 w-full">
        {busy ? "Opening the cabinet…" : "Sign in"}
      </Button>
      {discordOAuth ? (
        <>
          <div className="flex items-center gap-3 text-[0.62rem] uppercase tracking-[0.14em] text-[var(--muted)]">
            <span className="h-px flex-1 bg-[var(--line)]" />
            or
            <span className="h-px flex-1 bg-[var(--line)]" />
          </div>
          <a className="btn btn-secondary w-full" href={`/auth/discord/start?next=${encodeURIComponent(next)}`}>
            Continue with Discord
          </a>
          <p className="text-center text-xs text-[var(--muted)]">Discord sign-in links the same Foilbury inventory. It is not a separate account.</p>
        </>
      ) : null}
      <p className="text-center text-xs text-[var(--muted)]">No public registration. Accounts are created by the cabinet owner.</p>
      {devLoginEnabled ? (
        <div className="mt-2 border-t border-[var(--line)] pt-4">
          <p className="eyebrow mb-2">Local development sign-in</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => devLogin("owner@foilbury.local")} disabled={busy}>Owner</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => devLogin("player@foilbury.local")} disabled={busy}>Player</Button>
          </div>
          <p className="mt-2 text-[0.66rem] leading-relaxed text-[var(--muted)]">Loopback only. Enabled by FOILBURY_LOCAL_MODE and FOILBURY_DEV_LOGIN; set the latter to false to revoke. It is never part of a production configuration.</p>
        </div>
      ) : null}
    </form>
  );
}
