"use client";

import { useState } from "react";
import {
  ArrowLeftRight,
  Clock3,
  Gift,
  Handshake,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { ApiClientError, api, describeError, idempotencyKey } from "@/lib/client";
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

type PeerItem = Pick<OwnItem, "id" | "card_name" | "variant_name" | "serial" | "render_url"> & {
  material_key?: string;
  effect_key?: string | null;
};

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
  items: Array<{
    id: string;
    side: string;
    card_name: string;
    variant_name: string;
    serial: string;
    render_url: string | null;
  }>;
  acceptances: Array<{ user_id: string; revision: number; accepted_at: string }>;
}

const finishLabel = (material?: string, effect?: string | null) => {
  if (material === "diamond" || effect === "holographic") return "Holographic";
  if (material === "gold") return "Gold";
  if (material === "silver") return "Silver";
  if (material === "plain") return "Plain";
  return null;
};

function CopyRow({
  item,
  checked,
  onToggle,
}: {
  item: OwnItem | PeerItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={cn("trade-copy", checked && "is-selected")}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="trade-copy__art">
        {item.render_url ? (
          <img src={item.render_url} alt="" width="120" height="168" loading="lazy" />
        ) : (
          <span className="trade-copy__fallback">{item.card_name.charAt(0)}</span>
        )}
      </span>
      <span className="trade-copy__body">
        <span className="trade-copy__name">{item.card_name}</span>
        <span className="trade-copy__meta">
          {"material_key" in item ? finishLabel(item.material_key, item.effect_key) : null}
          {"material_key" in item && finishLabel(item.material_key, item.effect_key)
            ? " · "
            : ""}
          {item.variant_name}
        </span>
        <span className="trade-copy__serial">{item.serial}</span>
      </span>
    </label>
  );
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
  initialGifts: Array<{
    id: string;
    status: string;
    created_at: string;
    recipient_name: string;
    card_name: string;
  }>;
}) {
  const [trades, setTrades] = useState(initialTrades);
  const [detail, setDetail] = useState<TradeDetail | null>(null);
  const [recipientId, setRecipientId] = useState("");
  const [recipientItems, setRecipientItems] = useState<PeerItem[] | null>(null);
  const [proposerIds, setProposerIds] = useState<string[]>([]);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [giftInstance, setGiftInstance] = useState("");
  const [giftEmail, setGiftEmail] = useState("");
  const [gifts, setGifts] = useState(initialGifts);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [staleNotice, setStaleNotice] = useState("");
  const [view, setView] = useState<"incoming" | "outgoing" | "history">("incoming");

  const availableInventory = inventory.filter((item) => item.status === "owned" && !item.locked);
  const unavailableInventory = inventory.filter((item) => item.status !== "owned" || item.locked);
  const incoming = trades.filter((trade) => trade.status === "open" && trade.recipient_id === currentUserId);
  const outgoing = trades.filter((trade) => trade.status === "open" && trade.proposer_id === currentUserId);
  const history = trades.filter((trade) => trade.status !== "open");
  const currentRows = view === "incoming" ? incoming : view === "outgoing" ? outgoing : history;

  function toggle(list: string[], id: string) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function loadRecipient() {
    setBusy("recipient");
    setError("");
    setStaleNotice("");
    try {
      const member = members.find((item) => item.id === recipientId);
      if (!member) throw new Error("Choose a member from this cabinet.");
      const result = await api<{ items: PeerItem[] }>(`/api/v1/members/${member.id}/trade-items`);
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
    setStaleNotice("");
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
    setStaleNotice("");
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
    setStaleNotice("");
    try {
      await api(`/api/v1/trades/${id}/${action}`, { method: "POST", body: {} });
      await refreshTrades();
      const updated = await api<TradeDetail>(`/api/v1/trades/${id}`);
      setDetail(updated);
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 409) {
        await refreshTrades().catch(() => undefined);
        await open(id);
        setStaleNotice(
          "This offer changed before your action was recorded. Nothing moved. Reload the current revision before trying again.",
        );
      } else {
        setError(describeError(cause));
      }
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
      setNotice("Gift sent. The card and its new ownership history moved together.");
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
    <div className="trade-desk">
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="success-box" role="status">
          {notice}
        </div>
      ) : null}
      {staleNotice ? (
        <div className="notice" role="alert">
          <p className="font-semibold">The offer moved.</p>
          <p className="mt-1 text-sm">{staleNotice}</p>
        </div>
      ) : null}

      <section className="trade-panel">
        <div className="trade-panel__head">
          <div>
            <h2 className="trade-panel__title">Offers</h2>
          </div>
          <span className="trade-panel__meta">
            {incoming.length + outgoing.length} open · {history.length} settled
          </span>
        </div>

        <div className="trade-tabs" role="tablist" aria-label="Trade views">
          {(
            [
              ["incoming", "Incoming", incoming.length],
              ["outgoing", "Outgoing", outgoing.length],
              ["history", "History", history.length],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              className={cn("trade-tab", view === key && "is-active")}
              onClick={() => setView(key)}
            >
              {label} <span>{count}</span>
            </button>
          ))}
        </div>

        <div className="trade-list">
          {currentRows.map((trade) => (
            <article key={trade.id} className="trade-row">
              <div className="trade-row__main">
                <p className="trade-row__parties">
                  {trade.proposer_name} <ArrowLeftRight size={13} aria-hidden="true" />{" "}
                  {trade.recipient_name}
                </p>
                <p className="trade-row__meta">
                  {trade.item_count} exact {trade.item_count === 1 ? "copy" : "copies"} · revision{" "}
                  {trade.revision} · {trade.status} · expires {formatDual(trade.expires_at)}
                </p>
              </div>
              <div className="trade-row__actions">
                <span className={cn("badge", trade.status === "open" && "badge-signal")}>
                  {trade.status}
                </span>
                <Button size="sm" variant="secondary" onClick={() => open(trade.id)} disabled={Boolean(busy)}>
                  View offer
                </Button>
              </div>
            </article>
          ))}
          {currentRows.length === 0 ? (
            <div className="empty">
              <p>
                {view === "incoming"
                  ? "No incoming offers."
                  : view === "outgoing"
                    ? "No outgoing offers."
                    : "No settled offers yet."}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <div className="trade-workbench" id="workbench">
        <section className="trade-panel">
          <div className="trade-panel__head">
            <div>
              <h2 className="trade-panel__title">Exact-copy workbench</h2>
            </div>
            <Handshake size={18} className="text-[var(--brass)]" aria-hidden="true" />
          </div>
          <p className="trade-panel__lede">
            Choose what you give and what you receive. Both sides reserve the exact copies named
            here; neither side can spend the same card twice.
          </p>

          <div className="trade-member-picker">
            <label className="field">
              <span className="label">Trade with a member</span>
              <select
                className="select"
                value={recipientId}
                onChange={(event) => {
                  setRecipientId(event.target.value);
                  setRecipientItems(null);
                  setRecipientIds([]);
                }}
                aria-label="Choose a member"
              >
                <option value="">Choose a member</option>
                {members
                  .filter((member) => member.id !== currentUserId)
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              variant="secondary"
              onClick={loadRecipient}
              disabled={busy === "recipient" || !recipientId}
            >
              {busy === "recipient" ? "Loading…" : "Load their shelf"}
            </Button>
          </div>

          <div className="trade-sides">
            <div className="trade-side">
              <div className="trade-side__head">
                <p className="trade-side__title">You give</p>
                <span className="trade-side__count">{proposerIds.length} selected</span>
              </div>
              <div className="trade-copy-list">
                {availableInventory.map((item) => (
                  <CopyRow
                    key={item.id}
                    item={item}
                    checked={proposerIds.includes(item.id)}
                    onToggle={() => setProposerIds((current) => toggle(current, item.id))}
                  />
                ))}
                {availableInventory.length === 0 ? (
                  <p className="trade-side__empty">No eligible copies to offer.</p>
                ) : null}
              </div>
              {unavailableInventory.length ? (
                <p className="trade-side__note">
                  {unavailableInventory.length} cop
                  {unavailableInventory.length === 1 ? "y is" : "ies are"} reserved or locked and
                  cannot be offered.
                </p>
              ) : null}
            </div>

            <div className="trade-side">
              <div className="trade-side__head">
                <p className="trade-side__title">You receive</p>
                <span className="trade-side__count">{recipientIds.length} selected</span>
              </div>
              <div className="trade-copy-list">
                {recipientItems ? (
                  recipientItems.map((item) => (
                    <CopyRow
                      key={item.id}
                      item={item}
                      checked={recipientIds.includes(item.id)}
                      onToggle={() => setRecipientIds((current) => toggle(current, item.id))}
                    />
                  ))
                ) : (
                  <p className="trade-side__empty">
                    Load a member&apos;s shelf to choose requested copies. Only owned, unlocked
                    copies are shown.
                  </p>
                )}
                {recipientItems && recipientItems.length === 0 ? (
                  <p className="trade-side__empty">That shelf has no eligible copies.</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="trade-submit">
            <Button
              onClick={createTrade}
              disabled={
                busy === "trade" || !recipientId || proposerIds.length + recipientIds.length === 0
              }
            >
              {busy === "trade" ? "Sending…" : "Send offer"}
            </Button>
            <p className="trade-submit__note">
              Revision 1 is created now. A changed offer invalidates earlier acceptances.
            </p>
          </div>
        </section>

        <aside className="trade-aside">
          <div className="trade-npc">
            <div className="flex items-center gap-2">
              <span className="badge">NPC</span>
              <p className="eyebrow">Automated collectors</p>
            </div>
            <p>
              NPC collectors are fictional, labelled NPC everywhere, and read-only in this release.
              They are not human members and cannot accept a trade here.
            </p>
            <a className="btn btn-secondary btn-sm mt-3" href="/play/rivals">
              Browse the NPC lounge
            </a>
          </div>

          <div className="trade-steps">
            <div className="flex items-center gap-2">
              <PackageOpen size={17} className="text-[var(--brass)]" aria-hidden="true" />
              <p className="eyebrow">How a trade settles</p>
            </div>
            <ol>
              <li>
                <span>1</span> Every offered copy is reserved in its owner&apos;s collection.
              </li>
              <li>
                <span>2</span> Each side accepts the same revision. A changed offer invalidates
                prior acceptances.
              </li>
              <li>
                <span>3</span> Both sides&apos; copies transfer in one transaction with ownership
                history.
              </li>
            </ol>
          </div>

          <div className="trade-authority">
            <ShieldCheck size={17} className="text-[var(--brass)]" aria-hidden="true" />
            <p>
              A member can only offer their own copies. An agent acts only for the member named in
              its grant; it cannot accept on behalf of both sides.
            </p>
          </div>
        </aside>
      </div>

      <section className="trade-panel">
        <div className="trade-panel__head">
          <div>
            <h2 className="trade-panel__title">Send a card gift</h2>
          </div>
          <Gift size={18} className="text-[var(--brass)]" aria-hidden="true" />
        </div>
        <p className="trade-panel__lede">
          A gift is labelled separately from a trade. It is a one-way transfer with its own receipt;
          it does not create a reciprocal expectation.
        </p>
        <div className="trade-gift">
          <Input
            type="email"
            placeholder="Recipient email"
            value={giftEmail}
            onChange={(event) => setGiftEmail(event.target.value)}
            aria-label="Gift recipient email"
          />
          <select
            className="select"
            value={giftInstance}
            onChange={(event) => setGiftInstance(event.target.value)}
            aria-label="Card to gift"
          >
            <option value="">Choose an exact copy</option>
            {availableInventory.map((item) => (
              <option key={item.id} value={item.id}>
                {item.card_name} · {item.variant_name} · {item.serial}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            onClick={sendGift}
            disabled={busy === "gift" || !giftEmail || !giftInstance}
          >
            {busy === "gift" ? "Sending…" : "Send gift"}
          </Button>
        </div>
        {gifts.length ? (
          <div className="trade-gift__history">
            <p className="label">Recent gifts</p>
            {gifts.map((gift) => (
              <p key={gift.id}>
                {gift.card_name} → {gift.recipient_name} · {gift.status} ·{" "}
                {formatDual(gift.created_at)}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent>
          {detail ? (
            <>
              <DialogTitle>
                {detail.status === "open" ? "Offer review" : "Settled offer"} · revision{" "}
                {detail.revision}
              </DialogTitle>
              <DialogDescription>
                {detail.proposer_id === currentUserId
                  ? "You proposed this offer."
                  : "This offer is addressed to you."}{" "}
                Status: {detail.status}. Expires {formatDual(detail.expires_at)}.
              </DialogDescription>
              <div className="trade-dialog">
                {(["proposer", "recipient"] as const).map((side) => {
                  const yours = (side === "proposer") === (detail.proposer_id === currentUserId);
                  return (
                    <div key={side} className="trade-dialog__side">
                      <p className="trade-dialog__label">
                        {yours ? "You give" : "You receive"}
                      </p>
                      <div className="trade-dialog__copies">
                        {detail.items
                          .filter((item) => item.side === side)
                          .map((item) => (
                            <div key={item.id} className="trade-dialog__copy">
                              <span className="trade-dialog__art">
                                {item.render_url ? (
                                  <img src={item.render_url} alt="" loading="lazy" />
                                ) : (
                                  <span>{item.card_name.charAt(0)}</span>
                                )}
                              </span>
                              <span>
                                <strong>{item.card_name}</strong>
                                <span className="block text-xs text-[var(--muted)]">
                                  {item.variant_name} · {item.serial}
                                </span>
                              </span>
                            </div>
                          ))}
                        {detail.items.filter((item) => item.side === side).length === 0 ? (
                          <p className="text-xs text-[var(--muted)]">No copies on this side.</p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <div className="trade-dialog__acceptances">
                  <Clock3 size={14} aria-hidden="true" />
                  <p>
                    Acceptances at this revision:{" "}
                    <strong>
                      {detail.acceptances.filter((item) => item.revision === detail.revision).length}{" "}
                      of 2
                    </strong>
                  </p>
                </div>
                {staleNotice ? (
                  <div className="notice" role="alert">
                    {staleNotice}
                  </div>
                ) : null}
                <div className="trade-dialog__actions">
                  {detail.status === "open" && detail.proposer_id === currentUserId ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => act(detail.id, "cancel")}
                      disabled={Boolean(busy)}
                    >
                      Cancel offer
                    </Button>
                  ) : null}
                  {detail.status === "open" && detail.recipient_id === currentUserId ? (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => act(detail.id, "decline")}
                      disabled={Boolean(busy)}
                    >
                      Decline
                    </Button>
                  ) : null}
                  {detail.status === "open" ? (
                    <Button
                      size="sm"
                      onClick={() => act(detail.id, "accept")}
                      disabled={Boolean(busy)}
                    >
                      {busy === `accept-${detail.id}` ? "Accepting…" : "Accept this revision"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => open(detail.id)}
                    disabled={Boolean(busy)}
                  >
                    <RefreshCw size={13} /> Refresh offer
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
