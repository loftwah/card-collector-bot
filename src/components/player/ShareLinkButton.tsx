"use client";

import { useState } from "react";
import { Check, Link2, Loader2 } from "lucide-react";
import { api, describeError } from "@/lib/client";

export default function ShareLinkButton({ kind, targetId, label = "Share" }: { kind: "achievement" | "wishlist" | "latest" | "collection" | "profile"; targetId?: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ url: string }>("/api/v1/shares", { method: "POST", body: { kind, targetId, expiresInDays: 7 } });
      setUrl(result.url);
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

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-secondary btn-sm" onClick={create} disabled={busy}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : copied ? <Check size={13} /> : <Link2 size={13} />} {copied ? "Link copied" : label}
      </button>
      {url && !copied ? <a className="font-mono text-[0.58rem] underline underline-offset-4" href={url} target="_blank" rel="noreferrer">Open preview</a> : null}
      {error ? <span className="text-[0.62rem] text-[var(--oxblood)]" role="alert">{error}</span> : null}
    </span>
  );
}
