"use client";

import { useState } from "react";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
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
      setRows((current) =>
        current.map((row) => (row.id === id ? { ...row, status: "revoked" } : row)),
      );
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <section aria-label="Shared links">
      {error ? (
        <div className="error-box mt-3" role="alert">
          {error}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="empty mt-4">
          <div>
            <p className="display-sm text-2xl">No links yet.</p>
            <p className="mt-2 text-sm">
              Use Share on a card, collection or badge. You will see the exact snapshot before
              anything is created.
            </p>
          </div>
        </div>
      ) : (
        <ul className="share-list">
          {rows.map((row) => (
            <li key={row.id} className="share-row">
              <div className="min-w-0">
                <p className="share-row__name">{label(row)}</p>
                <p className="share-row__meta">
                  {row.kind} · {row.status} · expires{" "}
                  {new Date(row.expires_at).toLocaleDateString("en-AU")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={row.status === "active" ? "badge badge-signal" : "badge"}>
                  {row.status === "active" ? "Active" : row.status}
                </span>
                {row.status === "active" ? (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => revoke(row.id)}
                    disabled={busy === row.id}
                    aria-label={`Revoke ${label(row)}`}
                  >
                    {busy === row.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}{" "}
                    Revoke
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="share-manager__note">
        <ExternalLink size={12} className="mr-1 inline" aria-hidden="true" /> For the recipient view,
        open a newly created link in a private window. A link never grants membership or access to
        your account.
      </p>
    </section>
  );
}
