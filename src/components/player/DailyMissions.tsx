"use client";

import { useState } from "react";
import { Check } from "lucide-react";
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

  const claimedCount = state.missions.filter((mission) => mission.claimed).length;

  return (
    <div className="grid gap-4">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {notice ? <div className="success-box" role="status">{notice}</div> : null}

      {state.missions.length === 0 ? (
        <div className="member-empty">
          <div>
            <h2>No missions today.</h2>
            <p>Missions appear only when they can actually be completed with your current collection and Bot.</p>
          </div>
        </div>
      ) : (
        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">Today&rsquo;s missions</h2>
              <p className="member-panel__note">
                Claims credit the same wallet as every other reward.
              </p>
            </div>
            <p className="member-count">
              {claimedCount} of {state.missions.length} claimed
            </p>
          </div>

          <ul className="member-list">
            {state.missions.map((mission) => {
              const percent = Math.round((mission.progress / Math.max(1, mission.target)) * 100);
              return (
                <li key={mission.key} className="member-row">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="member-row__title">{mission.title}</h3>
                      {mission.claimed ? (
                        <span className="badge badge-signal">
                          <Check size={11} /> Claimed
                        </span>
                      ) : mission.complete ? (
                        <span className="badge badge-rare">Ready to claim</span>
                      ) : null}
                    </div>
                    <p className="member-row__meta">{mission.description}</p>
                    <div className="mt-3 flex items-center gap-3">
                      <div
                        className="member-progress w-full max-w-xs"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={mission.target}
                        aria-valuenow={mission.progress}
                        aria-label={`${mission.title} progress`}
                      >
                        <span style={{ width: `${percent}%` }}></span>
                      </div>
                      <span className="text-xs tabular-nums text-[var(--muted)]">
                        {mission.progress}/{mission.target}
                      </span>
                    </div>
                  </div>

                  <div className="member-row__actions">
                    <span className="achievement-item__reward">✦ {mission.reward}</span>
                    {!mission.complete && !mission.claimed ? (
                      <a className="btn btn-secondary" href={mission.href}>
                        {mission.action}
                      </a>
                    ) : null}
                    {mission.claimable ? (
                      <Button onClick={() => claim(mission)} disabled={busy === mission.key}>
                        <Check size={15} />
                        {busy === mission.key ? "Claiming…" : `Claim ✦ ${mission.reward}`}
                      </Button>
                    ) : null}
                    {mission.claimed ? (
                      <span className="text-xs text-[var(--muted)]">Credited today</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="member-head__note">
        Daily cap {state.currency_symbol} {state.cap}. A missed day simply resets; nothing is taken
        away.
      </p>
    </div>
  );
}
