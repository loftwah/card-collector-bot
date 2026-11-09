"use client";

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Link2, Loader2, ShieldCheck } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";

type ShareKind = "card" | "collection" | "achievement" | "wishlist" | "latest";

interface ShareResponse {
  url: string;
  audience: "public" | "member" | "private";
  expires_at: string;
  preview: Record<string, unknown>;
}

export default function SharePanel({
  kind,
  targetId,
  title,
  description,
  frontUrl,
  backUrl,
}: {
  kind: ShareKind;
  targetId: string;
  title: string;
  description: string;
  frontUrl?: string | null;
  backUrl?: string | null;
}) {
  const [result, setResult] = useState<ShareResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const isCollection = kind === "collection";

  async function create() {
    setBusy(true);
    setError("");
    try {
      setResult(await api<ShareResponse>("/api/v1/shares", {
        method: "POST",
        body: { kind, targetId, expiresInDays: expiryDays },
      }));
      setConfirming(false);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed. Select the link and copy it manually.");
    }
  }

  return (
    <section className={`share-panel${isCollection ? " share-panel--collection" : ""}`} aria-label={`Share ${title}`}>
      <div className="share-panel__head">
        <div>
          <p className="studio-kicker text-[var(--teal)]">Share deliberately</p>
          <h3 className="display-sm mt-1 text-2xl uppercase">{title}</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
        </div>
        <ShieldCheck size={22} className="shrink-0 text-[var(--signal)]" aria-hidden="true" />
      </div>

      <div className="share-panel__preview">
        {frontUrl ? (
          <img
            className={isCollection ? "share-panel__collection-art" : undefined}
            src={frontUrl}
            alt=""
            width={isCollection ? 640 : 150}
            height={isCollection ? 360 : 210}
          />
        ) : (
          <div className="grid h-[210px] w-[150px] place-items-center bg-[var(--ink)] p-3 text-center font-mono text-[0.55rem] uppercase tracking-[0.12em] text-[var(--paper)]">{title}</div>
        )}
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">Recipients see exactly this object and its published front/back. No wallet, email, account ID, admin data, private source layers or other cards are included. The link is a snapshot; cards you obtain later never appear in it.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!confirming && !result ? (
              <Button size="sm" onClick={() => setConfirming(true)}>
                <Link2 size={14} /> Preview &amp; create link
              </Button>
            ) : null}
            {frontUrl ? <a className="btn btn-secondary btn-sm" href={frontUrl} download><Download size={14} /> Front</a> : null}
            {backUrl ? <a className="btn btn-secondary btn-sm" href={backUrl} download><Download size={14} /> Back</a> : null}
          </div>
        </div>
      </div>

      {confirming ? (
        <div className="share-panel__confirm" role="group" aria-label="Confirm share link">
          <p className="text-sm font-semibold">Confirm the exact snapshot</p>
          <p className="mt-1 text-xs text-[var(--muted)]">A public-safe link can be opened by anyone with the URL while it is active. A members-only link still requires an entitled sign-in on every request. Neither grants membership or access to your account.</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold">
              Expires
              <select className="select mt-1 block" value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>
                <option value={1}>In 1 day</option>
                <option value={7}>In 7 days</option>
                <option value={30}>In 30 days</option>
              </select>
            </label>
            <Button size="sm" onClick={create} disabled={busy}>{busy ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <>Create link</>}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-xs text-[var(--oxblood)]" role="alert">{error}</p> : null}
      {result ? (
        <div className="mt-4 border-t border-[var(--line)] pt-3">
          <p className="text-xs text-[var(--muted)]">Audience: <strong>{result.audience === "public" ? "Public-safe" : result.audience === "private" ? "Owner only" : "Members"}</strong> · expires {new Date(result.expires_at).toLocaleDateString("en-AU")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input className="input min-w-0 flex-1 font-mono text-xs" readOnly value={result.url} aria-label="Share link" onFocus={(event) => event.target.select()} />
            <Button size="sm" variant="secondary" onClick={copy}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</Button>
            <a className="btn btn-secondary btn-sm" href={result.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open as recipient</a>
          </div>
          <p className="mt-2 text-[0.65rem] leading-relaxed text-[var(--muted)]">Open the link in a private window to see the recipient view. Manage or revoke it from <a className="underline underline-offset-4" href="/play/profile">your showcase</a>. A later audience change closes it; already-downloaded bytes cannot be recalled.</p>
        </div>
      ) : null}
    </section>
  );
}
