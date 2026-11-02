"use client";

import { useState } from "react";
import { ArrowRight, Loader2, Plus } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input, Textarea } from "../ui/input";

export default function BotCreator({ ready, displayName }: { ready: boolean; displayName: string }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api<{ bot: { id: string; name: string }; created: boolean }>("/api/v1/bots", {
        method: "POST",
        body: { name, slug: slug || undefined, description: description || undefined },
      });
      await api(`/api/v1/bots/${result.bot.id}/switch`, { method: "POST", body: {} });
      window.location.href = "/admin";
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <div className="surface p-6">
        <p className="eyebrow">One step first</p>
        <h2 className="display-sm mt-1 text-2xl">Protect the account that will own a Bot.</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">A Bot can issue cards, change an economy and invite other administrators. Before you create one, verify your email and add a passkey or authenticator. Cloudflare Access admission is separate and does not count as a Foilbury role.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a className="btn btn-primary" href="/account/security">Set up account security <ArrowRight size={15} /></a>
          <a className="btn btn-secondary" href="/login">Verify email with a magic link</a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={create} className="surface p-6">
      <p className="eyebrow">New Bot</p>
      <h2 className="display-sm mt-1 text-2xl">Give {displayName}&rsquo;s cabinet a second home.</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">A Bot gets its own tenant, economy, collection scope and Discord installation. Global collections are visible to it; your Bot collections stay private to this Bot.</p>
      {error ? <div className="error-box mt-4" role="alert">{error}</div> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Bot name"><Input value={name} onChange={(event) => { setName(event.target.value); if (!slug) setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder="Late Night Cabinet" required /></Field>
        <Field label="URL slug" hint="Used in your Bot address; lowercase letters, numbers and hyphens."><Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="late-night-cabinet" /></Field>
      </div>
      <div className="mt-4"><Field label="Short description"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this cabinet for?" maxLength={500} /></Field></div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || name.trim().length < 2}>{busy ? <><Loader2 className="animate-spin" size={15} /> Creating…</> : <><Plus size={15} /> Create Bot</>}</Button>
        <span className="text-xs text-[var(--muted)]">You become the Bot Owner. Invitations are expiring, single-use and bound to the invitee&rsquo;s email.</span>
      </div>
    </form>
  );
}
