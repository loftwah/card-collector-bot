"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";

export default function RecordWorldVisit({ collectionId }: { collectionId: string }) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => setReady(true), []);
  async function record() {
    setBusy(true); setMessage("");
    try {
      const result = await api<{recorded:boolean;already_recorded:boolean}>(`/api/v1/collections/${encodeURIComponent(collectionId)}/explore`, {method:"POST"});
      setMessage(result.already_recorded ? "Today's visit is already recorded." : "Visit recorded for today's missions.");
    } catch (error) { setMessage(describeError(error)); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 flex flex-wrap items-center gap-3">
    <Button type="button" size="sm" variant="secondary" className="min-h-11" disabled={!ready || busy} onClick={() => void record()}>{busy ? "Recording…" : "Record today's visit"}</Button>
    {message ? <p className="text-sm text-[var(--muted)]" role="status">{message}</p> : null}
    {!ready ? <p className="text-sm text-[var(--muted)]">Visit recording needs JavaScript; browsing remains available.</p> : null}
  </div>;
}
