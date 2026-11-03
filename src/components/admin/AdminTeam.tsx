"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input } from "../ui/input";

const CAPABILITIES = [
  { key: "content", label: "Edit cards and artwork" },
  { key: "publish", label: "Publish catalogue" },
  { key: "economy", label: "Manage economy" },
  { key: "grants", label: "Grant Foil (within the visible limit)" },
  { key: "inventory", label: "Inspect inventory" },
  { key: "members", label: "Invite and revoke admins" },
  { key: "settings", label: "Bot settings" },
  { key: "npc.manage", label: "Manage NPC collectors" },
];

interface TeamData {
  bot: { id: string; name: string; slug: string; tenant_id: string };
  admins: Array<{
    user_id: string;
    display_name: string;
    email: string;
    role: string;
    capabilities_json: string;
    status: string;
    accepted_at: string | null;
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
  }>;
  invitations: Array<{ id: string; email: string; capabilities_json: string; status: string; created_at: string; expires_at: string }>;
  current_role: string;
}

export default function AdminTeam() {
  const [data, setData] = useState<TeamData | null>(null);
  const [email, setEmail] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>(["content", "publish"]);
  const [expires, setExpires] = useState(7);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draftCaps, setDraftCaps] = useState<string[]>([]);
  const [draftSelf, setDraftSelf] = useState(false);
  const [draftLimit, setDraftLimit] = useState(500);
  const [draftReason, setDraftReason] = useState("Reviewed scoped Admin capability change.");

  function beginEdit(admin: TeamData["admins"][number]) {
    setEditing(admin.user_id);
    setDraftCaps(JSON.parse(admin.capabilities_json || "[]") as string[]);
    setDraftSelf(Boolean(admin.self_grants_enabled));
    setDraftLimit(admin.grant_limit ?? 500);
    setDraftReason("Reviewed scoped Admin capability change.");
  }

  async function saveCapabilities(userId: string) {
    setBusy(userId);
    setError("");
    setMessage("");
    try {
      await api(`/api/v1/admin/bot/admins/${userId}`, {
        method: "PATCH",
        body: {
          capabilities: draftCaps,
          selfGrantsEnabled: draftSelf,
          grantLimit: draftLimit,
          reason: draftReason,
        },
      });
      setMessage("Scoped Admin capability updated. The next request uses the new policy; stale confirmations fail.");
      setEditing(null);
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function load() {
    try {
      setData(await api<TeamData>("/api/v1/admin/bot"));
    } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy("invite"); setError(""); setMessage("");
    try {
      const result = await api<{ expiresAt: string; devToken?: string }>("/api/v1/admin/bot/invitations", { method: "POST", body: { email, capabilities, expiresInDays: expires } });
      setMessage(`Invitation sent to ${email}. It is single-use, bound to that address and expires ${new Date(result.expiresAt).toLocaleDateString("en-AU")}.`);
      setEmail("");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function revoke(userId: string) {
    setBusy(userId); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/bot/admins/${userId}/revoke`, { method: "POST", body: {} });
      setMessage("Bot Admin access revoked. Their Foilbury account and collection remain intact.");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  if (!data) return <div className="skeleton h-64" />;
  return (
    <div>
      <div className="border-b border-[var(--line)] pb-5">
        <p className="eyebrow">Team · {data.current_role}</p>
        <h2 className="display-sm mt-1 text-4xl">Only the Bot you were given.</h2>
        <p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">Bot Owner is ownership of {data.bot.name}. Bot Admin is delegated, explicitly scoped management. Discord server roles and a Cloudflare Access session never grant either. Invitations are expiring, single-use and bound to the invited email.</p>
      </div>
      {error ? <div className="error-box mt-4" role="alert">{error}</div> : null}
      {message ? <div className="success-box mt-4" role="status">{message}</div> : null}

      <div className="mt-6 grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
        <section className="surface-flat p-5">
          <p className="eyebrow">Current access</p>
          <div className="mt-3 grid gap-2">
            {data.admins.map((admin) => {
              const caps = JSON.parse(admin.capabilities_json || "[]") as string[];
              return (
                <div key={admin.user_id} className="border border-[var(--line)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="font-semibold">{admin.display_name}</p><p className="break-all text-xs text-[var(--muted)]">{admin.email}</p></div>
                    <span className="badge badge-rare"><ShieldCheck size={12} /> {admin.role === "owner" ? "Bot Owner" : "Bot Admin"}</span>
                  </div>
                  <p className="mt-2 text-xs text-[var(--muted)]">Capabilities: {caps.join(", ") || "none"}</p>
                  {admin.role !== "owner" ? (
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      Money policy: {caps.includes("grants") ? "grant capability" : "no grant capability"} ·
                      {admin.self_grants_enabled ? " self-grants enabled" : " self-grants disabled"} ·
                      limit ✦ {admin.grant_limit} per grant · revision {admin.capability_revision}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--muted)]">Granted {admin.accepted_at ? new Date(admin.accepted_at).toLocaleDateString("en-AU") : "—"}</p>
                  {editing === admin.user_id ? (
                    <div className="mt-3 grid gap-3 border-t border-[var(--line)] pt-3">
                      <fieldset>
                        <legend className="label">Capabilities</legend>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {CAPABILITIES.map((capability) => (
                            <label key={capability.key} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={draftCaps.includes(capability.key)}
                                onChange={(event) =>
                                  setDraftCaps((items) =>
                                    event.target.checked
                                      ? [...items, capability.key]
                                      : items.filter((item) => item !== capability.key),
                                  )
                                }
                              />
                              {capability.label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={draftSelf} disabled={!draftCaps.includes("grants")} onChange={(event) => setDraftSelf(event.target.checked)} />
                        Allow this Admin to grant Foil to themselves
                      </label>
                      <Field label="Grant limit (Foil per operation)" hint="0–5,000; visible and enforced by the same policy.">
                        <Input type="number" min={0} max={5000} value={draftLimit} onChange={(event) => setDraftLimit(Number(event.target.value))} />
                      </Field>
                      <Field label="Reason for the change" hint="Recorded in the audit log.">
                        <Input value={draftReason} onChange={(event) => setDraftReason(event.target.value)} />
                      </Field>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => saveCapabilities(admin.user_id)} disabled={Boolean(busy) || draftCaps.length === 0 || draftReason.trim().length < 3}>
                          Save policy
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)} disabled={Boolean(busy)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {admin.role !== "owner" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => beginEdit(admin)} disabled={Boolean(busy)}>Edit capability</Button>
                      <Button size="sm" variant="danger" onClick={() => revoke(admin.user_id)} disabled={Boolean(busy)}><Trash2 size={13} /> Revoke access</Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="surface p-5">
          <p className="eyebrow">Invite a Bot Admin</p>
          <h3 className="display-sm mt-1 text-2xl">A second pair of hands.</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">The invitee must sign in with this email, verify it and have a passkey or authenticator before accepting. They never receive Super Admin or another Bot.</p>
          <form onSubmit={invite} className="mt-4 grid gap-3">
            <Field label="Email"><Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="collaborator@example.com" required /></Field>
            <fieldset>
              <legend className="label">Capabilities</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {CAPABILITIES.map((capability) => (
                  <label key={capability.key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={capabilities.includes(capability.key)} onChange={(event) => setCapabilities((items) => event.target.checked ? [...items, capability.key] : items.filter((item) => item !== capability.key))} />
                    {capability.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Expires in days" hint="1–30 days"><Input type="number" min={1} max={30} value={expires} onChange={(event) => setExpires(Number(event.target.value))} /></Field>
            <Button type="submit" disabled={busy === "invite" || !email || capabilities.length === 0}>{busy === "invite" ? <><Loader2 className="animate-spin" size={14} /> Sending…</> : <><UserPlus size={14} /> Send invitation</>}</Button>
          </form>
          <div className="mt-5 border-t border-[var(--line)] pt-4">
            <p className="eyebrow">Pending invitations</p>
            <div className="mt-2 grid gap-2">
              {data.invitations.filter((invitation) => invitation.status === "pending").map((invitation) => (
                <div key={invitation.id} className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2 break-all"><Mail size={13} /> {invitation.email}</span><span className="font-mono text-[0.56rem] text-[var(--muted)]">expires {new Date(invitation.expires_at).toLocaleDateString("en-AU")}</span></div>
              ))}
              {data.invitations.filter((invitation) => invitation.status === "pending").length === 0 ? <p className="text-sm text-[var(--muted)]">No pending invitations.</p> : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
