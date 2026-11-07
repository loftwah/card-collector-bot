"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Check, Loader2, ShieldCheck, X } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";

interface Copy {
  id: string;
  card_name: string;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  serial: string;
  render_url: string | null;
  favourite: number;
  locked: number;
  status: string;
  collection_name: string | null;
}

interface Npc {
  id: string;
  name: string;
  slug: string;
  preset_label: string;
  bio: string;
  avatar_url: string | null;
  status: string;
  cards: number;
  subjects: number;
  balance: number;
}

interface Offers {
  npc: {
    id: string;
    name: string;
    slug: string;
    preset: string;
    status: string;
    bio: string;
    avatar_url: string | null;
    synthetic_label: string;
  };
  copies: Copy[];
  wants: {
    goal_collection: string | null;
    preset_goal: string;
    missing_subjects: string[];
    wishlist: string[];
  };
}

interface Preview {
  npc: { id: string; name: string; slug: string; preset: string; status: string; bio: string; avatar_url: string | null };
  decision: "accept" | "decline";
  reason: string;
  give: Copy[];
  take: Copy[];
  wants: { new_subjects: string[]; new_finishes: string[]; goal_collection: string | null; preset_goal: string; wishlist: string[] };
  spare: Array<{ instance_id: string; card_name: string; serial: string; spare: boolean; reason: string }>;
}

interface Trade {
  id: string;
  status: string;
  expires_at: string;
  items: Array<{ id: string; side: string; card_name: string; variant_name: string; serial: string; render_url: string | null }>;
}

interface Detail {
  trade: Trade;
  decision: { decision: string; reason: string; npc_name: string };
}

function finish(item: Copy) {
  if (item.effect_key === "holographic") return "Holographic";
  if (item.material_key === "gold") return "Gold";
  if (item.material_key === "silver") return "Silver";
  if (item.material_key === "plain") return "Plain";
  return item.variant_name;
}

function CopyRow({
  item,
  checked,
  onToggle,
  disabled,
}: {
  item: Copy;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <label className={`trade-copy ${checked ? "is-selected" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      <span className="trade-copy__art">
        {item.render_url ? (
          <img src={item.render_url} alt="" width="120" height="168" loading="lazy" />
        ) : (
          <span className="trade-copy__fallback">{item.card_name.charAt(0)}</span>
        )}
      </span>
      <span className="trade-copy__body">
        <span className="trade-copy__name">{item.card_name}</span>
        <span className="trade-copy__meta">{finish(item)} · {item.collection_name ?? "collection"}</span>
        <span className="trade-copy__serial">{item.serial}</span>
      </span>
    </label>
  );
}

export default function NpcTradeDesk({
  npcs,
  inventory,
}: {
  npcs: Npc[];
  inventory: Copy[];
}) {
  const [selected, setSelected] = useState("");
  const [offers, setOffers] = useState<Offers | null>(null);
  const [give, setGive] = useState<string[]>([]);
  const [take, setTake] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [result, setResult] = useState<Detail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const available = useMemo(
    () => inventory.filter((item) => item.status === "owned" && !item.locked),
    [inventory],
  );
  const selectedNpc = npcs.find((npc) => npc.id === selected);

  function toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function chooseNpc(id: string) {
    setSelected(id);
    setOffers(null);
    setGive([]);
    setTake([]);
    setPreview(null);
    setTrade(null);
    setResult(null);
    setError("");
    setNotice("");
    if (!id) return;
    setBusy("offers");
    try {
      setOffers(await api<Offers>(`/api/v1/npcs/${id}/trade-offers`));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("npc");
    if (requested) void chooseNpc(requested);
    // The deep link is read once; later changes use the select control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask() {
    if (!selected) return;
    setBusy("preview");
    setError("");
    setNotice("");
    setResult(null);
    try {
      const result = await api<Preview>(`/api/v1/npcs/${selected}/trade-preview`, {
        method: "POST",
        body: { giveInstanceIds: give, takeInstanceIds: take },
      });
      setPreview(result);
      setNotice(result.reason);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function holdOffer() {
    if (!selected) return;
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const result = await api<{ trade: Trade; decision: Preview }>(`/api/v1/npcs/${selected}/trades`, {
        method: "POST",
        body: { giveInstanceIds: give, takeInstanceIds: take },
        idempotencyKey: idempotencyKey("npc-trade"),
      });
      setTrade(result.trade);
      setNotice("Offer held. Both sides' exact copies are reserved; nothing has moved yet.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function confirm() {
    if (!trade) return;
    setBusy("confirm");
    setError("");
    setNotice("");
    try {
      const result = await api<Detail>(`/api/v1/npc-trades/${trade.id}/confirm`, { method: "POST", body: {} });
      setResult(result);
      setTrade(result.trade);
      setNotice("Exchange complete. The exact serials moved atomically.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function cancel() {
    if (!trade) return;
    setBusy("cancel");
    setError("");
    setNotice("");
    try {
      await api(`/api/v1/npc-trades/${trade.id}/cancel`, { method: "POST", body: {} });
      setTrade(null);
      setPreview(null);
      setNotice("Offer cancelled. The reserved copies were released; nothing moved.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="trade-panel" aria-labelledby="npc-trade-title">
      <div className="trade-panel__head">
        <div>
          <p className="trade-panel__meta">NPC collectors · synthetic</p>
          <h2 className="trade-panel__title" id="npc-trade-title">Trade with a fictional collector</h2>
          <p className="trade-panel__lede">
            Choose exact owned copies from both sides. The NPC uses a deterministic preset, its real
            holdings and its recorded goals. The trade uses the same reserved-copy lifecycle as a
            member exchange; nothing moves until you confirm.
          </p>
        </div>
      </div>

      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {notice ? <div className="success-box" role="status">{notice}</div> : null}

      {npcs.length === 0 ? (
        <p className="trade-panel__lede">
          No NPC collectors are configured in this Bot. An owner can create one in Studio before
          trading.
        </p>
      ) : (
        <>
          <label className="field">
            <span>Collector</span>
            <select value={selected} onChange={(event) => void chooseNpc(event.target.value)}>
              <option value="">Choose an NPC collector</option>
              {npcs.map((npc) => (
                <option key={npc.id} value={npc.id}>
                  {npc.name} · {npc.preset_label} · {npc.subjects} subjects
                </option>
              ))}
            </select>
          </label>

          {selectedNpc ? (
            <div className="npc-trade-profile">
              <span className="badge badge-signal">NPC · synthetic collector</span>
              <p className="trade-panel__title">{selectedNpc.name}</p>
              <p className="trade-panel__lede">{selectedNpc.bio}</p>
              <p className="trade-panel__meta">
                {selectedNpc.preset_label} · {selectedNpc.cards} copies · {selectedNpc.subjects} subjects · {selectedNpc.balance} Foil
              </p>
            </div>
          ) : null}

          {busy === "offers" ? <p className="trade-panel__lede">Loading the collector&apos;s shelf…</p> : null}

          {offers ? (
            <>
              <div className="npc-trade-wants">
                <div>
                  <p className="trade-panel__meta">Wants</p>
                  <p className="trade-panel__lede">
                    {offers.wants.missing_subjects.length
                      ? `Missing subjects: ${offers.wants.missing_subjects.slice(0, 8).join(", ")}`
                      : "No missing subjects in its current goal."}
                  </p>
                  {offers.wants.wishlist.length ? (
                    <p className="trade-panel__lede">Wishlist: {offers.wants.wishlist.slice(0, 8).join(", ")}</p>
                  ) : null}
                  <p className="trade-panel__meta">Goal preset · {offers.wants.preset_goal}</p>
                </div>
              </div>

              <div className="npc-trade-grid">
                <div>
                  <p className="trade-panel__meta">Your copies to offer</p>
                  <div className="trade-copy-list">
                    {available.map((item) => (
                      <CopyRow
                        key={item.id}
                        item={item}
                        checked={give.includes(item.id)}
                        onToggle={() => {
                          setGive((current) => toggle(current, item.id));
                          setPreview(null);
                          setTrade(null);
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <p className="trade-panel__meta">The collector&apos;s copies to request</p>
                  <div className="trade-copy-list">
                    {offers.copies.map((item) => (
                      <CopyRow
                        key={item.id}
                        item={item}
                        checked={take.includes(item.id)}
                        onToggle={() => {
                          setTake((current) => toggle(current, item.id));
                          setPreview(null);
                          setTrade(null);
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="npc-trade-actions">
                <Button type="button" onClick={() => void ask()} disabled={busy !== "" || give.length === 0 || take.length === 0}>
                  {busy === "preview" ? <Loader2 className="animate-spin" size={15} /> : <ArrowLeftRight size={15} />}
                  Ask for a decision
                </Button>
                {preview?.decision === "accept" && !trade ? (
                  <Button type="button" variant="secondary" onClick={() => void holdOffer()} disabled={busy !== ""}>
                    {busy === "create" ? <Loader2 className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
                    Hold exact offer
                  </Button>
                ) : null}
                {trade && trade.status === "open" ? (
                  <>
                    <Button type="button" onClick={() => void confirm()} disabled={busy !== ""}>
                      {busy === "confirm" ? <Loader2 className="animate-spin" size={15} /> : <Check size={15} />}
                      Confirm exchange
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => void cancel()} disabled={busy !== ""}>
                      {busy === "cancel" ? <Loader2 className="animate-spin" size={15} /> : <X size={15} />}
                      Cancel offer
                    </Button>
                  </>
                ) : null}
              </div>

              {preview ? (
                <div className={`npc-trade-decision is-${preview.decision}`} role="status">
                  <p className="trade-panel__title">
                    {preview.decision === "accept" ? "The collector accepts" : "The collector declines"}
                  </p>
                  <p className="trade-panel__lede">{preview.reason}</p>
                  <p className="trade-panel__meta">
                    Give: {preview.give.map((item) => `${item.card_name} ${item.serial}`).join(" · ")}
                  </p>
                  <p className="trade-panel__meta">
                    Receive: {preview.take.map((item) => `${item.card_name} ${item.serial}`).join(" · ")}
                  </p>
                  {preview.wants.new_subjects.length ? <p className="trade-panel__lede">New subjects: {preview.wants.new_subjects.join(", ")}</p> : null}
                  {preview.wants.new_finishes.length ? <p className="trade-panel__lede">New finishes: {preview.wants.new_finishes.join(", ")}</p> : null}
                </div>
              ) : null}

              {result ? (
                <div className="npc-trade-result" role="status">
                  <p className="trade-panel__title">Exchange complete</p>
                  <p className="trade-panel__lede">
                    {result.decision.npc_name} accepted. The exact copies below moved in one transaction;
                    serials and history are preserved.
                  </p>
                  <ul className="member-list">
                    {result.trade.items.map((item) => (
                      <li className="member-row" key={item.id}>
                        <span>{item.card_name} · {item.variant_name}</span>
                        <span className="trade-panel__meta">{item.side} · {item.serial}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="trade-panel__meta">Trade {result.trade.id} · {result.trade.status}</p>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
