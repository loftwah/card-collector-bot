"use client";

import { useEffect, useMemo, useState } from "react";
import { Gift, Loader2, Send, Users } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/input";

interface Member {
  id: string;
  display_name: string;
  role: string;
}

interface CardRow {
  id: string;
  name: string;
  collections?: Array<{ name: string }>;
}

interface Preview {
  recipient_count: number;
  sample: Array<{ user_id: string; display_name: string; tenant_name: string }>;
  per_recipient_foil: number;
  total_foil: number;
  openings_per_recipient: number;
  standard_opening_price: number;
  message: string | null;
  limits: { max_recipients: number; per_recipient_foil: number };
}

interface Campaign {
  id: string;
  kind: string;
  scope: string;
  status: string;
  expected_recipients: number;
  sent_count: number;
  failed_count: number;
  message: string | null;
  reason: string;
  created_at: string;
  created_by_name: string;
  delivered: number;
}

export default function GiftComposer({ platformAdmin }: { platformAdmin: boolean }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [kind, setKind] = useState<"foil" | "card" | "opening">("foil");
  const [scope, setScope] = useState<"single" | "recipients" | "bot_members" | "platform_members">("single");
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState(480);
  const [openings, setOpenings] = useState(1);
  const [cardId, setCardId] = useState("");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");

  async function load() {
    try {
      const [memberResult, cardResult, campaignResult] = await Promise.all([
        api<{ items: Member[] }>("/api/v1/admin/people"),
        api<{ items: CardRow[] }>("/api/v1/admin/cards?limit=200"),
        api<{ items: Campaign[] }>("/api/v1/admin/gifts"),
      ]);
      setMembers(memberResult.items);
      setCards(cardResult.items);
      setCampaigns(campaignResult.items);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(
    () =>
      members.filter((member) => {
        const haystack = `${member.display_name} ${member.role}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
      }),
    [members, query],
  );

  function payload() {
    return {
      kind,
      scope,
      userIds: scope === "single" || scope === "recipients" ? selected : undefined,
      amount: kind === "foil" ? Number(amount) : undefined,
      openings: kind === "opening" ? Number(openings) : undefined,
      cardId: kind === "card" ? cardId : undefined,
      message: message.trim() || undefined,
      reason: reason.trim(),
      ...(platformAdmin ? {} : { botId: null }),
    };
  }

  async function runPreview() {
    setBusy("preview");
    setError("");
    setNotice("");
    try {
      const result = await api<Preview>("/api/v1/admin/gifts/preview", { method: "POST", body: payload() });
      setPreview(result);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function send() {
    setBusy("send");
    setError("");
    setNotice("");
    try {
      const result = await api<{ campaign_id: string; sent_count: number; failed_count: number; status: string }>("/api/v1/admin/gifts", {
        method: "POST",
        body: payload(),
        idempotencyKey: idempotencyKey("gift"),
      });
      setNotice(`Gift ${result.status}: ${result.sent_count} delivered${result.failed_count ? `, ${result.failed_count} failed` : ""}. The receipt is in the recipient's Gifts page.`);
      setPreview(null);
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  const canSend = reason.trim().length >= 3 && (scope === "bot_members" || scope === "platform_members" || selected.length > 0) && (kind !== "card" || cardId);

  return (
    <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr] xl:items-start">
      <section className="surface p-5 md:p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[var(--ink)] text-[var(--paper)]"><Gift size={20} /></span>
          <div>
            <h2 className="display-sm text-3xl">Send a gift</h2>
            <p className="text-sm text-[var(--muted)]">A thank-you, a community prize or a quiet nudge. Every send is scoped, audited and idempotent.</p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="What are you sending?">
            <Select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="foil">Foil</option>
              <option value="opening">A standard opening</option>
              <option value="card">A specific card</option>
            </Select>
          </Field>
          <Field label="Who can receive it?">
            <Select value={scope} onChange={(event) => { setScope(event.target.value as typeof scope); setSelected([]); }}>
              <option value="single">One member</option>
              <option value="recipients">Selected members</option>
              <option value="bot_members">Everyone in this Bot</option>
              {platformAdmin ? <option value="platform_members">Everyone on the platform album</option> : null}
            </Select>
          </Field>
          {kind === "foil" ? (
            <Field label="Foil per recipient" hint={`Limit ${platformAdmin ? "10,000" : "1,000"} per recipient.`}>
              <Input type="number" min={1} max={platformAdmin ? 10000 : 1000} value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
            </Field>
          ) : null}
          {kind === "opening" ? (
            <Field label="Openings per recipient" hint="Credited as Foil at the current standard opening price.">
              <Input type="number" min={1} max={20} value={openings} onChange={(event) => setOpenings(Number(event.target.value))} />
            </Field>
          ) : null}
          {kind === "card" ? (
            <Field label="Card" hint="The recipient receives the base published finish, with a serial.">
              <Select value={cardId} onChange={(event) => setCardId(event.target.value)}>
                <option value="">Choose a card</option>
                {cards.map((card) => <option key={card.id} value={card.id}>{card.name}{card.collections?.[0] ? ` · ${card.collections[0].name}` : ""}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="Reason (required, audited)" hint="Visible to administrators in the campaign log.">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Community night thank-you" maxLength={500} />
          </Field>
        </div>

        {scope === "single" || scope === "recipients" ? (
          <div className="mt-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="label">Recipients</p>
                <p className="text-sm text-[var(--muted)]">{selected.length} selected · {members.length} members in this Bot</p>
              </div>
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or role" className="max-w-xs" />
            </div>
            <div className="mt-3 max-h-64 overflow-auto border border-[var(--line)]">
              {filtered.map((member) => {
                const checked = selected.includes(member.id);
                return (
                  <label key={member.id} className="flex cursor-pointer items-center gap-3 border-b border-[var(--line)] px-3 py-2 text-sm last:border-b-0 hover:bg-[var(--paper-2)]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        if (scope === "single") setSelected(checked ? [] : [member.id]);
                        else setSelected(checked ? selected.filter((id) => id !== member.id) : [...selected, member.id]);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{member.display_name}</span>
                      <span className="block truncate text-xs text-[var(--muted)]">{member.role}</span>
                    </span>
                  </label>
                );
              })}
              {filtered.length === 0 ? <p className="p-4 text-sm text-[var(--muted)]">No members match that search.</p> : null}
            </div>
          </div>
        ) : null}

        <div className="mt-5 grid gap-2">
          <Field label="Optional message" hint="Plain text, up to 280 characters. Mentions are neutralised.">
            <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={280} placeholder="A short note that appears on the receipt." />
          </Field>
        </div>

        {error ? <p className="error-box mt-4" role="alert">{error}</p> : null}
        {notice ? <p className="success-box mt-4" role="status">{notice}</p> : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={runPreview} disabled={busy !== "" || !canSend}>
            {busy === "preview" ? <Loader2 size={15} className="animate-spin" /> : <Users size={15} />} Preview recipients
          </Button>
          <Button onClick={send} disabled={busy !== "" || !canSend || !preview}>
            {busy === "send" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Send gift
          </Button>
        </div>
        {!preview ? <p className="mt-2 text-xs text-[var(--muted)]">Preview first. Sending asks for recent strong authentication and records the actor, scope and reason.</p> : null}

        {preview ? (
          <div className="notice mt-5" role="status">
            <p className="font-semibold">Ready to send</p>
            <p className="mt-1 text-sm">{preview.recipient_count} recipient{preview.recipient_count === 1 ? "" : "s"} · {preview.per_recipient_foil ? `✦ ${preview.per_recipient_foil} each` : "card gift"} · {preview.total_foil ? `✦ ${preview.total_foil} total` : "no currency total"}.</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{preview.sample.map((item) => item.display_name).join(", ")}{preview.recipient_count > preview.sample.length ? ` and ${preview.recipient_count - preview.sample.length} more` : ""}</p>
            {preview.message ? <p className="mt-2 border-l-2 border-[var(--brass)] pl-3 text-sm italic">“{preview.message}”</p> : null}
          </div>
        ) : null}
      </section>

      <aside className="grid gap-4">
        <section className="surface-flat p-5">
          <h3 className="display-sm text-2xl">How gifting behaves</h3>
          <ul className="mt-3 grid gap-2 text-sm text-[var(--muted)]">
            <li>• Foil gifts credit the recipient's Bot wallet and write a ledger row.</li>
            <li>• Opening gifts are credited at the current standard opening price, so the receipt is honest about what it is worth.</li>
            <li>• Card gifts create one owned copy with its own serial and history. They never re-roll a draw.</li>
            <li>• Retrying a send cannot double-deliver: each recipient award has its own idempotency.</li>
            <li>• Platform gifts create separate per-Bot awards, not one cross-tenant wallet credit.</li>
            <li>• Gifts never require payment and never create investment value.</li>
          </ul>
        </section>
        <section className="surface-flat p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="display-sm text-2xl">Recent campaigns</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => void load()}>Refresh</button>
          </div>
          <div className="mt-3 grid gap-2">
            {campaigns.slice(0, 8).map((campaign) => (
              <div key={campaign.id} className="border border-[var(--line)] p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold capitalize">{campaign.kind} · {campaign.scope.replaceAll("_", " ")}</span>
                  <span className="badge">{campaign.status}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--muted)]">{campaign.sent_count}/{campaign.expected_recipients} delivered{campaign.failed_count ? ` · ${campaign.failed_count} failed` : ""} · {campaign.created_by_name}</p>
                <p className="mt-1 truncate text-xs text-[var(--muted)]">{campaign.reason}</p>
              </div>
            ))}
            {campaigns.length === 0 ? <p className="text-sm text-[var(--muted)]">No gift campaigns yet.</p> : null}
          </div>
        </section>
      </aside>
    </div>
  );
}
