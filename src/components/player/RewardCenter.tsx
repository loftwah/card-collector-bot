"use client";

import { useState } from "react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";

interface SetReward {
  id: string;
  name: string;
  version: number;
  reward_amount: number;
  total: number;
  owned: number;
  complete: boolean;
  claimed: boolean;
}

export default function RewardCenter({ sets, dailyReward, canClaimDaily, nextEligible }: { sets: SetReward[]; dailyReward: number; canClaimDaily: boolean; nextEligible: string | null }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function claimSet(set: SetReward) {
    setBusy(set.id);
    setError("");
    setMessage("");
    try {
      const result = await api<{ amount: number }>(`/api/v1/sets/${set.id}/claim`, {
        method: "POST",
        body: {},
        idempotencyKey: idempotencyKey("set-claim"),
      });
      setMessage(`${set.name} completion claimed: ✦ ${result.amount}.`);
      setTimeout(() => window.location.reload(), 900);
    } catch (cause) {
      setError(describeError(cause));
      setBusy("");
    }
  }

  return (
    <div className="grid gap-5">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="success-box" role="status">{message}</div> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {sets.map((set) => (
          <article key={set.id} className="surface-flat p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">Set · version {set.version}</p>
                <h3 className="display-sm mt-1 text-2xl">{set.name}</h3>
              </div>
              <span className="font-mono text-sm text-[var(--brass)]">✦ {set.reward_amount}</span>
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-[var(--muted)]"><span>{set.owned}/{set.total} cards</span><span>{set.claimed ? "Claimed" : set.complete ? "Ready" : "In progress"}</span></div>
              <div className="mt-1.5 h-1.5 bg-[var(--paper-3)]"><div className="h-full bg-[var(--brass)]" style={{ width: `${set.total ? Math.round((set.owned / set.total) * 100) : 0}%` }}></div></div>
            </div>
            <div className="mt-4">
              <Button size="sm" onClick={() => claimSet(set)} disabled={!set.complete || set.claimed || Boolean(busy)}>
                {busy === set.id ? "Claiming…" : set.claimed ? "Reward claimed" : set.complete ? "Claim completion reward" : "Keep collecting"}
              </Button>
            </div>
          </article>
        ))}
        {sets.length === 0 ? <p className="text-sm text-[var(--muted)]">No published sets yet.</p> : null}
      </div>
      <div className="border border-[var(--line)] p-5">
        <p className="eyebrow">Daily allowance</p>
        <p className="mt-1 text-sm text-[var(--muted)]">The daily allowance is the repeatable standalone activity. It uses a 20 hour cooldown and a versioned rule record.</p>
        <p className="mt-2 font-mono text-sm text-[var(--brass)]">✦ {dailyReward} · {canClaimDaily ? "ready" : `next ${nextEligible ?? "later"}`}</p>
        <div className="mt-3">
          {canClaimDaily ? <Button size="sm" onClick={async () => {
            setBusy("daily"); setError("");
            try {
              await api("/api/v1/rewards/claim", { method: "POST", body: {}, idempotencyKey: idempotencyKey("daily") });
              setMessage(`Daily allowance claimed: ✦ ${dailyReward}.`);
              setTimeout(() => window.location.reload(), 800);
            } catch (cause) { setError(describeError(cause)); setBusy(""); }
          }} disabled={Boolean(busy)}>{busy === "daily" ? "Claiming…" : `Claim ✦ ${dailyReward}`}</Button> : <Button size="sm" variant="secondary" disabled>Allowance resting</Button>}
        </div>
      </div>
    </div>
  );
}
