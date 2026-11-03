"use client";

import { useState } from "react";
import { Gift, Handshake, PackageOpen } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { cn, formatDual } from "@/lib/utils";

interface OwnItem {
  id: string;
  card_name: string;
  variant_name: string;
  serial: string;
  render_url: string | null;
  favourite: number;
  locked: number;
  status: string;
}

interface Member {
  id: string;
  display_name: string;
  role: string;
}

interface TradeRow {
  id: string;
  proposer_id: string;
  recipient_id: string;
  status: string;
  revision: number;
  expires_at: string;
  updated_at: string;
  proposer_name: string;
  recipient_name: string;
  item_count: number;
}

interface TradeDetail {
  id: string;
  proposer_id: string;
  recipient_id: string;
  status: string;
  revision: number;
  expires_at: string;
  items: Array<{ id: string; side: string; card_name: string; variant_name: string; serial: string; render_url: string | null }>;
  acceptances: Array<{ user_id: string; revision: number; accepted_at: string }>;
}

export default function TradeDesk({
  currentUserId,
  initialTrades,
  inventory,
  members,
  initialGifts,
}: {
  currentUserId: string;
  initialTrades: TradeRow[];
  inventory: OwnItem[];
  members: Member[];
  initialGifts: Array<{ id: string; status: string; created_at: string; recipient_name: string; card_name: string }>;
}) {
  const [trades, setTrades] = useState(initialTrades);
  const [detail, setDetail] = useState<TradeDetail | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [recipientItems, setRecipientItems] = useState<OwnItem[] | null>(null);
  const [proposerIds, setProposerIds] = useState<string[]>([]);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [giftInstance, setGiftInstance] = useState("");
  const [giftEmail, setGiftEmail] = useState("");
  const [gifts, setGifts] = useState(initialGifts);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function loadRecipient() {
    setBusy("recipient");
    setError("");
    try {
      const member = members.find((item) => item.id === recipientId);
      if (!member) throw new Error("Choose a member from this cabinet.");
      const result = await api<{ items: OwnItem[] }>(`/api/v1/members/${member.id}/trade-items`);
      setRecipientItems(result.items);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function createTrade() {
    setBusy("trade");
    setError("");
    setNotice("");
    try {
      await api("/api/v1/trades", {
        method: "POST",
        body: { recipientId, proposerInstanceIds: proposerIds, recipientInstanceIds: recipientIds },
      });
      setNotice("Offer sent. Both sides must accept the same revision before anything moves.");
      setProposerIds([]);
      setRecipientIds([]);
      setRecipientItems(null);
      await refreshTrades();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function refreshTrades() {
    const result = await api<{ items: TradeRow[] }>("/api/v1/trades");
    setTrades(result.items);
  }

  async function open(id: string) {
    setBusy(id);
    setError("");
    try {
      const result = await api<TradeDetail>(`/api/v1/trades/${id}`);
      setDetail(result);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function act(id: string, action: "accept" | "decline" | "cancel") {
    setBusy(`${action}-${id}`);
    setError("");
    try {
      await api(`/api/v1/trades/${id}/${action}`, { method: "POST", body: {} });
      await refreshTrades();
      const updated = await api<TradeDetail>(`/api/v1/trades/${id}`);
      setDetail(updated);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function sendGift() {
    setBusy("gift");
    setError("");
    setNotice("");
    try {
      await api("/api/v1/gifts", {
        method: "POST",
        body: { recipientEmail: giftEmail, instanceId: giftInstance },
        idempotencyKey: idempotencyKey("gift"),
      });
      setNotice("Gift sent. The card and its new ownership history have moved together.");
      setGiftEmail("");
      setGiftInstance("");
      setGifts((current) => current);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
      <div className="grid gap-6">
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        {notice ? <div className="success-box" role="status">{notice}</div> : null}
        <section>
          <div className="flex items-end justify-between gap-4">
            <div><p className="eyebrow">Your desk</p><h3 className="display-sm mt-1 text-3xl">Open offers</h3></div>
            <span className="font-mono text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">{trades.filter((trade) => trade.status === "open").length} open</span>
          </div>
          <div className="mt-4 grid gap-2">
            {trades.map((trade) => (
              <article key={trade.id} className="flex flex-wrap items-center justify-between gap-3 border border-[var(--line)] p-4">
                <div>
                  <p className="text-sm font-semibold">{trade.proposer_name} → {trade.recipient_name}</p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">{trade.item_count} cards · revision {trade.revision} · {trade.status} · expires {formatDual(trade.expires_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("badge", trade.status === "open" ? "badge-rare" : "")}>{trade.status}</span>
                  <Button size="sm" variant="secondary" onClick={() => open(trade.id)} disabled={Boolean(busy)}>View</Button>
                </div>
              </article>
            ))}
            {trades.length === 0 ? <div className="empty"><p>No offers yet. Create one below.</p></div> : null}
          </div>
        </section>

        <section className="surface-flat p-5">
          <div className="flex items-center gap-2"><Handshake size={18} className="text-[var(--brass)]" /><p className="eyebrow">New reciprocal offer</p></div>
          <p className="mt-2 text-sm text-[var(--muted)]">Choose what you offer and what you would like from the other member. Reservations are atomic; neither side can spend the same card twice.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
            <select className="select" value={recipientId} onChange={(event) => { setRecipientId(event.target.value); setRecipientItems(null); setRecipientIds([]); }} aria-label="Choose a member">
              <option value="">Choose a member</option>
              {members.filter((member) => member.id !== currentUserId).map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}
            </select>
            <Button variant="secondary" onClick={loadRecipient} disabled={busy === "recipient" || !recipientId}>{busy === "recipient" ? "Loading…" : "Load their shelf"}</Button>
          </div>
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <div>
              <p className="label">You offer ({proposerIds.length})</p>
              <div className="mt-2 max-h-56 overflow-auto border border-[var(--line)] p-2">
                {inventory.filter((item) => item.status === "owned" && !item.locked).map((item) => (
                  <label key={item.id} className="flex items-start gap-2 border-b border-[var(--line)] py-2 text-xs last:border-0">
                    <input type="checkbox" className="mt-1 accent-[var(--green)]" checked={proposerIds.includes(item.id)} onChange={() => setProposerIds((current) => toggle(current, item.id))} />
                    <span><span className="block font-semibold">{item.card_name}</span><span className="text-[var(--muted)]">{item.variant_name} · {item.serial}</span></span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="label">You request ({recipientIds.length})</p>
              <div className="mt-2 max-h-56 overflow-auto border border-[var(--line)] p-2">
                {recipientItems ? recipientItems.map((item) => (
                  <label key={item.id} className="flex items-start gap-2 border-b border-[var(--line)] py-2 text-xs last:border-0">
                    <input type="checkbox" className="mt-1 accent-[var(--green)]" checked={recipientIds.includes(item.id)} onChange={() => setRecipientIds((current) => toggle(current, item.id))} />
                    <span><span className="block font-semibold">{item.card_name}</span><span className="text-[var(--muted)]">{item.variant_name} · {item.serial}</span></span>
                  </label>
                )) : <p className="p-2 text-xs text-[var(--muted)]">Load a member&apos;s shelf to choose requested cards. Only owned cards are shown.</p>}
              </div>
            </div>
          </div>
          <div className="mt-4"><Button onClick={createTrade} disabled={busy === "trade" || !recipientId || proposerIds.length + recipientIds.length === 0}>{busy === "trade" ? "Sending…" : "Send offer"}</Button></div>
        </section>

        <section className="surface-flat p-5">
          <div className="flex items-center gap-2"><Gift size={18} className="text-[var(--brass)]" /><p className="eyebrow">Gift a card</p></div>
          <p className="mt-2 text-sm text-[var(--muted)]">A gift is labelled separately from a trade. It is a one-way transfer with its own receipt; it does not create a reciprocal expectation.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Input type="email" placeholder="Recipient email" value={giftEmail} onChange={(event) => setGiftEmail(event.target.value)} aria-label="Gift recipient email" />
            <select className="select" value={giftInstance} onChange={(event) => setGiftInstance(event.target.value)} aria-label="Card to gift">
              <option value="">Choose a card</option>
              {inventory.filter((item) => item.status === "owned" && !item.locked).map((item) => <option key={item.id} value={item.id}>{item.card_name} · {item.variant_name}</option>)}
            </select>
          </div>
          <div className="mt-3"><Button size="sm" variant="secondary" onClick={sendGift} disabled={busy === "gift" || !giftEmail || !giftInstance}>{busy === "gift" ? "Sending…" : "Send gift"}</Button></div>
          {gifts.length ? <div className="mt-4 border-t border-[var(--line)] pt-3"><p className="label">Recent gifts</p>{gifts.map((gift) => <p key={gift.id} className="mt-1 text-xs text-[var(--muted)]">{gift.card_name} → {gift.recipient_name} · {gift.status} · {formatDual(gift.created_at)}</p>)}</div> : null}
        </section>
      </div>

      <aside className="grid gap-4">
        <div className="surface-flat p-5">
          <div className="flex items-center gap-2"><PackageOpen size={17} className="text-[var(--brass)]" /><p className="eyebrow">How trades settle</p></div>
          <ol className="mt-3 grid gap-2 text-sm text-[var(--muted)]">
            <li>1. Every offered card is reserved in its owner&apos;s collection.</li>
            <li>2. Each side accepts the same revision. A changed offer invalidates prior acceptances.</li>
            <li>3. Both sides&apos; cards transfer in one transaction with ownership history.</li>
          </ol>
        </div>
        <div className="border border-[var(--line)] p-5">
          <p className="eyebrow">Authority</p>
          <p className="mt-2 text-sm text-[var(--muted)]">A member can only offer their own cards. An agent acts only for the member named in its grant; it cannot accept on behalf of both sides.</p>
        </div>
      </aside>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent>
          {detail ? (
            <>
              <DialogTitle>Offer revision {detail.revision}</DialogTitle>
              <DialogDescription>{detail.proposer_id === currentUserId ? "You proposed this offer." : "This offer is addressed to you."} Status: {detail.status}.</DialogDescription>
              <div className="mt-4 grid gap-4">
                {["proposer", "recipient"].map((side) => (
                  <div key={side}>
                    <p className="label">{side === "proposer" ? "They offer" : "You offer"}</p>
                    <div className="mt-1 grid gap-1">
                      {detail.items.filter((item) => item.side === side).map((item) => <p key={item.id} className="text-sm">{item.card_name} · {item.variant_name} · <span className="font-mono text-xs text-[var(--muted)]">{item.serial}</span></p>)}
                      {detail.items.filter((item) => item.side === side).length === 0 ? <p className="text-xs text-[var(--muted)]">No cards on this side.</p> : null}
                    </div>
                  </div>
                ))}
                <div>
                  <p className="label">Acceptances at this revision</p>
                  <p className="text-sm text-[var(--muted)]">{detail.acceptances.filter((item) => item.revision === detail.revision).length} of 2 recorded</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.status === "open" && detail.proposer_id === currentUserId ? <Button size="sm" variant="danger" onClick={() => act(detail.id, "cancel")} disabled={Boolean(busy)}>Cancel offer</Button> : null}
                  {detail.status === "open" && detail.recipient_id === currentUserId ? <Button size="sm" variant="danger" onClick={() => act(detail.id, "decline")} disabled={Boolean(busy)}>Decline</Button> : null}
                  {detail.status === "open" ? <Button size="sm" onClick={() => act(detail.id, "accept")} disabled={Boolean(busy)}>{busy === `accept-${detail.id}` ? "Accepting…" : "Accept this revision"}</Button> : null}
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
