"use client";

import { useState } from "react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button, buttonVariants } from "../ui/button";
import { cn } from "@/lib/utils";

interface SetReward {
  id: string;
  release_id?: string;
  name: string;
  version: number;
  reward_amount: number;
  total: number;
  owned: number;
  complete: boolean | null;
  claimed: boolean | null;
}

export default function RewardCenter({ sets }: { sets: SetReward[] }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function claimSet(set: SetReward) {
    if (set.complete !== true || set.claimed !== false) return;
    setBusy(set.id);
    setError("");
    setMessage("");
    try {
      const result = await api<{ amount: number }>(`/api/v1/sets/${set.id}/claim`, {
        method: "POST",
        body: set.release_id ? { memberReleaseId: set.release_id } : {},
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
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="success-box" role="status">
          {message}
        </div>
      ) : null}
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
              <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                <span>
                  {set.owned}/{set.total} visible cards
                </span>
                <span>
                  {set.complete === null || set.claimed === null
                    ? "Completion unavailable"
                    : set.claimed
                      ? "Claimed"
                      : set.complete
                        ? "Ready"
                        : "In progress"}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 bg-[var(--paper-3)]">
                <div
                  className="h-full bg-[var(--brass)]"
                  style={{ width: `${set.total ? Math.round((set.owned / set.total) * 100) : 0}%` }}
                ></div>
              </div>
            </div>
            <div className="mt-4">
              {set.complete === false && set.claimed === false ? (
                <>
                  <a
                    className={cn(
                      buttonVariants({ size: "sm", variant: "secondary" }),
                      "h-auto min-h-9 max-w-full py-2 text-left whitespace-normal",
                    )}
                    href="/play/draw"
                  >
                    Browse eligible capsules
                  </a>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    Capsules may not contain cards from this set.
                  </p>
                </>
              ) : (
                <Button
                  size="sm"
                  onClick={() => claimSet(set)}
                  disabled={set.complete !== true || set.claimed !== false || Boolean(busy)}
                >
                  {busy === set.id
                    ? "Claiming…"
                    : set.complete === null || set.claimed === null
                      ? "Completion unavailable"
                      : set.claimed
                        ? "Reward claimed"
                        : set.complete
                          ? "Claim completion reward"
                          : "Completion unavailable"}
                </Button>
              )}
            </div>
          </article>
        ))}
        {sets.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No published sets yet.</p>
        ) : null}
      </div>
    </div>
  );
}
