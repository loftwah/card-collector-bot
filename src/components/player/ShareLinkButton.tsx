"use client";

import { useState } from "react";
import { Check, Link2, Loader2 } from "lucide-react";
import { api, describeError } from "@/lib/client";

export default function ShareLinkButton({ kind, targetId, label = "Share" }: { kind: "achievement" | "wishlist" | "latest" | "collection" | "profile"; targetId?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [confirming, setConfirming] = useState(false);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ url: string }>("/api/v1/shares", { method: "POST", body: { kind, targetId, expiresInDays: 7 } });
      setUrl(result.url);
      setConfirming(false);
      try {
        await navigator.clipboard.writeText(result.url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } catch {
        setCopied(false);
      }
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5" role="group" aria-label="Confirm share">
        <span className="text-[0.65rem] text-[var(--muted)]">Create a 7-day snapshot of this exact object?</span>
        <button type="button" className="btn btn-primary btn-sm" onClick={create} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Confirm
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
        {error ? <span className="text-[0.62rem] text-[var(--oxblood)]" role="alert">{error}</span> : null}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(true)} disabled={busy}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : copied ? <Check size={13} /> : <Link2 size={13} />} {copied ? "Link copied" : label}
      </button>
      {url && !copied ? <a className="font-mono text-[0.58rem] underline underline-offset-4" href={url} target="_blank" rel="noreferrer">Open as recipient</a> : null}
      {error && !confirming ? <span className="text-[0.62rem] text-[var(--oxblood)]" role="alert">{error}</span> : null}
    </span>
  );
}
