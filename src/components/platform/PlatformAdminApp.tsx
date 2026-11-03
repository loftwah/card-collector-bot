"use client";

import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, Bot, Boxes, KeyRound, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Field, Input } from "../ui/input";

type Section = "overview" | "accounts" | "bots" | "installations" | "audit" | "collections";

interface Overview {
  counts: Record<string, number>;
  bots: Array<Record<string, unknown>>;
  installations: Array<Record<string, unknown>>;
  access: Array<Record<string, unknown>>;
  admins: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  current_user: { displayName: string; email: string };
}

function fmt(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Melbourne" }).format(new Date(value));
  }
  return String(value);
}

export default function PlatformAdminApp({ section }: { section: Section }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Array<Record<string, unknown>>>([]);
  const [collections, setCollections] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    setError("");
    try {
      const base = await api<Overview>("/api/v1/platform/overview");
      setOverview(base);
      if (section === "accounts") {
        const result = await api<{ items: Array<Record<string, unknown>> }>("/api/v1/platform/accounts");
        setAccounts(result.items);
      }
      if (section === "collections") {
        const result = await api<{ items: Array<Record<string, unknown>> }>("/api/v1/platform/collections");
        setCollections(result.items);
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  useEffect(() => { void load(); }, [section]);

  async function botStatus(id: string, status: string) {
    setBusy(id); setError(""); setMessage("");
    try {
      await api(`/api/v1/platform/bots/${id}/status`, { method: "POST", body: { status } });
      setMessage(`Bot status changed to ${status}.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  if (!overview) {
    if (!error) return <div className="skeleton h-64" />;
    return (
      <div className="grid justify-items-start gap-3">
        <Alert variant="destructive">
          <AlertTitle>Administration could not load</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          <RefreshCw data-icon="inline-start" /> Reload administration
        </Button>
      </div>
    );
  }

  const counts = overview.counts;
  return (
    <div className="grid gap-6">
      {error ? <div className="error-box" role="alert">{error}</div> : null}
      {message ? <div className="success-box" role="status">{message}</div> : null}

      {section === "overview" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Accounts", value: counts.users, icon: Users },
              { label: "Bots", value: counts.bots, icon: Bot },
              { label: "Installations", value: counts.installations, icon: Activity },
              { label: "Owned cards", value: counts.owned_instances, icon: Boxes },
              { label: "Ledger rows", value: counts.ledger_entries, icon: KeyRound },
              { label: "Super Admins", value: counts.super_admins, icon: ShieldCheck },
              { label: "Global Collection Admins", value: counts.global_collection_admins, icon: Users },
              { label: "Pending invitations", value: counts.pending_invitations, icon: Users },
              { label: "Catalogue cards", value: counts.cards, icon: Boxes },
            ].map((item) => (
              <div key={item.label} className="surface-flat p-4">
                <div className="flex items-center justify-between gap-2"><p className="eyebrow">{item.label}</p><item.icon size={16} className="text-[var(--brass)]" /></div>
                <p className="display-sm mt-2 text-4xl">{item.value ?? 0}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <section className="surface p-5">
              <div className="flex items-center justify-between gap-3"><div><p className="eyebrow">Bots and tenants</p><h2 className="display-sm mt-1 text-2xl">One Bot, one economy.</h2></div><a className="btn btn-secondary btn-sm" href="/platform-admin/bots">All Bots <ArrowUpRight size={14} /></a></div>
              <div className="mt-4 overflow-auto">
                <table className="table">
                  <thead><tr><th>Bot</th><th>Owner</th><th>Cards</th><th>Status</th></tr></thead>
                  <tbody>
                    {overview.bots.map((bot) => (
                      <tr key={String(bot.id)}><td><p className="font-semibold">{fmt(bot.name)}</p><p className="font-mono text-[0.62rem] text-[var(--muted)]">{fmt(bot.tenant_slug)}</p></td><td>{fmt(bot.owner_email)}</td><td>{fmt(bot.cards)}</td><td><span className="badge">{fmt(bot.status)}</span></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="surface p-5">
              <p className="eyebrow">Platform authority</p>
              <h2 className="display-sm mt-1 text-2xl">Explicitly provisioned.</h2>
              <div className="mt-4 grid gap-3">
                {overview.admins.map((admin) => (
                  <div key={String(admin.user_id)} className="border border-[var(--line)] p-4">
                    <p className="font-semibold">{fmt(admin.display_name)}</p>
                    <p className="text-sm text-[var(--muted)]">{fmt(admin.email)}</p>
                    <p className="mt-1 font-mono text-[0.6rem] uppercase tracking-[0.1em] text-[var(--brass)]">Super Admin · provisioned {fmt(admin.provisioned_at)}</p>
                    <p className="mt-2 text-xs text-[var(--muted)]">{fmt(admin.reason)}</p>
                  </div>
                ))}
                <p className="text-xs leading-relaxed text-[var(--muted)]">Cloudflare membership and Access admission never create this role. Provisioning is a separate audited operator action.</p>
                <a className="btn btn-secondary btn-sm" href="/platform-admin/people">Open People &amp; roles</a>
              </div>
            </section>
          </div>
          <section className="surface p-5">
            <div className="flex items-center justify-between gap-3"><div><p className="eyebrow">Recent audit</p><h2 className="display-sm mt-1 text-2xl">What changed, and who did it.</h2></div><a className="btn btn-secondary btn-sm" href="/platform-admin/audit">Full audit <ArrowUpRight size={14} /></a></div>
            <div className="mt-4 overflow-auto">
              <table className="table">
                <thead><tr><th>Action</th><th>Object</th><th>Actor</th><th>When</th></tr></thead>
                <tbody>{overview.audit.slice(0, 12).map((event) => <tr key={String(event.id)}><td className="font-mono text-xs">{fmt(event.action)}</td><td>{fmt(event.object_type)} · <span className="font-mono text-[0.62rem]">{fmt(event.object_id)}</span></td><td>{fmt(event.actor_type)} · {fmt(event.actor_id)}</td><td>{fmt(event.created_at)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {section === "accounts" ? (
        <section className="surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Accounts</p><h2 className="display-sm mt-1 text-2xl">Identity, not Access admission.</h2><p className="mt-1 text-sm text-[var(--muted)]">A Cloudflare Access session must be explicitly linked to one of these accounts. Platform Admin cannot be granted from this screen.</p></div><Button size="sm" variant="secondary" onClick={load}><RefreshCw size={14} /> Refresh</Button></div>
          <div className="mt-4 overflow-auto">
            <table className="table">
              <thead><tr><th>Account</th><th>Email</th><th>Role</th><th>Links</th><th>Created</th></tr></thead>
              <tbody>{accounts.map((account) => (
                <tr key={String(account.id)}>
                  <td><p className="font-semibold">{fmt(account.display_name)}</p><p className="font-mono text-[0.6rem] text-[var(--muted)]">{fmt(account.id)}</p></td>
                  <td className="break-all">{fmt(account.email)}<p className="text-xs text-[var(--muted)]">{account.email_verified_at ? "Verified" : "Unverified"}</p></td>
                  <td>{account.platform_admin ? <span className="badge badge-rare">Super Admin</span> : <span className="badge">{Number(account.memberships) > 0 ? "Member" : "User"}</span>}</td>
                  <td className="text-sm text-[var(--muted)]">{fmt(account.discord_links)} Discord · {fmt(account.passkeys)} passkeys · {fmt(account.access_links)} Access</td>
                  <td>{fmt(account.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : null}

      {section === "bots" ? (
        <section className="surface p-5">
          <p className="eyebrow">Bots</p>
          <h2 className="display-sm mt-1 text-2xl">Ownership and lifecycle.</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Pausing a Bot stops its administration and gameplay without deleting records. Archiving is reversible only by an operator.</p>
          <div className="mt-4 overflow-auto">
            <table className="table">
              <thead><tr><th>Bot</th><th>Owner</th><th>Installations</th><th>Cards</th><th>Status</th><th /></tr></thead>
              <tbody>{overview.bots.map((bot) => (
                <tr key={String(bot.id)}>
                  <td><p className="font-semibold">{fmt(bot.name)}</p><p className="font-mono text-[0.6rem] text-[var(--muted)]">{fmt(bot.slug)} · {fmt(bot.tenant_slug)}</p></td>
                  <td className="break-all">{fmt(bot.owner_email)}</td>
                  <td>{fmt(bot.installations)}</td>
                  <td>{fmt(bot.cards)}</td>
                  <td><span className="badge">{fmt(bot.status)}</span></td>
                  <td><div className="flex gap-2">{bot.status === "active" ? <Button size="sm" variant="secondary" onClick={() => botStatus(String(bot.id), "paused")} disabled={Boolean(busy)}>Pause</Button> : <Button size="sm" variant="secondary" onClick={() => botStatus(String(bot.id), "active")} disabled={Boolean(busy)}>Activate</Button>}</div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      ) : null}

      {section === "installations" ? (
        <section className="surface p-5">
          <p className="eyebrow">Discord installations</p>
          <h2 className="display-sm mt-1 text-2xl">The edge of the Bot.</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">The guild binding is resolved server-side. Channel allowlists and interface switches are read by the Discord handler and the website; no privileged intent is required.</p>
          <div className="mt-4 grid gap-4">
            {overview.installations.map((installation) => <InstallationCard key={String(installation.id)} installation={installation} onSaved={load} />)}
            {overview.installations.length === 0 ? <p className="empty">No Discord installation is bound yet.</p> : null}
          </div>
        </section>
      ) : null}

      {section === "audit" ? (
        <section className="surface p-5">
          <p className="eyebrow">Audit</p>
          <h2 className="display-sm mt-1 text-2xl">Every privileged change leaves a trace.</h2>
          <div className="mt-4 overflow-auto">
            <table className="table">
              <thead><tr><th>When</th><th>Action</th><th>Object</th><th>Actor</th><th>Metadata</th></tr></thead>
              <tbody>{overview.audit.map((event) => <tr key={String(event.id)}><td>{fmt(event.created_at)}</td><td className="font-mono text-xs">{fmt(event.action)}</td><td>{fmt(event.object_type)}<p className="font-mono text-[0.58rem] text-[var(--muted)]">{fmt(event.object_id)}</p></td><td>{fmt(event.actor_type)}<p className="font-mono text-[0.58rem] text-[var(--muted)]">{fmt(event.actor_id)}</p></td><td className="max-w-xs truncate font-mono text-[0.6rem] text-[var(--muted)]">{fmt(event.metadata_json)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      ) : null}

      {section === "collections" ? (
        <section className="surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Global collections</p><h2 className="display-sm mt-1 text-2xl">Shared worlds, deliberate availability.</h2><p className="mt-1 text-sm text-[var(--muted)]">Global collections are curated once and can be turned on or off for each Bot. A Bot collection remains private to its own tenant.</p></div><a className="btn btn-primary btn-sm" href="/admin/collections">Manage in Bot administration <ArrowUpRight size={14} /></a></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {collections.map((collection) => (
              <article key={String(collection.id)} className="border border-[var(--line)] p-4">
                <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{fmt(collection.name)}</p><p className="font-mono text-[0.58rem] uppercase tracking-[0.1em] text-[var(--brass)]">{fmt(collection.scope)} · {fmt(collection.status)}</p></div><span className="badge">{fmt(collection.card_count)} cards</span></div>
                <p className="mt-3 text-sm text-[var(--muted)]">{fmt(collection.description)}</p>
                <p className="mt-2 text-xs text-[var(--muted)]">Owner: {fmt(collection.owner_name)}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InstallationCard({ installation, onSaved }: { installation: Record<string, unknown>; onSaved: () => Promise<void> }) {
  const [allowlist, setAllowlist] = useState(() => {
    try {
      const parsed = JSON.parse(String(installation.channel_allowlist_json ?? "[]")) as unknown;
      return Array.isArray(parsed) ? parsed.join(", ") : "";
    } catch { return ""; }
  });
  const [game, setGame] = useState(Boolean(installation.game_enabled));
  const [website, setWebsite] = useState(Boolean(installation.website_enabled));
  const [active, setActive] = useState(Boolean(installation.active));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save() {
    setBusy(true); setMessage("");
    try {
      const channelAllowlist = allowlist.split(",").map((item) => item.trim()).filter(Boolean);
      await api(`/api/v1/platform/installations/${installation.id}`, { method: "PATCH", body: { channelAllowlist, gameEnabled: game, websiteEnabled: website, active } });
      setMessage("Saved.");
      await onSaved();
    } catch (cause) {
      setMessage(describeError(cause));
    } finally { setBusy(false); }
  }

  return (
    <article className="border border-[var(--line)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="font-semibold">{fmt(installation.guild_name)} <span className="font-mono text-[0.6rem] text-[var(--muted)]">{fmt(installation.guild_id)}</span></p><p className="text-xs text-[var(--muted)]">Bot {fmt(installation.bot_name)} · Tenant {fmt(installation.tenant_slug)}</p></div>
        <span className={`badge ${active ? "badge-rare" : ""}`}>{active ? "Active" : "Paused"}</span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Channel allowlist" hint="Comma-separated channel IDs. Empty means no channel restriction; the guild binding still applies."><Input value={allowlist} onChange={(event) => setAllowlist(event.target.value)} /></Field>
        <div className="grid gap-2 pt-1">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={game} onChange={(event) => setGame(event.target.checked)} /> Discord gameplay</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={website} onChange={(event) => setWebsite(event.target.checked)} /> Website surfaces</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Installation active</label>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3"><Button size="sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save installation"}</Button>{message ? <span className="text-xs text-[var(--muted)]">{message}</span> : null}</div>
    </article>
  );
}

