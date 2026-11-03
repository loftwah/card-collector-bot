"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, RotateCcw, Sparkles } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import ShareLinkButton from "./ShareLinkButton";
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
  filters: {
    channel_key: string | null;
    excluded_tags: string[];
    tenant_excluded_tags: string[];
    player_excluded_tags: string[];
    empty_reason: string | null;
  };
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
  new_subject: boolean;
  new_finish: boolean;
  owned_copies: number;
  price: number;
  balance_after: number;
  probability_bps: number;
  pool_revision: number;
  random_commitment: string;
  filters: Preview["filters"];
  odds: Array<{ card_name: string; variant_name: string; probability_bps: number; weight: number }>;
  achievements: Array<{ id: string; name: string; reward_amount: number }>;
  replayed: boolean;
}

export default function DrawStudio({
  pools,
  initialBalance,
}: {
  pools: PoolSummary[];
  initialBalance: number;
}) {
  const [slug, setSlug] = useState(pools[0]?.slug ?? "");
  const [channel, setChannel] = useState("");
  const [loadedPreview, setPreview] = useState<Preview | null>(null);
  const previewRequest = useRef(0);
  const [loading, setLoading] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DrawResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [revealStage, setRevealStage] = useState<"idle" | "anticipation" | "revealed">("idle");
  const [reduced, setReduced] = useState(false);
  const [balance, setBalance] = useState(initialBalance);
  const [pendingKey, setPendingKey] = useState(idempotencyKey("draw"));

  // A selection changes before its effect starts the next request. Never show
  // or draw against odds from a different capsule or community filter.
  const preview =
    loadedPreview?.pool.slug === slug && (loadedPreview.filters.channel_key ?? "") === channel
      ? loadedPreview
      : null;
  const insufficient = preview ? balance < preview.price : false;
  const empty = preview ? preview.eligible_count === 0 : false;
  const blocked = loading || !preview || empty || insufficient || drawing;

  async function loadPreview(nextSlug = slug, nextChannel = channel) {
    const request = ++previewRequest.current;
    if (!nextSlug) {
      setPreview(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const query = nextChannel ? `?channel=${encodeURIComponent(nextChannel)}` : "";
      const data = await api<Preview>(`/api/v1/pools/${encodeURIComponent(nextSlug)}${query}`);
      if (request !== previewRequest.current) return;
      if (data.pool.slug !== nextSlug || (data.filters.channel_key ?? "") !== nextChannel) {
        throw new Error(
          "The capsule preview changed. Select the capsule again to review its odds.",
        );
      }
      setPreview(data);
    } catch (cause) {
      if (request !== previewRequest.current) return;
      setError(describeError(cause));
      setPreview(null);
    } finally {
      if (request === previewRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    void loadPreview(slug, channel);
    return () => {
      previewRequest.current += 1;
    };
  }, [slug, channel]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  async function draw() {
    if (!preview || blocked) return;
    setDrawing(true);
    setError("");
    setResult(null);
    setRevealed(false);
    setRevealStage("anticipation");
    try {
      const data = await api<DrawResult>("/api/v1/draws", {
        method: "POST",
        body: {
          pool: slug,
          expectedRevision: preview.expected_revision,
          channelKey: channel || undefined,
        },
        idempotencyKey: pendingKey,
      });
      setResult(data);
      setBalance(data.balance_after);
      document.querySelectorAll<HTMLElement>("[data-foil-balance]").forEach((node) => {
        node.textContent = `${data.balance_after} Foil`;
      });
      setPendingKey(idempotencyKey("draw"));
      void loadPreview(slug, channel);
      const delay = reduced ? 0 : 950;
      window.setTimeout(() => {
        setRevealed(true);
        setRevealStage("revealed");
      }, delay);
    } catch (cause) {
      setError(describeError(cause));
      setRevealStage("idle");
      void loadPreview(slug, channel);
    } finally {
      setDrawing(false);
    }
  }

  function replayReveal() {
    setRevealed(false);
    setRevealStage("anticipation");
    window.setTimeout(
      () => {
        setRevealed(true);
        setRevealStage("revealed");
      },
      reduced ? 0 : 850,
    );
  }

  const sorted = useMemo(
    () =>
      preview ? [...preview.entries].sort((a, b) => b.probability_bps - a.probability_bps) : [],
    [preview],
  );
  const cardCount = useMemo(
    () => new Set(preview?.entries.map((entry) => entry.card_id)).size,
    [preview],
  );

  if (!pools.length) {
    return (
      <div className="empty">
        <p>No active pools. The owner can publish one in Administration.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
      <aside className="grid gap-4">
        <div className="surface-flat p-5">
          <label className="field">
            <span className="label">Choose a capsule</span>
            <select
              className="select"
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
                setResult(null);
              }}
              aria-label="Choose a capsule"
              disabled={drawing}
            >
              <optgroup label="Everyday">
                {pools
                  .filter((pool) => pool.slug === "cabinet-draw")
                  .map((pool) => (
                    <option key={pool.id} value={pool.slug}>
                      {pool.name} · ✦ {pool.price}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Collections">
                {pools
                  .filter((pool) => pool.slug !== "cabinet-draw")
                  .map((pool) => (
                    <option key={pool.id} value={pool.slug}>
                      {pool.name} · ✦ {pool.price}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
          {(() => {
            const selectedPool = pools.find((pool) => pool.slug === slug) ?? pools[0];
            if (!selectedPool) return null;
            return (
              <div className="mt-4 border-t border-[var(--line)] pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">{selectedPool.name}</p>
                  <span className="font-mono text-sm text-[var(--brass)]">
                    ✦ {selectedPool.price}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                  {selectedPool.description}
                </p>
              </div>
            );
          })()}
        </div>

        <div className="surface-flat p-5">
          <p className="eyebrow">Where you are opening</p>
          <label className="field mt-3">
            <span className="label">Community filter</span>
            <select
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              className="select"
              disabled={drawing}
            >
              <option value="">Public cabinet</option>
              <option value="family-table">Family table · hides horror-tagged cards</option>
            </select>
          </label>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
            A community filter can only hide cards. Your own preferences can hide more. Neither
            makes the remaining cards more likely than the odds shown.
          </p>
        </div>

        <div className="border border-[var(--line)] p-5">
          <p className="eyebrow">Balance</p>
          <p className="display-sm mt-1 text-4xl text-[var(--brass)]">✦ {balance}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {preview ? `${preview.currency.name} · price ✦ ${preview.price}` : "Select a pool"}
          </p>
          <div className="mt-4">
            <Button className="w-full" onClick={draw} disabled={blocked}>
              {drawing
                ? "Drawing…"
                : empty
                  ? "No eligible cards"
                  : insufficient
                    ? "Not enough Foil"
                    : `Draw for ✦ ${preview?.price ?? 0}`}
            </Button>
          </div>
          <p className="mt-2 text-center font-mono text-[0.55rem] tracking-[0.1em] text-[var(--muted)] uppercase">
            Odds shown before you open · no purchase
          </p>
        </div>
      </aside>

      <div>
        {error ? (
          <div className="error-box mb-5" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm mt-2"
              onClick={() => void loadPreview()}
              disabled={loading}
            >
              {loading ? "Retrying…" : "Retry this capsule preview"}
            </button>
          </div>
        ) : null}
        {loading && !preview ? (
          <div className="skeleton h-56 w-full" aria-label="Loading pool"></div>
        ) : null}
        {preview ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
              <div>
                <p className="eyebrow">
                  {preview.pool.name} · revision {preview.revision}
                </p>
                <h2 className="display-sm mt-1 text-4xl">Know the odds.</h2>
                <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
                  {preview.pool.description}
                </p>
              </div>
              <div className="text-right">
                <p className="eyebrow">Eligible</p>
                <p className="display-sm mt-1 text-3xl">{preview.eligible_count}</p>
                <p className="text-xs text-[var(--muted)]">{cardCount} identities</p>
              </div>
            </div>

            {preview.filters.excluded_tags.length ? (
              <div className="notice mt-4 text-sm">
                Excluded by the active policy or your preferences:{" "}
                {preview.filters.excluded_tags.join(", ")}. The probabilities below are recalculated
                from the remaining pool.
              </div>
            ) : null}
            {empty ? (
              <div className="empty mt-5">
                <div>
                  <p className="display-sm text-2xl">This pool is empty for this context.</p>
                  <p className="mt-2 text-sm">
                    {preview.filters.empty_reason ?? "No eligible cards."} Nothing will be charged.
                  </p>
                </div>
              </div>
            ) : null}

            {result ? (
              <div
                className={cn("draw-reveal mt-5", revealStage === "revealed" && "is-revealed")}
                data-stage={revealStage}
                aria-live="polite"
              >
                <div className="draw-reveal__stage">
                  <div className="draw-reveal__beam" aria-hidden="true"></div>
                  <div className="draw-reveal__card">
                    {result.render_url ? (
                      <img
                        src={result.render_url}
                        alt={`${result.card_name} — ${result.variant_name}`}
                        decoding="sync"
                      />
                    ) : (
                      <div className="card-face-fallback">Card render unavailable</div>
                    )}
                  </div>
                  {revealStage === "anticipation" ? (
                    <div className="draw-reveal__wait">
                      <span>Committing the receipt…</span>
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => {
                          setRevealed(true);
                          setRevealStage("revealed");
                        }}
                      >
                        Show result now
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="draw-reveal__receipt">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="studio-kicker">
                        {result.replayed
                          ? "Recorded result · replayed safely"
                          : "Committed draw receipt"}
                      </p>
                      <h3 className="display-sm mt-1 text-3xl uppercase">{result.card_name}</h3>
                      <p className="text-sm text-[var(--brass)]">
                        {result.variant_name} · {result.serial}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={replayReveal}
                      >
                        <RotateCcw size={14} /> Replay
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setRevealed((value) => !value);
                        }}
                      >
                        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}{" "}
                        {revealed ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={cn("badge", result.new_subject && "badge-signal")}>
                      {result.new_subject
                        ? "New subject"
                        : `Duplicate · ${result.owned_copies} owned`}
                    </span>
                    <span className={cn("badge", result.new_finish && "badge-signal")}>
                      {result.new_finish ? "New finish" : "Finish already held"}
                    </span>
                    <span className="badge">Paid ✦ {result.price}</span>
                    <span className="badge">Balance ✦ {result.balance_after}</span>
                    <span className="badge">{pct(result.probability_bps)} shown chance</span>
                  </div>
                  <div
                    className={cn(
                      "mt-4 overflow-hidden transition-all duration-500",
                      revealed ? "max-h-[38rem] opacity-100" : "max-h-0 opacity-0",
                    )}
                  >
                    <p className="text-sm text-[var(--muted)]">
                      This exact copy was selected from pool revision {result.pool_revision}. The
                      result was committed before this animation. A retry or reload reads the same
                      receipt and can never reroll or charge twice.
                    </p>
                    {result.achievements?.length ? (
                      <div className="mt-3 border border-[var(--signal)] bg-[var(--ice)]/30 p-3">
                        <p className="studio-stat__label">Unlocked with this draw</p>
                        <ul className="mt-1 grid gap-1 text-sm">
                          {result.achievements.slice(0, 4).map((achievement) => (
                            <li key={achievement.id}>
                              <strong>{achievement.name}</strong>
                              {achievement.reward_amount
                                ? ` · +${achievement.reward_amount} Foil`
                                : " · cosmetic badge"}
                            </li>
                          ))}
                          {result.achievements.length > 4 ? (
                            <li className="text-xs text-[var(--muted)]">
                              +{result.achievements.length - 4} more in the achievement cabinet
                            </li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                    <p className="mt-2 font-mono text-[0.56rem] break-all text-[var(--muted)]">
                      draw proof {result.random_commitment.slice(0, 32)}…
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <a
                        className="btn btn-primary btn-sm"
                        href={`/play/card/${result.instance_id}`}
                      >
                        Inspect this copy <ArrowRight size={14} />
                      </a>
                      <ShareLinkButton
                        kind="latest"
                        targetId={result.instance_id}
                        label="Share latest pull"
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={draw}
                        disabled={blocked}
                      >
                        <Sparkles size={14} /> Open again
                      </button>
                    </div>
                  </div>
                  {!revealed ? (
                    <p className="mt-3 text-sm text-[var(--muted)]">
                      The card is already saved in your album. Reveal it, replay the moment, or
                      inspect it later — nothing is lost.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <p className="eyebrow">Actual chance before you open</p>
              </div>
              <div
                className="mt-3 max-h-[30rem] overflow-auto border border-[var(--line)]"
                role="region"
                aria-label="Full odds table"
                tabIndex={0}
              >
                <table className="table">
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th>Finish</th>
                      <th className="text-right">Chance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((entry) => (
                      <tr key={entry.variant_id}>
                        <td className="font-medium">{entry.card_name}</td>
                        <td className="text-[var(--muted)]">
                          {entry.material_key === "diamond" ? "Holographic" : entry.variant_name}
                        </td>

                        <td className="text-right font-mono text-xs">
                          {pct(entry.probability_bps)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                This is the live capsule. If it changes before you open, you will be asked to review
                the new odds. Empty pools never charge.
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] pt-4 font-mono text-[0.58rem] tracking-[0.1em] text-[var(--muted)] uppercase">
              <span>
                <Sparkles
                  size={12}
                  className="mr-1 inline text-[var(--brass)]"
                  aria-hidden="true"
                />
                One capsule, one card
              </span>
              <span>Your result is saved if the connection drops</span>
              <span>No purchase or cash-out</span>
              <span>A retry never charges twice</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
