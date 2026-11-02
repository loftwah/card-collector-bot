"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, EyeOff, Sparkles } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { cn, pct } from "@/lib/utils";

interface PoolSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  revision: number;
  price: number;
  status: string;
}

interface Entry {
  variant_id: string;
  card_id: string;
  card_name: string;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
  weight: number;
  probability_bps: number;
  tags: string[];
}

interface Preview {
  pool: PoolSummary;
  revision: number;
  price: number;
  eligible_count: number;
  total_weight: number;
  entries: Entry[];
  filters: { channel_key: string | null; excluded_tags: string[]; tenant_excluded_tags: string[]; player_excluded_tags: string[]; empty_reason: string | null };
  pity: string;
  currency: { name: string; symbol: string };
  expected_revision: number;
}

interface DrawResult {
  draw_id: string;
  instance_id: string;
  card_name: string;
  variant_name: string;
  render_url: string | null;
  serial: string;
  price: number;
  balance_after: number;
  probability_bps: number;
  pool_revision: number;
  random_commitment: string;
  filters: Preview["filters"];
  odds: Array<{ card_name: string; variant_name: string; probability_bps: number; weight: number }>;
  replayed: boolean;
}

export default function DrawStudio({ pools, initialBalance }: { pools: PoolSummary[]; initialBalance: number }) {
  const [slug, setSlug] = useState(pools[0]?.slug ?? "");
  const [channel, setChannel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DrawResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [balance, setBalance] = useState(initialBalance);
  const [pendingKey, setPendingKey] = useState(idempotencyKey("draw"));

  const insufficient = preview ? balance < preview.price : false;
  const empty = preview ? preview.eligible_count === 0 : false;
  const blocked = !preview || empty || insufficient || drawing;

  async function loadPreview(nextSlug = slug, nextChannel = channel) {
    if (!nextSlug) return;
    setLoading(true);
    setError("");
    try {
      const query = nextChannel ? `?channel=${encodeURIComponent(nextChannel)}` : "";
      const data = await api<Preview>(`/api/v1/pools/${encodeURIComponent(nextSlug)}${query}`);
      setPreview(data);
    } catch (cause) {
      setError(describeError(cause));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPreview(slug, channel);
  }, [slug, channel]);

  async function draw() {
    if (!preview || blocked) return;
    setDrawing(true);
    setError("");
    setResult(null);
    setRevealed(false);
    try {
      const data = await api<DrawResult>("/api/v1/draws", {
        method: "POST",
        body: { pool: preview.pool.slug, expectedRevision: preview.expected_revision, channelKey: channel || undefined },
        idempotencyKey: pendingKey,
      });
      setResult(data);
      setBalance(data.balance_after);
      document.querySelectorAll<HTMLElement>("[data-foil-balance]").forEach((node) => { node.textContent = `${data.balance_after} Foil`; });
      setPendingKey(idempotencyKey("draw"));
      void loadPreview(slug, channel);
    } catch (cause) {
      setError(describeError(cause));
      void loadPreview(slug, channel);
    } finally {
      setDrawing(false);
    }
  }

  const sorted = useMemo(() => (preview ? [...preview.entries].sort((a, b) => b.probability_bps - a.probability_bps) : []), [preview]);
  const cardCount = useMemo(() => new Set(preview?.entries.map((entry) => entry.card_id)).size, [preview]);

  if (!pools.length) {
    return <div className="empty"><p>No active pools. The owner can publish one in Administration.</p></div>;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
      <aside className="grid gap-4">
        <div className="surface-flat p-5">
          <p className="eyebrow">Choose a pool</p>
          <div className="mt-3 grid gap-2">
            {pools.map((pool) => (
              <button
                key={pool.id}
                type="button"
                onClick={() => { setSlug(pool.slug); setResult(null); }}
                aria-pressed={pool.slug === slug}
                className={cn(
                  "border p-3 text-left transition-colors",
                  pool.slug === slug ? "surface-selected border-ink" : "border-[var(--line)] hover:border-[var(--brass)]",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{pool.name}</span>
                  <span className={cn("font-mono text-xs", pool.slug === slug ? "text-[var(--brass-bright)]" : "text-[var(--brass)]")}>✦ {pool.price}</span>
                </span>
                <span className={cn("mt-1 block text-xs", pool.slug === slug ? "text-[#c9c2b4]" : "text-[var(--muted)]")}>{pool.description}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="surface-flat p-5">
          <p className="eyebrow">Entrypoint context</p>
          <label className="field mt-3">
            <span className="label">Channel policy</span>
            <select value={channel} onChange={(event) => setChannel(event.target.value)} className="select">
              <option value="">Public cabinet</option>
              <option value="family-table">Family table (excludes horror)</option>
            </select>
          </label>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">A community policy can only narrow the tenant pool. Your personal preferences narrow it further; neither silently improves your odds.</p>
        </div>

        <div className="border border-[var(--line)] p-5">
          <p className="eyebrow">Balance</p>
          <p className="display-sm mt-1 text-4xl text-[var(--brass)]">✦ {balance}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{preview ? `${preview.currency.name} · price ✦ ${preview.price}` : "Select a pool"}</p>
          <div className="mt-4">
            <Button className="w-full" onClick={draw} disabled={blocked}>
              {drawing ? "Drawing…" : empty ? "No eligible cards" : insufficient ? "Not enough Foil" : `Draw for ✦ ${preview?.price ?? 0}`}
            </Button>
          </div>
          <p className="mt-2 text-center font-mono text-[0.55rem] uppercase tracking-[0.1em] text-[var(--muted)]">Server-authoritative · pity {preview?.pity ?? "disabled"}</p>
        </div>
      </aside>

      <div>
        {error ? <div className="error-box mb-5" role="alert">{error}</div> : null}
        {loading && !preview ? <div className="skeleton h-56 w-full" aria-label="Loading pool"></div> : null}
        {preview ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
              <div>
                <p className="eyebrow">{preview.pool.name} · revision {preview.revision}</p>
                <h2 className="display-sm mt-1 text-4xl">Know the odds.</h2>
                <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">{preview.pool.description}</p>
              </div>
              <div className="text-right">
                <p className="eyebrow">Eligible</p>
                <p className="display-sm mt-1 text-3xl">{preview.eligible_count}</p>
                <p className="text-xs text-[var(--muted)]">{cardCount} identities</p>
              </div>
            </div>

            {preview.filters.excluded_tags.length ? (
              <div className="notice mt-4 text-sm">
                Excluded by the active policy or your preferences: {preview.filters.excluded_tags.join(", ")}. The probabilities below are recalculated from the remaining pool.
              </div>
            ) : null}
            {empty ? (
              <div className="empty mt-5">
                <div>
                  <p className="display-sm text-2xl">This pool is empty for this context.</p>
                  <p className="mt-2 text-sm">{preview.filters.empty_reason ?? "No eligible cards."} Nothing will be charged.</p>
                </div>
              </div>
            ) : null}

            {result ? (
              <div className="mt-5 border border-[var(--brass)] bg-[color-mix(in_srgb,var(--brass)_6%,transparent)] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="eyebrow">Draw receipt {result.replayed ? "· replayed safely" : ""}</p>
                    <h3 className="display-sm mt-1 text-3xl">{result.card_name}</h3>
                    <p className="text-sm text-[var(--brass)]">{result.variant_name} · {result.serial}</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setRevealed((value) => !value)}>
                    {revealed ? <EyeOff size={14} /> : <Eye size={14} />} {revealed ? "Hide card" : "Reveal card"}
                  </Button>
                </div>
                {revealed ? (
                  <div className="mt-5 grid gap-5 sm:grid-cols-[180px_1fr] sm:items-start">
                    {result.render_url ? <img src={result.render_url} alt={`${result.card_name} — ${result.variant_name}`} className="draw-result-image w-full rounded-[4px] border border-[var(--line)]" decoding="sync" /> : null}
                    <div className="text-sm text-[var(--muted)]">
                      <p>Paid <span className="font-mono text-[var(--brass)]">✦ {result.price}</span> from pool revision {result.pool_revision}. Balance after: <span className="font-mono text-[var(--ink)]">✦ {result.balance_after}</span>.</p>
                      <p className="mt-2">Selected at {pct(result.probability_bps)} probability. The receipt pins the pool revision and the random commitment.</p>
                      <p className="mt-2 break-all font-mono text-[0.56rem] text-[var(--muted)]">commitment {result.random_commitment.slice(0, 24)}…</p>
                      <a className="btn btn-primary btn-sm mt-4" href={`/play/card/${result.instance_id}`}>Inspect this instance <ArrowRight size={14} /></a>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-[var(--muted)]">The card is already in your collection. The reveal is optional; nothing is hidden from your inventory.</p>
                )}
              </div>
            ) : null}

            <div className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <p className="eyebrow">Actual probability before you draw</p>
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.1em] text-[var(--muted)]">total weight {preview.total_weight}</span>
              </div>
              <div className="mt-3 max-h-[30rem] overflow-auto border border-[var(--line)]">
                <table className="table">
                  <thead><tr><th>Card</th><th>Finish</th><th className="text-right">Weight</th><th className="text-right">Chance</th></tr></thead>
                  <tbody>
                    {sorted.map((entry) => (
                      <tr key={entry.variant_id}>
                        <td className="font-medium">{entry.card_name}</td>
                        <td className="text-[var(--muted)]">{entry.variant_name}</td>
                        <td className="text-right font-mono text-xs">{entry.weight}</td>
                        <td className="text-right font-mono text-xs">{pct(entry.probability_bps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">The table is the eligible pool at revision {preview.revision}. The draw endpoint rejects a stale revision before charging. Empty pools never charge.</p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] pt-4 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-[var(--muted)]">
              <span><Sparkles size={12} className="mr-1 inline text-[var(--brass)]" aria-hidden="true" />No player-selected seed</span>
              <span>Idempotent request key</span>
              <span>Atomic debit + issuance</span>
              <span>Retry does not reroll</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
