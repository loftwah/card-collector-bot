"use client";

import { useState } from "react";
import { Check, Clock3, Sparkles } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";

interface Mission {
  key: string;
  title: string;
  description: string;
  reward: number;
  progress: number;
  target: number;
  complete: boolean;
  claimed: boolean;
  claimable: boolean;
  href: string;
  action: string;
  claimed_at: string | null;
}

interface State {
  period_key: string;
  day: string;
  reset_at: string;
  reset_local: string;
  cap: number;
  earned_today: number;
  currency_symbol: string;
  missions: Mission[];
}

export default function DailyMissions({ initial }: { initial: State }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function claim(mission: Mission) {
    setBusy(mission.key);
    setError("");
    setNotice("");
    try {
      const result = await api<{ amount: number; balance_after: number }>("/api/v1/missions/daily/claim", {
        method: "POST",
        body: { key: mission.key },
      });
      setNotice(`+${result.amount} Foil credited. Balance ${result.balance_after}.`);
      setState(await api<State>("/api/v1/missions/daily"));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-6">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {notice ? <div className="success-box" role="status">{notice}</div> : null}

      <section className="border border-[var(--line)] bg-[var(--paper-2)]/60 p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Today · {state.day} UTC</p>
            <h2 className="display-sm mt-1 text-3xl uppercase">Three small reasons to visit.</h2>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">Optional missions. Complete them through ordinary collecting on the website or Discord, then claim the Foil. Nothing expires punitively; a missed day simply resets.</p>
          </div>
          <div className="text-right">
            <p className="eyebrow">Earned today</p>
            <p className="display-sm mt-1 text-3xl text-[var(--brass)]">{state.currency_symbol} {state.earned_today} <span className="text-base text-[var(--muted)]">/ {state.cap}</span></p>
            <p className="mt-1 flex items-center justify-end gap-1 text-xs text-[var(--muted)]"><Clock3 size={12} /> {state.reset_local}</p>
          </div>
        </div>
      </section>

      <ul className="grid gap-3">
        {state.missions.map((mission) => {
          const percent = Math.round((mission.progress / Math.max(1, mission.target)) * 100);
          return (
            <li key={mission.key} className="grid gap-4 border border-[var(--line)] bg-[var(--paper)] p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">{mission.title}</h3>
                  {mission.claimed ? <span className="badge badge-signal"><Check size={11} /> Claimed</span> : mission.complete ? <span className="badge badge-rare">Ready to claim</span> : null}
                </div>
                <p className="mt-1 text-sm text-[var(--muted)]">{mission.description}</p>
                <div className="mt-3 flex items-center gap-3">
                  <div className="h-1.5 w-full max-w-xs bg-[var(--paper-3)]" role="progressbar" aria-valuemin={0} aria-valuemax={mission.target} aria-valuenow={mission.progress} aria-label={`${mission.title} progress`}>
                    <div className="h-full bg-[var(--signal)]" style={{ width: `${percent}%` }}></div>
                  </div>
                  <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[var(--muted)]">{mission.progress}/{mission.target}</span>
                  <span className="badge">{state.currency_symbol} {mission.reward}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {!mission.complete && !mission.claimed ? <a className="btn btn-secondary btn-sm" href={mission.href}>{mission.action}</a> : null}
                {mission.claimable ? (
                  <Button size="sm" onClick={() => claim(mission)} disabled={busy === mission.key}>
                    <Sparkles size={14} /> {busy === mission.key ? "Claiming…" : `Claim ${state.currency_symbol} ${mission.reward}`}
                  </Button>
                ) : null}
                {mission.claimed ? <span className="text-xs text-[var(--muted)]">Credited {mission.claimed_at ? new Date(mission.claimed_at).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" }) : ""}</span> : null}
              </div>
            </li>
          );
        })}
        {state.missions.length === 0 ? (
          <li className="empty"><div><p className="display-sm text-2xl">No missions are available today.</p><p className="mt-2 text-sm">Check your collection and wallet; missions appear only when they can actually be completed.</p></div></li>
        ) : null}
      </ul>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="studio-stat"><p className="studio-stat__label">Reset</p><p className="text-sm font-semibold">{state.reset_local}</p><p className="mt-1 text-xs text-[var(--muted)]">{state.reset_at}</p></div>
        <div className="studio-stat"><p className="studio-stat__label">Daily cap</p><p className="display-sm text-3xl">{state.currency_symbol} {state.cap}</p><p className="mt-1 text-xs text-[var(--muted)]">Across all missions</p></div>
        <div className="studio-stat"><p className="studio-stat__label">Also available</p><p className="text-sm font-semibold"><a className="underline underline-offset-4" href="/play">Daily allowance</a></p><p className="mt-1 text-xs text-[var(--muted)]">Separate from missions</p></div>
      </section>
    </div>
  );
}
