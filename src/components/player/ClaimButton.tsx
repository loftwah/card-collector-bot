"use client";

import { useState } from "react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";

export default function ClaimButton({
  amount,
  canClaim,
  nextEligible,
  label = "Claim daily allowance",
}: {
  amount: number;
  canClaim: boolean;
  nextEligible: string | null;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function claim() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ amount: number; balance_after: number; next_eligible_at: string }>("/api/v1/rewards/claim", {
        method: "POST",
        body: {},
        idempotencyKey: idempotencyKey("daily-claim"),
      });
      setMessage(`Claimed ${result.amount} Foil. Balance: ${result.balance_after}.`);
      setTimeout(() => window.location.reload(), 900);
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  }

  return (
    <div>
      <Button onClick={claim} disabled={busy || !canClaim} variant={canClaim ? "primary" : "secondary"}>
        {busy ? "Claiming…" : canClaim ? `${label} · ✦ ${amount}` : "Allowance resting"}
      </Button>
      {!canClaim && nextEligible ? <p className="mt-2 text-xs text-[var(--muted)]">Next eligible {nextEligible}</p> : null}
      {message ? <p className="mt-2 text-xs green" role="status">{message}</p> : null}
      {error ? <p className="mt-2 text-xs text-[var(--oxblood)]" role="alert">{error}</p> : null}
    </div>
  );
}
