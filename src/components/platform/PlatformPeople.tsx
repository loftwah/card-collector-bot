"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Search, ShieldCheck, UserRound, Users, X } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Field, Input, Select, Textarea } from "../ui/input";

interface Role {
  role: string;
  scopes: { all?: boolean; collectionIds?: string[] };
  status: string;
  granted_at: string;
  reason: string;
}

interface Person {
  id: string;
  email: string;
  display_name: string;
  platform_admin: number;
  email_verified_at: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  platform_roles: Role[];
  memberships: Array<{ tenant_name: string; tenant_slug: string; role: string; capabilities: string[] }>;
  bot_roles: Array<{ bot_id: string; bot_name: string; role: string; capabilities: string[] }>;
  pending_invitations: Array<{ bot_name: string; email: string; status: string; expires_at: string }>;
}

const roleLabel: Record<string, string> = {
  global_collection_admin: "Global Collection Admin",
  super_admin: "Super Admin",
  owner: "Bot Owner",
  editor: "Bot Admin",
  economy_admin: "Bot Admin",
  player: "User",
};

function fmt(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Melbourne" }).format(new Date(value));
}

function scopesLabel(scopes: Role["scopes"]) {
  if (scopes.all !== false) return "All shared collections";
  return `${scopes.collectionIds?.length ?? 0} assigned collection${(scopes.collectionIds?.length ?? 0) === 1 ? "" : "s"}`;
}

export default function PlatformPeople() {
  const [people, setPeople] = useState<Person[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Person | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [form, setForm] = useState({ reason: "", all: true, collectionIds: "" });

  async function load() {
    setError("");
    try {
      const result = await api<{ items: Person[] }>(`/api/v1/platform/people?search=${encodeURIComponent(search)}&role=${encodeURIComponent(filter)}`);
      setPeople(result.items);
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  useEffect(() => { void load(); }, [filter]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const selectedRole = selected?.platform_roles.find((role) => role.role === "global_collection_admin" && role.status === "active") ?? null;

  async function assign() {
    if (!selected) return;
    setBusy("assign");
    setError("");
    setMessage("");
    try {
      const result = await api<{ changed: boolean }>("/api/v1/platform/roles", {
        method: "POST",
        body: {
          userId: selected.id,
          role: "global_collection_admin",
          scopes: form.all ? { all: true } : { all: false, collectionIds: form.collectionIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean) },
          reason: form.reason,
        },
      });
      setMessage(result.changed ? `Global Collection Admin granted to ${selected.display_name}. The Worker will enforce it on the next request.` : `No change: ${selected.display_name} already has that scope.`);
      setAssignOpen(false);
      setForm({ reason: "", all: true, collectionIds: "" });
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function revoke() {
    if (!selected) return;
    setBusy("revoke");
    setError("");
    setMessage("");
    try {
      await api(`/api/v1/platform/roles/${selected.id}/revoke`, {
        method: "POST",
        body: { role: "global_collection_admin", reason: form.reason || "Revoked by Super Admin from the People & roles area." },
      });
      setMessage(`Global Collection Admin revoked for ${selected.display_name}. Existing cards, Bot memberships and audit history are untouched.`);
      setConfirmRevoke(false);
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  const counts = useMemo(() => ({
    all: people.length,
    super: people.filter((person) => person.platform_admin).length,
    global: people.filter((person) => person.platform_roles.some((role) => role.role === "global_collection_admin" && role.status === "active")).length,
    bot: people.filter((person) => person.bot_roles.length > 0 || person.memberships.some((membership) => membership.role !== "player")).length,
  }), [people]);

  return (
    <div>
      <div className="border-b border-[var(--line)] pb-5">
        <p className="studio-kicker text-[var(--teal)]">People · roles · access</p>
        <h2 className="display-sm mt-2 text-4xl uppercase">Who can change what.</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">Super Admin is provisioned separately and cannot be granted here. Global Collection Admin is a scoped platform role: shared collections, metadata, branding and release state, without platform root. Bot roles remain inside their own Bot.</p>
      </div>

      {error ? <div className="error-box mt-4" role="alert">{error}</div> : null}
      {message ? <div className="success-box mt-4" role="status">{message}</div> : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        {[
          { label: "Accounts in view", value: counts.all, Icon: Users },
          { label: "Super Admin", value: counts.super, Icon: ShieldCheck },
          { label: "Global Collection Admin", value: counts.global, Icon: UserRound },
          { label: "Bot-scoped admins", value: counts.bot, Icon: Users },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="border border-[var(--line)] bg-[var(--paper)] p-3">
            <div className="flex items-center justify-between gap-2"><p className="studio-stat__label">{label}</p><Icon size={15} aria-hidden="true" /></div>
            <p className="display-sm mt-1 text-3xl">{value}</p>
          </div>
        ))}
      </div>

      <form className="mt-6 grid gap-3 border-y border-[var(--line)] py-4 md:grid-cols-[1fr_auto]" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label className="field">
          <span className="label">Search people</span>
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" aria-hidden="true" />
            <input className="input pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, Discord username or ID" />
          </div>
        </label>
        <label className="field">
          <span className="label">Filter</span>
          <select className="select" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">Everyone</option>
            <option value="super_admin">Super Admin</option>
            <option value="global_collection_admin">Global Collection Admin</option>
            <option value="bot_admin">Bot-scoped admins</option>
            <option value="user">Ordinary users</option>
          </select>
        </label>
      </form>

      <div className="mt-5 grid gap-3">
        {people.map((person) => {
          const globalRole = person.platform_roles.find((role) => role.role === "global_collection_admin" && role.status === "active");
          const botRoles = person.bot_roles.map((role) => role.role === "owner" ? `${role.bot_name} · Owner` : `${role.bot_name} · Admin`);
          return (
            <article key={person.id} className="grid gap-3 border border-[var(--line)] bg-[var(--paper)] p-4 md:grid-cols-[1fr_auto] md:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">{person.display_name}</h3>
                  {person.platform_admin ? <span className="badge badge-rare">Super Admin</span> : null}
                  {globalRole ? <span className="badge badge-signal">Global Collection Admin</span> : null}
                  {!person.platform_admin && !globalRole ? <span className="badge">User</span> : null}
                  {person.email_verified_at ? <span className="badge">Email verified</span> : <span className="badge">Email unverified</span>}
                </div>
                <p className="mt-1 break-all text-sm text-[var(--muted)]">{person.email}</p>
                <p className="mt-1 font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                  {person.discord_username ? `Discord @${person.discord_username}` : "No Discord link"} · {person.id}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {person.memberships.filter((membership) => membership.role !== "player").map((membership) => (
                    <span key={membership.tenant_slug} className="badge">{membership.tenant_name} · {roleLabel[membership.role] ?? membership.role}</span>
                  ))}
                  {botRoles.map((label) => <span key={label} className="badge">{label}</span>)}
                  {person.pending_invitations.map((invitation) => <span key={`${invitation.bot_name}-${invitation.expires_at}`} className="badge">Invite pending · {invitation.bot_name}</span>)}
                </div>
                {globalRole ? <p className="mt-2 text-xs text-[var(--muted)]">Scope: {scopesLabel(globalRole.scopes)} · granted {fmt(globalRole.granted_at)} · {globalRole.reason}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2 md:justify-end">
                <Button size="sm" variant="secondary" onClick={() => { setSelected(person); setForm({ reason: "", all: true, collectionIds: "" }); setAssignOpen(true); }} disabled={Boolean(person.platform_admin)}>
                  <UserRound size={14} /> {globalRole ? "Change scope" : "Assign scoped role"}
                </Button>
                {globalRole ? <Button size="sm" variant="danger" onClick={() => { setSelected(person); setForm({ reason: "", all: true, collectionIds: "" }); setConfirmRevoke(true); }}>Revoke</Button> : null}
              </div>
            </article>
          );
        })}
        {people.length === 0 ? <p className="empty">No accounts match this search and filter.</p> : null}
      </div>

      <section className="mt-8 border border-[var(--line)] p-5">
        <h3 className="display-sm text-2xl uppercase">The permission matrix, in one screen</h3>
        <div className="mt-3 overflow-auto">
          <table className="table">
            <thead><tr><th>Capability</th><th>Super Admin</th><th>Global Collection Admin</th><th>Bot Owner/Admin</th><th>User</th></tr></thead>
            <tbody>
              {[
                ["Manage shared collection metadata, branding and release state", "Yes", "Scoped", "No", "No"],
                ["Approve a public showcase audience", "Yes", "No", "No", "No"],
                ["Manage a Bot they own or were invited to", "Yes (audited)", "Their own Bot only", "Yes, scoped", "No"],
                ["Enable a shared collection for a Bot", "Yes", "Own/assigned Bot only", "Yes", "No"],
                ["Mint cards, spend Foil, inspect another member's inventory", "No (domain actions only)", "No", "Scoped grants only", "Own play only"],
                ["Grant Super Admin, change Access, hold secrets", "Provisioning path only", "No", "No", "No"],
              ].map((row) => <tr key={row[0]}>{row.map((cell, index) => <td key={index} className={index === 0 ? "font-medium" : "text-[var(--muted)]"}>{cell}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogTitle>Assign Global Collection Admin</DialogTitle>
          <DialogDescription>This is a scoped platform role, not Super Admin. The target keeps their existing account, Bot memberships and inventory.</DialogDescription>
          {selected ? (
            <div className="mt-4 grid gap-3">
              <p className="border border-[var(--line)] p-3 text-sm"><strong>{selected.display_name}</strong><span className="block break-all text-xs text-[var(--muted)]">{selected.email}</span></p>
              <Field label="Collection scope">
                <Select value={form.all ? "all" : "some"} onChange={(event) => setForm({ ...form, all: event.target.value === "all" })}>
                  <option value="all">All shared collections</option>
                  <option value="some">An explicit list of collection IDs</option>
                </Select>
              </Field>
              {!form.all ? <Field label="Collection IDs" hint="Comma or space separated. The API rejects unknown IDs."><Textarea value={form.collectionIds} onChange={(event) => setForm({ ...form, collectionIds: event.target.value })} placeholder="col_…, col_…" /></Field> : null}
              <Field label="Reason" hint="Required. Recorded in the audit trail."><Textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Owner requested shared collection curation for the launch catalogue." /></Field>
              <p className="flex gap-2 text-xs text-[var(--muted)]"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> This does not grant platform root, Cloudflare Access, secrets, wallets or another Bot.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={assign} disabled={busy === "assign" || form.reason.trim().length < 3}>{busy === "assign" ? "Applying…" : <><Check size={14} /> Grant scoped role</>}</Button>
                <Button variant="secondary" onClick={() => setAssignOpen(false)}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <DialogContent>
          <DialogTitle>Revoke this scoped role?</DialogTitle>
          <DialogDescription>The account stays intact. Only the Global Collection Admin authority is removed; cards, Bot memberships and audit history remain.</DialogDescription>
          {selected ? <p className="mt-3 text-sm font-semibold">{selected.display_name} · {selected.email}</p> : null}
          <Field label="Reason"><Textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Scope no longer required." /></Field>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="danger" onClick={revoke} disabled={busy === "revoke"}>{busy === "revoke" ? "Revoking…" : <><X size={14} /> Revoke Global Collection Admin</>}</Button>
            <Button variant="secondary" onClick={() => setConfirmRevoke(false)}>Keep access</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
