"use client";

import { useState } from "react";
import { ExternalLink, Link2, Loader2, Trash2 } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";

interface ShareRow {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  expires_at: string;
  preview: Record<string, unknown>;
}

function label(row: ShareRow): string {
  const preview = row.preview;
  if (typeof preview.card_name === "string") return preview.card_name;
  if (typeof preview.collection_name === "string") return preview.collection_name;
  if (typeof preview.achievement_name === "string") return preview.achievement_name;
  if (typeof preview.display_name === "string") return `${preview.display_name}'s showcase`;
  if (row.kind === "wishlist") return "Wanted cards";
  return "Cabinet snapshot";
}

export default function ShareManager({ initial }: { initial: ShareRow[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      await api(`/api/v1/shares/${id}/revoke`, { method: "POST", body: {} });
      setRows((current) => current.map((row) => (row.id === id ? { ...row, status: "revoked" } : row)));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="mt-10" aria-label="Shared links">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--line)] pb-3">
        <div>
          <h2 className="display-sm text-3xl uppercase">Shared links</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Every snapshot you created, with its audience, status and expiry. Revoking stops new views; bytes someone already downloaded cannot be recalled.</p>
        </div>
        <a className="btn btn-secondary btn-sm" href="/play/preferences"><Link2 size={14} /> Sharing consent</a>
      </div>
      {error ? <div className="error-box mt-3" role="alert">{error}</div> : null}
      {rows.length === 0 ? (
        <div className="empty mt-4"><div><p className="display-sm text-2xl">No links yet.</p><p className="mt-2 text-sm">Use Share on a card, collection or badge. You will see the exact snapshot before anything is created.</p></div></div>
      ) : (
        <ul className="mt-4 grid gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--line)] bg-[var(--paper)] p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{label(row)}</p>
                <p className="mt-0.5 font-mono text-[0.56rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                  {row.kind} · {row.status} · expires {new Date(row.expires_at).toLocaleDateString("en-AU")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={row.status === "active" ? "badge badge-signal" : "badge"}>{row.status === "active" ? "Active" : row.status}</span>
                {row.status === "active" ? (
                  <Button size="sm" variant="danger" onClick={() => revoke(row.id)} disabled={busy === row.id} aria-label={`Revoke ${label(row)}`}>
                    {busy === row.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Revoke
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-[var(--muted)]"><ExternalLink size={12} className="mr-1 inline" aria-hidden="true" /> For the recipient view, open a newly created link in a private window. A link never grants membership or access to your account.</p>
    </section>
  );
}
