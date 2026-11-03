"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";

export default function WishlistRemoveButton({ cardId, name }: { cardId: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api("/api/v1/wishlist", { method: "POST", body: { cardId, wanted: false } });
      setRemoved(true);
      window.location.reload();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sm:text-right">
      <Button size="sm" variant="ghost" onClick={remove} disabled={busy || removed} aria-label={`Remove ${name} from wishlist`}>
        <Trash2 size={13} /> {removed ? "Removed" : "Remove"}
      </Button>
      {error ? <p className="mt-1 text-xs text-[var(--oxblood)]" role="alert">{error}</p> : null}
    </div>
  );
}
