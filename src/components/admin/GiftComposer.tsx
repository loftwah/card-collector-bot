"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Gift, Loader2, Send, Users } from "lucide-react";
import { api, ApiClientError, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/input";

interface Member {
  id: string;
  email?: string;
  display_name: string;
  role?: string;
}

interface CardRow {
  id: string;
  name: string;
  collections?: Array<{ name: string }>;
  variant_id?: string;

}

interface Preview {
  recipient_count: number;
  recipient_digest: string;
  sample: Array<{ user_id: string; display_name: string; tenant_name: string }>;
  per_recipient_foil: number;
  total_foil: number;
  openings_per_recipient: number;
  standard_opening_price: number;
  standard_opening_revision: number | null;
  message: string | null;
  limits: { max_recipients: number; per_recipient_foil: number; self_grants_allowed: boolean };
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

export default function GiftComposer({ platformAdmin, scoped = false }: { platformAdmin: boolean; scoped?: boolean }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [policy, setPolicy] = useState<{per_recipient_foil:number;self_grants_allowed:boolean} | null>(null);
  const [kind, setKind] = useState<"foil" | "card" | "opening">("foil");
  const [scope, setScope] = useState<"single" | "recipients" | "bot_members" | "platform_members">("single");
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState(480);
  const hasInitialPolicy = useRef(false);
  const [openings, setOpenings] = useState(1);
  const [cardId, setCardId] = useState("");
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPayload, setPreviewPayload] = useState("");
  const [uncertainGift, setUncertainGift] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");

  async function load() {
    try {
      const [memberResult, cardResult, campaignResult, policyResult] = await Promise.all([
        api<{ items: Member[] }>(scoped ? "/api/v1/admin/gifts/recipients" : "/api/v1/admin/members"),
        api<{ items: CardRow[] }>(scoped ? "/api/v1/admin/gifts/cards" : "/api/v1/admin/cards?limit=200"),
        api<{ items: Campaign[] }>("/api/v1/admin/gifts"),
        api<{per_recipient_foil:number;self_grants_allowed:boolean}>("/api/v1/admin/gifts/policy"),
      ]);
      setMembers(memberResult.items);
      setCards(cardResult.items);
      setCampaigns(campaignResult.items);
      setPolicy(policyResult);
      if (!hasInitialPolicy.current) {
        setAmount((current) => Math.min(current, policyResult.per_recipient_foil));
        hasInitialPolicy.current = true;
      }
    } catch (cause) {
      setPolicy(null);
      setError(describeError(cause));
    }
  }

  useEffect(() => {
    setUncertainGift(Boolean(sessionStorage.getItem('foilbury.pending-gift')));
    void load();
  }, []);

  const filtered = useMemo(
    () =>
      members.filter((member) => {
        const haystack = `${member.display_name} ${member.email ?? ""} ${member.id}`.toLowerCase();
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
      variantId: kind === "card" && scoped ? cards.find((card) => card.id === cardId)?.variant_id : undefined,
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
      setPolicy({per_recipient_foil:result.limits.per_recipient_foil,self_grants_allowed:result.limits.self_grants_allowed});
      setPreviewPayload(JSON.stringify(payload()));
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
    let firstAttempt = false;
    try {
      const body = { ...payload(), expectedRecipientsDigest:preview?.recipient_digest, ...(kind === 'opening' && preview ? {expectedOpeningPrice:preview.standard_opening_price,expectedPoolRevision:preview.standard_opening_revision} : {}) };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map((part)=>part.toString(16).padStart(2,'0')).join('');
      const stored = sessionStorage.getItem('foilbury.pending-gift');
      const pending = stored ? JSON.parse(stored) as {fingerprint:string;key:string} : null;
      if (pending && pending.fingerprint !== fingerprint) throw new Error('A previous gift may have been sent. Check campaign history before starting another gift.');
      const key = pending?.key ?? idempotencyKey('gift');
      firstAttempt = !pending;
      sessionStorage.setItem('foilbury.pending-gift',JSON.stringify({fingerprint,key}));
      setUncertainGift(true);
      const result = await api<{ campaign_id: string; sent_count: number; failed_count: number; status: string }>("/api/v1/admin/gifts", {
        method: "POST",
        body,
        idempotencyKey: key,
      });
      sessionStorage.removeItem('foilbury.pending-gift');
      setUncertainGift(false);
      setNotice(`Gift ${result.status}: ${result.sent_count} delivered${result.failed_count ? `, ${result.failed_count} failed` : ""}. Review the campaign for any pending awards.`);
      setPreview(null);
      await load();
    } catch (cause) {
      void load();
      // These codes are only emitted before campaign commit. A previous
      // ambiguous attempt with this key must still be reconciled instead.
      if (firstAttempt && cause instanceof ApiClientError && ['gift_recipients_changed','gift_preview_required','gift_price_changed','amount_limit','amount_invalid','openings_invalid','card_required','reason_required','recipients_required','recipient_limit','recipient_invalid','variant_invalid','gift_pool_unavailable','opening_scope_unavailable'].includes(cause.code)) {
        sessionStorage.removeItem('foilbury.pending-gift');
        setUncertainGift(false);
        setPreview(null);
      }
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function checkPendingGift() {
    setBusy('recovery');
    setError('');
    try {
      const stored=sessionStorage.getItem('foilbury.pending-gift');
      if (!stored) { setUncertainGift(false); return; }
      const pending=JSON.parse(stored) as {key:string};
      const result=await api<{found:boolean;campaign?:{id:string;status:string;sent_count:number;pending_count:number}}>(`/api/v1/admin/gifts/recovery/${encodeURIComponent(pending.key)}`);
      if (!result.found || !result.campaign) {
        setNotice('No campaign is visible yet. The request may still be in progress; check again before starting another gift.');
        return;
      }
      setNotice(`Recovered campaign ${result.campaign.id}: ${result.campaign.sent_count} delivered, ${result.campaign.pending_count} pending. Review it in campaign history.`);
      sessionStorage.removeItem('foilbury.pending-gift');
      setUncertainGift(false);
      await load();
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(''); }
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
            <Field label="Foil per recipient" hint={policy ? `Your current limit is ${policy.per_recipient_foil.toLocaleString()} Foil per recipient. ${policy.self_grants_allowed ? "You may gift yourself." : "Self-gifts are not enabled."}` : "Your current grant limit is unavailable; refresh after confirming your access."}>
              <Input type="number" min={1} max={policy?.per_recipient_foil ?? (platformAdmin ? 10000 : 1000)} disabled={!policy} value={amount} onChange={(event) => setAmount(Number(event.target.value))} />
            </Field>
          ) : null}
          {kind === "opening" ? (
            <Field label="Openings per recipient" hint={policy ? `Credited as Foil at the reviewed opening price. Your current limit is ${policy.per_recipient_foil.toLocaleString()} Foil per recipient. ${policy.self_grants_allowed ? "You may gift yourself." : "Self-gifts are not enabled."}` : "Your current grant limit is unavailable; refresh after confirming your access."}>
              <Input type="number" min={1} max={20} value={openings} onChange={(event) => setOpenings(Number(event.target.value))} />
            </Field>
          ) : null}
          {kind === "card" ? (
            <Field label="Card" hint={scoped ? "Choose from public-approved cards enabled for this Bot. One available print is selected; each recipient must still be eligible." : "The recipient receives the base published finish, with a serial."}>
              <Select value={cardId} onChange={(event) => setCardId(event.target.value)}>
                <option value="">Choose a card</option>
                {cards.map((card) => <option key={card.id} value={card.id}>{card.name}{!scoped && card.collections?.[0] ? ` · ${card.collections[0].name}` : ""}</option>)}
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
                <p className="text-sm text-[var(--muted)]">{selected.length} selected · {members.length} {members.length === 1 ? "member" : "members"} in this Bot</p>
              </div>
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={scoped ? "Search name or member ID" : "Search name or email"} className="max-w-xs" />
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
                      <span className="block truncate text-xs text-[var(--muted)]">{scoped ? member.id : `${member.email} · ${member.role}`}</span>
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
          <Button onClick={send} disabled={busy !== "" || !canSend || !preview || previewPayload !== JSON.stringify(payload())}>
            {busy === "send" ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Send gift
          </Button>
          {preview && previewPayload !== JSON.stringify(payload()) ? <p className="text-xs text-[var(--muted)]">The gift changed. Preview it again before sending.</p> : null}
          {uncertainGift ? <Button variant="secondary" onClick={checkPendingGift} disabled={busy !== ''}>Check pending gift</Button> : null}
        </div>
        {!preview ? <p className="mt-2 text-xs text-[var(--muted)]">Preview first. Sending asks for recent strong authentication and records the actor, scope and reason.</p> : null}

        {preview ? (
          <div className="notice mt-5" role="status">
            <p className="font-semibold">Ready to send</p>
            <p className="mt-1 text-sm">{preview.recipient_count} recipient{preview.recipient_count === 1 ? "" : "s"} · {preview.per_recipient_foil ? `✦ ${preview.per_recipient_foil} each` : "card gift"} · {preview.total_foil ? `✦ ${preview.total_foil} total` : "no currency total"}.</p>
            {kind === 'opening' ? <p className="mt-2 text-xs text-[var(--muted)]">This credits Foil at the reviewed pool price. Future opening prices can change; it does not reserve an opening.</p> : null}
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
            <li>• Opening gifts are credited in Foil at the reviewed standard opening price.</li>
            <li>• Card gifts create one owned copy with its own serial and history. They never re-roll a draw.</li>
            <li>• Retrying a send cannot double-deliver: each recipient award has its own idempotency.</li>
            {!scoped && platformAdmin ? <li>• Platform gifts create separate per-Bot awards, not one cross-tenant wallet credit.</li> : null}
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
