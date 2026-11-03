"use client";

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input, Select } from "../ui/input";

interface Member {
  user_id: string;
  display_name: string;
  email: string;
  role: string;
}

interface Economy {
  currency_name: string;
  currency_symbol: string;
  version: number;
}

export default function StudioWallet({
  userId,
  canSelfGrant,
  grantLimit,
  capabilities,
}: {
  userId: string;
  canSelfGrant: boolean;
  grantLimit: number;
  capabilities: string[];
}) {
  const [economy, setEconomy] = useState<Economy | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [target, setTarget] = useState(userId);
  const [amount, setAmount] = useState(100);
  const [reason, setReason] = useState("Scoped Admin grant with recorded reason.");
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [denied, setDenied] = useState(false);

  async function load() {
    try {
      const [settings, people, wallet] = await Promise.all([
        api<Economy>("/api/v1/admin/economy"),
        api<{ items: Member[] }>("/api/v1/admin/members"),
        api<{ balance: number }>(`/api/v1/admin/wallets/${userId}`),
      ]);
      setEconomy(settings);
      setMembers(people.items);
      setBalance(wallet.balance);
    } catch (cause) {
      const text = describeError(cause);
      if (/role|cannot read|forbidden/i.test(text)) setDenied(true);
      else setError(text);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function grant() {
    setBusy("grant");
    setError("");
    setMessage("");
    try {
      const result = await api<{ balance_after: number; replayed?: boolean }>(
        `/api/v1/admin/wallets/${target}/adjust`,
        {
          method: "POST",
          body: { amount: Number(amount), reason },
          idempotencyKey: idempotencyKey("studio-grant"),
        },
      );
      setMessage(
        `Grant recorded once. ${target === userId ? "Your" : "That member's"} balance is now ✦ ${result.balance_after}.${result.replayed ? " This was the recorded replay; no second credit was made." : ""}`,
      );
      setBalance(target === userId ? result.balance_after : balance);
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  if (denied) {
    return (
      <div className="notice">
        <p className="text-sm">
          This account does not have Foil grant authority. Ask the Super Admin or Bot Owner to enable
          the <strong>grants</strong> capability. No wallet data is shown.
        </p>
      </div>
    );
  }
  if (!economy) return <div className="skeleton h-64" />;

  const grantCapability = capabilities.includes("grants") || capabilities.includes("economy");
  return (
    <div>
      <div className="studio-rule">
        <div>
          <h2 className="display-sm text-4xl uppercase">Foil, with a receipt.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            A grant is an audited wallet credit, not a price or odds change. Holding or viewing a card
            never creates passive income. Every grant writes one ledger and audit receipt.
          </p>
        </div>
        <span className="studio-stamp">{economy.currency_name}</span>
      </div>

      {error ? <div className="error-box mt-4" role="alert">{error}</div> : null}
      {message ? <div className="success-box mt-4" role="status">{message}</div> : null}

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <div className="border border-[var(--line)] p-5">
          <p className="studio-stat__label">Your balance</p>
          <p className="display-sm mt-2 text-3xl text-[var(--brass)]">
            {balance === null ? "—" : `✦ ${balance}`}
          </p>
        </div>
        <div className="border border-[var(--line)] p-5">
          <p className="studio-stat__label">Grant capability</p>
          <p className="mt-2 text-xl font-semibold">{grantCapability ? "Enabled" : "Not enabled"}</p>
          <p className="mt-2 text-sm text-[var(--muted)]">Visible and enforced by the server on every request.</p>
        </div>
        <div className="border border-[var(--line)] p-5">
          <p className="studio-stat__label">Policy ceiling</p>
          <p className="mt-2 text-xl font-semibold">✦ {grantLimit} per grant</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {canSelfGrant ? "Self-grants are enabled." : "Self-grants are disabled; you may grant to eligible others if the capability allows."}
          </p>
        </div>
      </div>

      <section className="surface mt-6 p-5">
        <p className="eyebrow">Record a grant</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Recipient" hint="The selected Bot's members only.">
            <Select value={target} onChange={(event) => setTarget(event.target.value)}>
              {members.map((member) => (
                <option key={member.user_id} value={member.user_id}>
                  {member.display_name} · {member.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Amount (${economy.currency_symbol})`} hint={`Positive whole number up to ✦ ${grantLimit}.`}>
            <Input
              type="number"
              min={1}
              max={grantLimit}
              value={amount}
              onChange={(event) => setAmount(Number(event.target.value))}
            />
          </Field>
          <Field label="Reason" hint="Shown in the ledger and audit history.">
            <Input value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={grant}
              disabled={
                busy === "grant" ||
                !grantCapability ||
                !reason.trim() ||
                amount < 1 ||
                amount > grantLimit ||
                (target === userId && !canSelfGrant)
              }
            >
              {busy === "grant" ? (
                <>
                  <Loader2 className="animate-spin" size={14} /> Recording…
                </>
              ) : (
                <>
                  <Sparkles size={14} /> Record one grant
                </>
              )}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Disabled buttons are a courtesy; the server rechecks the live capability, self-grant flag and
          ceiling at the mutation boundary. Revoked capabilities fail even from a stale form.
        </p>
      </section>
    </div>
  );
}
