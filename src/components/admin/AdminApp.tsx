"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  KeyRound,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { api, describeError, idempotencyKey } from "@/lib/client";
import { cn, formatDual, formatBytes, titleCase } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Field, Input, Select, Textarea } from "../ui/input";
import { Switch } from "../ui/switch";
import AdminCollections from "./AdminCollections";
import AdminTeam from "./AdminTeam";

export type AdminSection =
  | "overview"
  | "catalogue"
  | "collections"
  | "team"
  | "taxonomy"
  | "topics"
  | "sets"
  | "pools"
  | "economy"
  | "imports"
  | "agents"
  | "design"
  | "integrations"
  | "audit";

interface Taxonomy {
  classes: Array<{ id: string; key: string; name: string; description?: string | null }>;
  categories: Array<{ id: string; slug: string; name: string }>;
  tags: Array<{ id: string; slug: string; name: string }>;
  rarities: Array<{ id: string; key: string; name: string; tone: string }>;
  materials: Array<{ id: string; key: string; name: string }>;
  effects: Array<{ id: string; key: string; name: string }>;
}

interface Variant {
  id: string;
  name: string;
  material_key: string;
  effect_key: string | null;
  status: string;
  render_url: string | null;
}

interface Card {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  description: string;
  bio: string | null;
  quote: string | null;
  status: string;
  version: number;
  class: { key: string; name: string } | null;
  category: { slug: string; name: string } | null;
  rarity: { key: string; name: string; tone: string } | null;
  tags: Array<{ slug: string; name: string }>;
  collections: Array<{ id: string; slug: string; name: string; scope: string }>;
  editions: Array<{ id: string; name: string; status: string; variants: Variant[] }>;
  sets: Array<{ slug: string; name: string }>;
}

interface SetRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  bio: string | null;
  quote: string | null;
  status: string;
  version: number;
  reward_amount: number;
  published_at: string | null;
  cards: Array<{ id: string; slug: string; name: string }>;
}

interface PoolRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  bio: string | null;
  quote: string | null;
  status: string;
  revision: number;
  price: number;
  channel_key: string | null;
}

interface Member {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

interface AssetRow {
  id: string;
  name: string;
  kind: string;
  mime: string;
  width: number | null;
  height: number | null;
}

interface RecipeRow {
  id: string;
  name: string;
  version: number;
}

interface AgentRow {
  id: string;
  agent_name: string;
  agent_id: string;
  represented_user_id: string;
  scopes_json: string;
  status: string;
  expires_at: string;
  created_at: string;
  represented_name: string;
  prefix: string | null;
  last_used_at: string | null;
}

function SectionHead({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="display-sm mt-1 text-4xl">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

function Notice({ error, message }: { error?: string; message?: string }) {
  if (!error && !message) return null;
  return <div className={cn("mt-4", error ? "error-box" : "success-box")} role={error ? "alert" : "status"}>{error ?? message}</div>;
}

function Status({ value }: { value: string }) {
  return <span className={cn("badge", value === "published" || value === "active" ? "badge-rare" : value === "retired" || value === "failed" ? "badge-cabinet" : "")}>{value}</span>;
}

function AdminOverview() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [jobs, setJobs] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    try {
      const [s, j] = await Promise.all([api<Record<string, unknown>>("/api/v1/admin/status"), api<{ items: Array<Record<string, unknown>> }>("/api/v1/admin/jobs?status=pending")]);
      setStatus(s);
      setJobs(j.items);
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  useEffect(() => { void load(); }, []);

  async function queue() {
    setBusy("queue"); setError(""); setMessage("");
    try {
      const result = await api<{ queued: number }>("/api/v1/admin/renders/queue", { method: "POST", body: {} });
      setMessage(`${result.queued} render job${result.queued === 1 ? "" : "s"} queued. Run pnpm jobs:run to process them locally.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function publish() {
    setBusy("publish"); setError(""); setMessage("");
    try {
      const result = await api<{ version: number; checksum: string }>("/api/v1/admin/catalogue/publish", { method: "POST", body: {} });
      setMessage(`Catalogue release v${result.version} is active (${result.checksum.slice(0, 12)}…).`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  const counts = (status?.counts ?? {}) as Record<string, number>;
  const release = status?.release as { version: number; checksum: string; published_at: string } | null;
  const providers = (status?.providers ?? {}) as Record<string, boolean>;
  return (
    <div>
      <SectionHead eyebrow="Overview" title="The cabinet at a glance." description="A read-only operational view with explicit local actions. Nothing here contacts Cloudflare, Discord, email or an image provider." actions={<><Button variant="secondary" size="sm" onClick={load} disabled={Boolean(busy)}><RefreshCw size={14} /> Refresh</Button><Button size="sm" onClick={publish} disabled={Boolean(busy)}>{busy === "publish" ? "Publishing…" : "Publish catalogue"}</Button></>} />
      <Notice error={error} message={message} />
      {!status ? <div className="skeleton mt-6 h-40" /> : (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Cards", counts.cards ?? 0], ["Variants", counts.variants ?? 0], ["Instances", counts.instances ?? 0], ["Ledger rows", counts.ledger_entries ?? 0],
              ["Pending jobs", counts.pending_jobs ?? 0], ["Pending outbox", counts.pending_outbox ?? 0], ["Import runs", counts.import_runs ?? 0], ["Members", (status.accounts as { members?: number } | undefined)?.members ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)} className="surface-flat p-4"><p className="eyebrow">{label}</p><p className="display-sm mt-1 text-3xl">{String(value)}</p></div>
            ))}
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="surface-flat p-5">
              <p className="eyebrow">Active catalogue release</p>
              {release ? (
                <><p className="display-sm mt-2 text-2xl">Version {release.version}</p><p className="mt-1 font-mono text-[0.62rem] text-[var(--muted)]">{release.checksum.slice(0, 24)}…</p><p className="mt-2 text-sm text-[var(--muted)]">{formatDual(release.published_at)}</p></>
              ) : <p className="mt-2 text-sm text-[var(--muted)]">No active release. Publish when the catalogue and render queue are ready.</p>}
              <div className="mt-4 flex flex-wrap gap-2"><a className="btn btn-secondary btn-sm" href="/cabinet">View public catalogue</a><Button size="sm" variant="secondary" onClick={queue} disabled={Boolean(busy)}>{busy === "queue" ? "Queueing…" : "Queue missing renders"}</Button></div>
              <p className="mt-2 text-xs text-[var(--muted)]">Rendering is local. The queue is durable and retry-safe; the jobs runner composes from stored assets.</p>
            </div>
            <div className="surface-flat p-5">
              <p className="eyebrow">External capabilities</p>
              <dl className="mt-3 grid gap-2 text-sm">
                <div className="flex justify-between gap-3"><dt>Discord</dt><dd className="text-[var(--muted)]">{providers.discordApplication ? "interactions ready · guild-bound" : "disabled"}</dd></div>
                <div className="flex justify-between gap-3"><dt>Email</dt><dd className="text-[var(--muted)]">{providers.resend ? "Resend configured · live" : "local outbox only"}</dd></div>
                <div className="flex justify-between gap-3"><dt>Generation</dt><dd className="text-[var(--muted)]">not run · no ceiling recorded</dd></div>
                <div className="flex justify-between gap-3"><dt>Admin webhook</dt><dd className="text-[var(--muted)]">{providers.adminWebhook ? "configured · not called" : "missing"}</dd></div>
                <div className="flex justify-between gap-3"><dt>FAL</dt><dd className="text-[var(--muted)]">{providers.fal ? "configured · unbilled" : "missing"}</dd></div>
                <div className="flex justify-between gap-3"><dt>Resend</dt><dd className="text-[var(--muted)]">{providers.resend ? "configured · live delivery" : "missing"}</dd></div>
              </dl>
            </div>
          </div>
          <div className="mt-6">
            <div className="flex items-center justify-between gap-3"><p className="eyebrow">Pending render jobs</p><a className="font-mono text-[0.6rem] uppercase tracking-[0.1em] text-[var(--green)]" href="/admin/design">Finish studio →</a></div>
            <div className="mt-2 overflow-auto border border-[var(--line)]">
              <table className="table"><thead><tr><th>Job</th><th>Kind</th><th>Attempts</th><th>Created</th></tr></thead><tbody>
                {jobs.slice(0, 8).map((job) => <tr key={String(job.id)}><td className="font-mono text-xs">{String(job.id).slice(0, 18)}…</td><td>{String(job.kind)}</td><td>{String(job.attempts)}</td><td>{formatDual(String(job.created_at))}</td></tr>)}
                {jobs.length === 0 ? <tr><td colSpan={4} className="text-[var(--muted)]">No pending jobs. The render queue is clear.</td></tr> : null}
              </tbody></table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AdminCatalogue() {
  const [cards, setCards] = useState<Card[]>([]);
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [backgrounds, setBackgrounds] = useState<AssetRow[]>([]);
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [artworkFor, setArtworkFor] = useState<Card | null>(null);
  const [artwork, setArtwork] = useState({ name: "", subjectAssetId: "", backgroundAssetId: "", recipeId: "", materials: ["plain"] as string[] });
  const [uploading, setUploading] = useState("");
  const [uploadKind, setUploadKind] = useState<"subject" | "background">("subject");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [form, setForm] = useState({ slug: "", name: "", subtitle: "", description: "", bio: "", quote: "", classKey: "", categorySlug: "", rarityKey: "", tags: "" });

  async function load() {
    try {
      const [c, t, subjects, backs, recipeResult] = await Promise.all([
        api<{ items: Card[] }>("/api/v1/admin/cards?limit=200"),
        api<Taxonomy>("/api/v1/admin/taxonomy"),
        api<{ items: AssetRow[] }>("/api/v1/admin/assets?kind=subject"),
        api<{ items: AssetRow[] }>("/api/v1/admin/assets?kind=background"),
        api<{ items: RecipeRow[] }>("/api/v1/admin/recipes"),
      ]);
      setCards(c.items); setTaxonomy(t); setAssets(subjects.items); setBackgrounds(backs.items); setRecipes(recipeResult.items);
    } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);

  function resetForm() { setForm({ slug: "", name: "", subtitle: "", description: "", bio: "", quote: "", classKey: "", categorySlug: "", rarityKey: "", tags: "" }); }
  function editForm(card: Card) {
    setEditing(card);
    setForm({ slug: card.slug, name: card.name, subtitle: card.subtitle ?? "", description: card.description, bio: card.bio ?? "", quote: card.quote ?? "", classKey: card.class?.key ?? "", categorySlug: card.category?.slug ?? "", rarityKey: card.rarity?.key ?? "", tags: card.tags.map((tag) => tag.slug).join(", ") });
  }
  async function create() {
    setBusy("create"); setError(""); setMessage("");
    try {
      await api("/api/v1/admin/cards", { method: "POST", body: { slug: form.slug, name: form.name, subtitle: form.subtitle || undefined, description: form.description, bio: form.bio || undefined, quote: form.quote || undefined, classKey: form.classKey || undefined, categorySlug: form.categorySlug || undefined, rarityKey: form.rarityKey || undefined, tags: form.tags ? form.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined } });
      setCreateOpen(false); resetForm(); setMessage("Draft card created. Add an artwork edition through import before publishing."); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function save() {
    if (!editing) return;
    setBusy("save"); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/cards/${editing.id}`, { method: "PATCH", body: { expectedVersion: editing.version, name: form.name, subtitle: form.subtitle || null, description: form.description, bio: form.bio || null, quote: form.quote || null, classKey: form.classKey || null, categorySlug: form.categorySlug || null, rarityKey: form.rarityKey || null, tags: form.tags ? form.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [] } });
      setEditing(null); setMessage("Card saved with optimistic concurrency."); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function addArtwork() {
    if (!artworkFor) return;
    setBusy("artwork"); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/cards/${artworkFor.id}/editions`, {
        method: "POST",
        body: {
          name: artwork.name || `${artworkFor.name} edition`,
          subjectAssetId: artwork.subjectAssetId,
          backgroundAssetId: artwork.backgroundAssetId || null,
          recipeId: artwork.recipeId || null,
          materials: artwork.materials,
          effects: ["none"],
          status: "published",
        },
      });
      setArtworkFor(null);
      setArtwork({ name: "", subjectAssetId: "", backgroundAssetId: "", recipeId: "", materials: ["plain"] });
      setMessage("Artwork edition created. Queue missing renders, then publish the card.");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function uploadArtwork(file: File | null) {
    if (!file) return;
    setUploading("file"); setError(""); setMessage("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", uploadKind);
      form.set("name", file.name.replace(/\.[^.]+$/, ""));
      const csrf = document.querySelector<HTMLMetaElement>('meta[name="foilbury-csrf"]')?.content ?? "";
      const response = await fetch("/api/v1/admin/assets", { method: "POST", body: form, headers: { "x-foilbury-csrf": csrf } });
      const payload = await response.json().catch(() => null) as { error?: { message?: string }; asset?: { id: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? "Upload failed");
      setMessage(`${uploadKind === "subject" ? "Subject" : "Background"} uploaded.`);
      await load();
      if (payload?.asset?.id) setArtwork((current) => uploadKind === "subject" ? { ...current, subjectAssetId: payload.asset!.id } : { ...current, backgroundAssetId: payload.asset!.id });
    } catch (cause) { setError(describeError(cause)); } finally { setUploading(""); }
  }
  async function setStatus(card: Card, status: string) {
    setBusy(`${card.id}-${status}`); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/cards/${card.id}/status`, { method: "POST", body: { status } });
      setMessage(`${card.name} is now ${status}.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  const filtered = useMemo(() => cards.filter((card) => !search || `${card.name} ${card.slug} ${card.description}`.toLowerCase().includes(search.toLowerCase())), [cards, search]);
  return (
    <div>
      <SectionHead eyebrow="Catalogue" title="Definitions and editions." description="Cards are stable identities; editions are illustrations; variants are explicit finish combinations. Publishing a card is not the same as releasing the catalogue." actions={<Button size="sm" onClick={() => { resetForm(); setCreateOpen(true); }}><FilePlus2 size={14} /> New draft card</Button>} />
      <Notice error={error} message={message} />
      <div className="mt-5 flex flex-wrap items-center gap-2"><Input className="max-w-sm" placeholder="Filter by name, slug or description" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Filter catalogue" /><span className="font-mono text-[0.62rem] uppercase tracking-[0.1em] text-[var(--muted)]">{filtered.length} cards</span></div>
      <div className="mt-4 overflow-auto border border-[var(--line)]">
        <table className="table">
          <thead><tr><th>Card</th><th>Status</th><th>Class</th><th>Rarity</th><th>Variants</th><th>Sets</th><th className="text-right">Actions</th></tr></thead>
          <tbody>
            {filtered.map((card) => {
              const variants = card.editions.flatMap((edition) => edition.variants);
              const renders = variants.filter((variant) => variant.render_url).length;
              return (
                <tr key={card.id}>
                  <td><p className="font-semibold">{card.name}</p><p className="font-mono text-[0.58rem] text-[var(--muted)]">{card.slug} · v{card.version}</p></td>
                  <td><Status value={card.status} /></td>
                  <td className="text-[var(--muted)]">{card.class?.name ?? "—"}</td>
                  <td className="text-[var(--muted)]">{card.rarity?.name ?? "—"}</td>
                  <td><span className="font-mono text-xs">{variants.length}</span><span className="ml-1 text-[0.62rem] text-[var(--muted)]">({renders} rendered)</span></td>
                  <td className="text-[0.68rem] text-[var(--muted)]">{card.sets.map((set) => set.name).join(", ") || "—"}</td>
                  <td className="text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="secondary" onClick={() => editForm(card)}>Edit</Button><Button size="sm" variant="secondary" onClick={() => { setArtworkFor(card); setArtwork({ name: `${card.name} edition`, subjectAssetId: "", backgroundAssetId: "", recipeId: "", materials: ["plain"] }); }}>Artwork</Button>{card.status !== "published" ? <Button size="sm" onClick={() => setStatus(card, "published")} disabled={Boolean(busy)}>Publish</Button> : <Button size="sm" variant="danger" onClick={() => setStatus(card, "retired")} disabled={Boolean(busy)}>Retire</Button>}</div></td>
                </tr>
              );
            })}
            {filtered.length === 0 ? <tr><td colSpan={7} className="text-[var(--muted)]">No cards match.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">Imported editions and their source hashes are managed by the source commands. Editing card identity here does not silently replace issued instances.</p>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogTitle>New draft card</DialogTitle>
          <DialogDescription>A stable identity. Add an artwork edition from the source importer before publishing.</DialogDescription>
          <div className="mt-5 grid gap-3">
            <Field label="Slug"><Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="character-name" /></Field>
            <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="Subtitle"><Input value={form.subtitle} onChange={(event) => setForm({ ...form, subtitle: event.target.value })} /></Field>
            <Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bio" hint="The character story shown on the card detail page."><Textarea value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} /></Field>
              <Field label="Quote"><Input value={form.quote} onChange={(event) => setForm({ ...form, quote: event.target.value })} placeholder="A line worth keeping." /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Class"><Select value={form.classKey} onChange={(event) => setForm({ ...form, classKey: event.target.value })}><option value="">None</option>{taxonomy?.classes.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select></Field>
              <Field label="Category"><Select value={form.categorySlug} onChange={(event) => setForm({ ...form, categorySlug: event.target.value })}><option value="">None</option>{taxonomy?.categories.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}</Select></Field>
              <Field label="Rarity"><Select value={form.rarityKey} onChange={(event) => setForm({ ...form, rarityKey: event.target.value })}><option value="">None</option>{taxonomy?.rarities.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select></Field>
            </div>
            <Field label="Tags" hint="Comma separated existing tag slugs"><Input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></Field>
            <div className="flex gap-2"><Button onClick={create} disabled={busy === "create"}>{busy === "create" ? "Creating…" : "Create draft"}</Button><Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent>
          <DialogTitle>Edit {editing?.name}</DialogTitle>
          <DialogDescription>Optimistic concurrency is enforced with version {editing?.version}.</DialogDescription>
          <div className="mt-5 grid gap-3">
            <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="Subtitle"><Input value={form.subtitle} onChange={(event) => setForm({ ...form, subtitle: event.target.value })} /></Field>
            <Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bio" hint="The character story shown on the card detail page."><Textarea value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} /></Field>
              <Field label="Quote"><Input value={form.quote} onChange={(event) => setForm({ ...form, quote: event.target.value })} placeholder="A line worth keeping." /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Class"><Select value={form.classKey} onChange={(event) => setForm({ ...form, classKey: event.target.value })}><option value="">None</option>{taxonomy?.classes.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select></Field>
              <Field label="Category"><Select value={form.categorySlug} onChange={(event) => setForm({ ...form, categorySlug: event.target.value })}><option value="">None</option>{taxonomy?.categories.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}</Select></Field>
              <Field label="Rarity"><Select value={form.rarityKey} onChange={(event) => setForm({ ...form, rarityKey: event.target.value })}><option value="">None</option>{taxonomy?.rarities.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select></Field>
            </div>
            <Field label="Tags" hint="Comma separated tag slugs"><Input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></Field>
            <div className="flex gap-2"><Button onClick={save} disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save card"}</Button><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(artworkFor)} onOpenChange={(open) => { if (!open) setArtworkFor(null); }}>
        <DialogContent>
          <DialogTitle>Add artwork to {artworkFor?.name}</DialogTitle>
          <DialogDescription>Choose an uploaded subject and optional background, then create explicit finish variants. The render queue composes the public image.</DialogDescription>
          <div className="mt-5 grid gap-3">
            <Field label="Edition name"><Input value={artwork.name} onChange={(event) => setArtwork({ ...artwork, name: event.target.value })} /></Field>
            <div className="border border-[var(--line)] p-3">
              <p className="label">Upload private source art</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Select value={uploadKind} onChange={(event) => setUploadKind(event.target.value as "subject" | "background")}><option value="subject">Subject</option><option value="background">Background</option></Select>
                <input type="file" accept="image/*" onChange={(event) => void uploadArtwork(event.target.files?.[0] ?? null)} disabled={Boolean(uploading)} className="text-xs" />
                {uploading ? <span className="text-xs text-[var(--muted)]">Uploading…</span> : null}
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">PNG, WebP or JPEG. Stored privately in the Bot's media bucket; only published renders are public.</p>
            </div>
            <Field label="Subject asset" hint="Choose the uploaded subject or an existing private asset.">
              <Select value={artwork.subjectAssetId} onChange={(event) => setArtwork({ ...artwork, subjectAssetId: event.target.value })}>
                <option value="">Choose subject</option>
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · {asset.width ?? "?"}×{asset.height ?? "?"}</option>)}
              </Select>
            </Field>
            <Field label="Background asset"><Select value={artwork.backgroundAssetId} onChange={(event) => setArtwork({ ...artwork, backgroundAssetId: event.target.value })}><option value="">None</option>{backgrounds.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</Select></Field>
            <Field label="Render recipe"><Select value={artwork.recipeId} onChange={(event) => setArtwork({ ...artwork, recipeId: event.target.value })}><option value="">Latest published</option>{recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name} · v{recipe.version}</option>)}</Select></Field>
            <div><p className="label">Finishes</p><div className="grid grid-cols-2 gap-2">{["plain", "silver", "gold", "diamond"].map((material) => <label key={material} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={artwork.materials.includes(material)} onChange={(event) => setArtwork({ ...artwork, materials: event.target.checked ? [...artwork.materials, material] : artwork.materials.filter((item) => item !== material) })} />{material}</label>)}</div></div>
            <div className="flex gap-2"><Button onClick={addArtwork} disabled={busy === "artwork" || !artwork.subjectAssetId || artwork.materials.length === 0}>{busy === "artwork" ? "Adding…" : "Add artwork edition"}</Button><Button variant="secondary" onClick={() => setArtworkFor(null)}>Cancel</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdminTaxonomy() {
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [kind, setKind] = useState("tag");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  async function load() {
    try { setTaxonomy(await api<Taxonomy>("/api/v1/admin/taxonomy")); } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setBusy("create"); setError(""); setMessage("");
    try {
      await api("/api/v1/admin/taxonomy", { method: "POST", body: { kind, key, name } });
      setMessage(`${titleCase(kind)} “${name}” created.`);
      setKey(""); setName(""); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function archive(itemKind: string, id: string, label: string) {
    setBusy(id); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/taxonomy/${itemKind}/${id}`, { method: "DELETE" });
      setMessage(`${label} archived. Existing cards keep their historical references.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  const groups = taxonomy ? [
    { kind: "class", label: "Classes", items: taxonomy.classes.map((item) => ({ id: item.id, key: item.key, name: item.name })) },
    { kind: "category", label: "Categories", items: taxonomy.categories.map((item) => ({ id: item.id, key: item.slug, name: item.name })) },
    { kind: "tag", label: "Tags", items: taxonomy.tags.map((item) => ({ id: item.id, key: item.slug, name: item.name })) },
    { kind: "rarity", label: "Rarities", items: taxonomy.rarities.map((item) => ({ id: item.id, key: item.key, name: item.name })) },
    { kind: "material", label: "Materials", items: taxonomy.materials.map((item) => ({ id: item.id, key: item.key, name: item.name })) },
    { kind: "effect", label: "Effects", items: taxonomy.effects.map((item) => ({ id: item.id, key: item.key, name: item.name })) },
  ] : [];
  return (
    <div>
      <SectionHead eyebrow="Taxonomy" title="The owner's vocabulary." description="Categories, tags, classes, rarities, materials and effects are editable seed data. Tags are descriptive; ownership, rarity and material remain authoritative fields." />
      <Notice error={error} message={message} />
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="grid gap-4">
          {groups.map((group) => (
            <section key={group.kind} className="border border-[var(--line)] p-4">
              <div className="flex items-center justify-between gap-2"><p className="eyebrow">{group.label}</p><span className="font-mono text-[0.58rem] text-[var(--muted)]">{group.items.length}</span></div>
              <div className="mt-2 flex flex-wrap gap-2">
                {group.items.map((item) => (
                  <span key={item.id} className="chip">
                    {item.name} <span className="text-[var(--muted)]">{item.key}</span>
                    <button type="button" className="ml-1 text-[var(--oxblood)]" onClick={() => archive(group.kind, item.id, item.name)} aria-label={`Archive ${item.name}`} disabled={Boolean(busy)}>×</button>
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="surface-flat h-fit p-5">
          <p className="eyebrow">Add an item</p>
          <div className="mt-3 grid gap-3">
            <Field label="Kind"><Select value={kind} onChange={(event) => setKind(event.target.value)}>{["class", "category", "tag", "rarity", "material", "effect"].map((item) => <option key={item} value={item}>{titleCase(item)}</option>)}</Select></Field>
            <Field label="Key or slug"><Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="night-shift" /></Field>
            <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Night shift" /></Field>
            <Button onClick={create} disabled={busy === "create" || !key || !name}>{busy === "create" ? "Adding…" : "Add item"}</Button>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">Archiving is non-destructive: existing cards and ledger history retain their references.</p>
        </div>
      </div>
    </div>
  );
}

function AdminSets() {
  const [sets, setSets] = useState<SetRow[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<SetRow | null>(null);
  const [selectedCards, setSelectedCards] = useState<string[]>([]);
  const [form, setForm] = useState({ slug: "", name: "", description: "", rewardAmount: "250" });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    try { const [s, c] = await Promise.all([api<{ items: SetRow[] }>("/api/v1/admin/sets"), api<{ items: Card[] }>("/api/v1/admin/cards?limit=200")]); setSets(s.items); setCards(c.items); } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setBusy("create"); setError(""); setMessage("");
    try {
      await api("/api/v1/admin/sets", { method: "POST", body: { slug: form.slug, name: form.name, description: form.description, rewardAmount: Number(form.rewardAmount) } });
      setForm({ slug: "", name: "", description: "", rewardAmount: "250" }); setMessage("Draft set created."); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function saveMembers() {
    if (!selected) return;
    setBusy("members"); setError(""); setMessage("");
    try {
      const result = await api<{ set: SetRow }>(`/api/v1/admin/sets/${selected.id}/members`, { method: "PUT", body: { cardIds: selectedCards } });
      setSelected(result.set); setMessage(`Set revision ${result.set.version} saved. The checklist version changed; prior claims are preserved.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function publish(set: SetRow) {
    setBusy(`publish-${set.id}`); setError(""); setMessage("");
    try { await api(`/api/v1/admin/sets/${set.id}/publish`, { method: "POST", body: {} }); setMessage(`${set.name} published.`); await load(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  return (
    <div>
      <SectionHead eyebrow="Sets" title="Curated releases and completion." description="Set membership is versioned. A published checklist can change only by creating a new version; already-earned rewards are never recalculated." />
      <Notice error={error} message={message} />
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="grid gap-2">
            {sets.map((set) => (
              <button key={set.id} type="button" onClick={() => { setSelected(set); setSelectedCards(set.cards.map((card) => card.id)); }} className={cn("border p-4 text-left", selected?.id === set.id ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)] hover:border-[var(--brass)]")}>
                <div className="flex items-center justify-between gap-3"><span className="font-semibold">{set.name}</span><Status value={set.status} /></div>
                <p className="mt-1 text-xs text-[var(--muted)]">v{set.version} · {set.cards.length} cards · completion ✦ {set.reward_amount}</p>
              </button>
            ))}
          </div>
          <div className="surface-flat mt-5 p-5">
            <p className="eyebrow">New set</p>
            <div className="mt-3 grid gap-3">
              <Field label="Slug"><Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} /></Field>
              <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
              <Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
              <Field label="Completion reward"><Input type="number" min="0" value={form.rewardAmount} onChange={(event) => setForm({ ...form, rewardAmount: event.target.value })} /></Field>
              <Button onClick={create} disabled={busy === "create" || !form.slug || !form.name}>{busy === "create" ? "Creating…" : "Create draft set"}</Button>
            </div>
          </div>
        </div>
        <div className="surface-flat p-5">
          {selected ? (
            <>
              <div className="flex items-start justify-between gap-3"><div><p className="eyebrow">Checklist · v{selected.version}</p><h3 className="display-sm mt-1 text-2xl">{selected.name}</h3></div><Status value={selected.status} /></div>
              <p className="mt-2 text-sm text-[var(--muted)]">{selected.description}</p>
              <div className="mt-4 max-h-80 overflow-auto border border-[var(--line)] p-2">
                {cards.filter((card) => card.status === "published").map((card) => (
                  <label key={card.id} className="flex items-center gap-2 border-b border-[var(--line)] py-2 text-sm last:border-0">
                    <input type="checkbox" className="accent-[var(--green)]" checked={selectedCards.includes(card.id)} onChange={() => setSelectedCards((current) => current.includes(card.id) ? current.filter((id) => id !== card.id) : [...current, card.id])} />
                    {card.name}<span className="font-mono text-[0.58rem] text-[var(--muted)]">{card.slug}</span>
                  </label>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2"><Button onClick={saveMembers} disabled={busy === "members"}>{busy === "members" ? "Saving…" : "Save checklist"}</Button>{selected.status !== "published" ? <Button variant="secondary" onClick={() => publish(selected)} disabled={Boolean(busy)}>Publish version</Button> : null}</div>
              <p className="mt-3 text-xs text-[var(--muted)]">Published at {selected.published_at ? formatDual(selected.published_at) : "not yet published"}.</p>
            </>
          ) : <div className="empty"><p>Select a set to edit its checklist.</p></div>}
        </div>
      </div>
    </div>
  );
}

function AdminPools() {
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [editing, setEditing] = useState<PoolRow | null>(null);
  const [entries, setEntries] = useState<Array<{ variant_id: string; weight: number; card_name: string; variant_name: string }>>([]);
  const [price, setPrice] = useState("80");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    try { const result = await api<{ items: PoolRow[] }>("/api/v1/admin/pools"); setPools(result.items); } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);
  async function edit(pool: PoolRow) {
    setBusy(`load-${pool.id}`); setError("");
    try {
      const result = await api<{ pool: PoolRow; entries: Array<{ variant_id: string; weight: number; card_name: string; variant_name: string }> }>(`/api/v1/admin/pools/${pool.id}`);
      setEditing(result.pool); setEntries(result.entries); setPrice(String(result.pool.price));
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function save() {
    if (!editing) return;
    setBusy("save"); setError(""); setMessage("");
    try {
      const result = await api<{ pool: PoolRow }>(`/api/v1/admin/pools/${editing.id}`, { method: "PATCH", body: { expectedRevision: editing.revision, price: Number(price), entries: entries.map((entry) => ({ variantId: entry.variant_id, weight: Math.max(1, entry.weight) })) } });
      setEditing(result.pool); setMessage(`Pool revision ${result.pool.revision} is a draft. Publish it when you are ready.`); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function publish(pool: PoolRow) {
    setBusy(`publish-${pool.id}`); setError(""); setMessage("");
    try { await api(`/api/v1/admin/pools/${pool.id}/publish`, { method: "POST", body: {} }); setMessage(`${pool.name} is active at revision ${pool.revision}.`); await load(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function retire(pool: PoolRow) {
    setBusy(`retire-${pool.id}`); setError(""); setMessage("");
    try { await api(`/api/v1/admin/pools/${pool.id}/retire`, { method: "POST", body: {} }); setMessage(`${pool.name} retired. Owned instances remain.`); await load(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  return (
    <div>
      <SectionHead eyebrow="Pools" title="Distribution rules." description="Editing a pool creates a new draft revision. Draws reject a stale revision before charging. A pool is never published without entries." />
      <Notice error={error} message={message} />
      <div className="mt-5 overflow-auto border border-[var(--line)]">
        <table className="table"><thead><tr><th>Pool</th><th>Status</th><th>Revision</th><th>Price</th><th>Channel</th><th className="text-right">Actions</th></tr></thead><tbody>
          {pools.map((pool) => (
            <tr key={pool.id}>
              <td><p className="font-semibold">{pool.name}</p><p className="font-mono text-[0.58rem] text-[var(--muted)]">{pool.slug}</p></td>
              <td><Status value={pool.status} /></td>
              <td>{pool.revision}</td>
              <td className="font-mono">✦ {pool.price}</td>
              <td className="text-[var(--muted)]">{pool.channel_key ?? "tenant-wide"}</td>
              <td className="text-right"><div className="flex justify-end gap-1"><a className="btn btn-ghost btn-sm" href={`/pools/${pool.slug}`} target="_blank" rel="noreferrer">Odds ↗</a><Button size="sm" variant="secondary" onClick={() => edit(pool)} disabled={Boolean(busy)}>Edit</Button>{pool.status !== "active" ? <Button size="sm" onClick={() => publish(pool)} disabled={Boolean(busy)}>Publish</Button> : <Button size="sm" variant="danger" onClick={() => retire(pool)} disabled={Boolean(busy)}>Retire</Button>}</div></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {editing ? (
        <div className="surface-flat mt-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Editing {editing.name} · revision {editing.revision}</p><h3 className="display-sm mt-1 text-2xl">Entries and price</h3></div><Button size="sm" variant="secondary" onClick={() => setEditing(null)}>Close</Button></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr] sm:items-end">
            <Field label="Price (Foil)"><Input type="number" min="0" value={price} onChange={(event) => setPrice(event.target.value)} /></Field>
            <p className="text-xs text-[var(--muted)]">Saving creates revision {editing.revision + 1} as a draft. Current draws against revision {editing.revision} are unaffected.</p>
          </div>
          <div className="mt-4 max-h-72 overflow-auto border border-[var(--line)] p-2">
            {entries.map((entry, index) => (
              <div key={entry.variant_id} className="grid grid-cols-[1fr_90px_30px] items-center gap-2 border-b border-[var(--line)] py-1.5 text-xs last:border-0">
                <span>{entry.card_name} <span className="text-[var(--muted)]">· {entry.variant_name}</span></span>
                <Input className="h-8" type="number" min="1" value={entry.weight} onChange={(event) => setEntries((current) => current.map((item, i) => i === index ? { ...item, weight: Number(event.target.value) } : item))} aria-label={`Weight for ${entry.card_name} ${entry.variant_name}`} />
                <button type="button" className="text-[var(--oxblood)]" onClick={() => setEntries((current) => current.filter((_, i) => i !== index))} aria-label={`Remove ${entry.card_name} ${entry.variant_name}`}>×</button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2"><Button onClick={save} disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save new revision"}</Button><Button variant="secondary" onClick={() => editing && publish({ ...editing, revision: editing.revision + 1 })} disabled={Boolean(busy)}>Save then publish</Button></div>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-[var(--muted)]">Pool entry configuration is also available through <code className="font-mono">foilbury pools update</code> and MCP. Empty or over-filtered pools never charge.</p>
    </div>
  );
}

function AdminEconomy() {
  const [economy, setEconomy] = useState<Record<string, unknown> | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState({ dailyReward: "120", cooldown: "72000", starter: "350", currencyName: "Foil", currencySymbol: "✦", recycle: true });
  const [adjust, setAdjust] = useState({ userId: "", amount: "100", reason: "" });
  const [selectedMember, setSelectedMember] = useState("");
  const [ledger, setLedger] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    try {
      const [e, m] = await Promise.all([api<Record<string, unknown>>("/api/v1/admin/economy"), api<{ items: Member[] }>("/api/v1/admin/members")]);
      setEconomy(e); setMembers(m.items);
      setForm({ dailyReward: String(e.daily_reward), cooldown: String(e.daily_cooldown_seconds), starter: String(e.starter_grant), currencyName: String(e.currency_name), currencySymbol: String(e.currency_symbol), recycle: Boolean(e.recycle_enabled) });
    } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    if (!economy) return;
    setBusy("save"); setError(""); setMessage("");
    try {
      await api("/api/v1/admin/economy", { method: "PATCH", body: { expectedVersion: economy.version, dailyReward: Number(form.dailyReward), dailyCooldownSeconds: Number(form.cooldown), starterGrant: Number(form.starter), currencyName: form.currencyName, currencySymbol: form.currencySymbol, recycleEnabled: form.recycle } });
      setMessage("Economy settings saved as a new version. Past ledger entries are unchanged."); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function adjustWallet() {
    setBusy("adjust"); setError(""); setMessage("");
    try {
      const result = await api<{ balance_after: number }>(`/api/v1/admin/wallets/${adjust.userId}/adjust`, { method: "POST", body: { amount: Number(adjust.amount), reason: adjust.reason }, idempotencyKey: idempotencyKey("adjust") });
      setMessage(`Adjustment recorded. Balance is now ✦ ${result.balance_after}.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function loadLedger(id: string) {
    setSelectedMember(id); setError("");
    try { const result = await api<{ ledger: Array<Record<string, unknown>> }>(`/api/v1/admin/wallets/${id}`); setLedger(result.ledger); } catch (cause) { setError(describeError(cause)); }
  }
  return (
    <div>
      <SectionHead eyebrow="Economy" title="One currency. One ledger." description="Integer Foil only. Corrections are compensating ledger entries; there is no set-balance shortcut. The daily allowance and recycle rates are versioned settings." />
      <Notice error={error} message={message} />
      {economy ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_1fr]">
          <section className="surface-flat p-5">
            <p className="eyebrow">Settings · version {String(economy.version)}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Currency name"><Input value={form.currencyName} onChange={(event) => setForm({ ...form, currencyName: event.target.value })} /></Field>
              <Field label="Symbol"><Input value={form.currencySymbol} onChange={(event) => setForm({ ...form, currencySymbol: event.target.value })} /></Field>
              <Field label="Daily allowance"><Input type="number" min="0" value={form.dailyReward} onChange={(event) => setForm({ ...form, dailyReward: event.target.value })} /></Field>
              <Field label="Cooldown seconds"><Input type="number" min="0" value={form.cooldown} onChange={(event) => setForm({ ...form, cooldown: event.target.value })} /></Field>
              <Field label="Starter grant"><Input type="number" min="0" value={form.starter} onChange={(event) => setForm({ ...form, starter: event.target.value })} /></Field>
              <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" className="accent-[var(--green)]" checked={form.recycle} onChange={(event) => setForm({ ...form, recycle: event.target.checked })} />Recycling enabled</label>
            </div>
            <div className="mt-4"><Button onClick={save} disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save settings"}</Button></div>
          </section>
          <section className="surface-flat p-5">
            <p className="eyebrow">Wallet adjustment</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Human owner/economy administrator only. Agents with <code className="font-mono">economy:grant</code> are bounded to 500 Foil per command.</p>
            <div className="mt-3 grid gap-3">
              <Field label="Member"><Select value={adjust.userId} onChange={(event) => setAdjust({ ...adjust, userId: event.target.value })}><option value="">Choose member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.display_name} · {member.email}</option>)}</Select></Field>
              <Field label="Amount (signed integer)"><Input type="number" value={adjust.amount} onChange={(event) => setAdjust({ ...adjust, amount: event.target.value })} /></Field>
              <Field label="Reason (recorded)"><Input value={adjust.reason} onChange={(event) => setAdjust({ ...adjust, reason: event.target.value })} /></Field>
              <Button onClick={adjustWallet} disabled={busy === "adjust" || !adjust.userId || !adjust.reason}>{busy === "adjust" ? "Recording…" : "Record adjustment"}</Button>
            </div>
            <div className="mt-5">
              <Field label="Inspect ledger"><Select value={selectedMember} onChange={(event) => loadLedger(event.target.value)}><option value="">Choose member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}</Select></Field>
              <div className="mt-2 grid gap-1">
                {ledger.slice(0, 8).map((entry) => <div key={String(entry.id)} className="flex justify-between gap-2 text-xs"><span>{String(entry.description)}</span><span className="font-mono">{Number(entry.amount) > 0 ? "+" : ""}{String(entry.amount)}</span></div>)}
              </div>
            </div>
          </section>
        </div>
      ) : <div className="skeleton mt-6 h-48" />}
    </div>
  );
}

function AdminAgents() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState({ agentName: "", representedUserId: "", scopes: ["content:read", "inventory:read"], expiresInDays: "30" });
  const [token, setToken] = useState("");
  const [createdName, setCreatedName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const scopes = ["content:read", "content:write", "catalogue:publish", "import:write", "render:write", "economy:read", "economy:write", "economy:grant", "inventory:read", "draw:execute", "reward:claim", "trade:write", "recycle:write", "settings:write", "ops:read"];

  async function load() {
    try { const [a, m] = await Promise.all([api<{ items: AgentRow[] }>("/api/v1/admin/agents"), api<{ items: Member[] }>("/api/v1/admin/members")]); setAgents(a.items); setMembers(m.items); } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);
  async function create() {
    setBusy("create"); setError(""); setMessage(""); setToken("");
    try {
      const result = await api<{ token: string; grantId: string }>("/api/v1/admin/agents", { method: "POST", body: { agentName: form.agentName, representedUserId: form.representedUserId, scopes: form.scopes, expiresInDays: Number(form.expiresInDays) } });
      setToken(result.token); setCreatedName(form.agentName); setMessage("Grant created. Copy the token now; it is not stored in readable form.");
      setForm({ ...form, agentName: "" }); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function revoke(agent: AgentRow) {
    setBusy(`revoke-${agent.id}`); setError(""); setMessage("");
    try { await api(`/api/v1/admin/agents/${agent.id}/revoke`, { method: "POST", body: {} }); setMessage(`${agent.agent_name} revoked. Existing sessions cannot use the token.`); await load(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  return (
    <div>
      <SectionHead eyebrow="Agents" title="Scoped, revocable authority." description="An agent acts for one represented member within explicit scopes. Agents cannot create, expand or revoke grants, and the grant records both the agent and the member." />
      <Notice error={error} message={message} />
      {token ? <div className="notice mt-4"><p className="eyebrow eyebrow-brass">One-time token · {createdName}</p><p className="mt-2 break-all font-mono text-xs">{token}</p><p className="mt-2 text-xs text-[var(--muted)]">Store it in a secret manager, not a tracked file. This value will not be shown again.</p></div> : null}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="overflow-auto border border-[var(--line)]">
          <table className="table"><thead><tr><th>Agent</th><th>Represents</th><th>Scopes</th><th>Status</th><th>Last used</th><th /></tr></thead><tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <td><p className="font-semibold">{agent.agent_name}</p><p className="font-mono text-[0.58rem] text-[var(--muted)]">{agent.prefix ?? "—"} · expires {formatDual(agent.expires_at)}</p></td>
                <td>{agent.represented_name}</td>
                <td><span className="font-mono text-[0.6rem] text-[var(--muted)]">{(JSON.parse(agent.scopes_json) as string[]).join(", ")}</span></td>
                <td><Status value={agent.status} /></td>
                <td className="text-xs text-[var(--muted)]">{agent.last_used_at ? formatDual(agent.last_used_at) : "never"}</td>
                <td>{agent.status === "active" ? <Button size="sm" variant="danger" onClick={() => revoke(agent)} disabled={Boolean(busy)}>Revoke</Button> : null}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="surface-flat h-fit p-5">
          <p className="eyebrow">New grant · owner only</p>
          <div className="mt-3 grid gap-3">
            <Field label="Agent name"><Input value={form.agentName} onChange={(event) => setForm({ ...form, agentName: event.target.value })} placeholder="local-render-runner" /></Field>
            <Field label="Represents"><Select value={form.representedUserId} onChange={(event) => setForm({ ...form, representedUserId: event.target.value })}><option value="">Choose member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.display_name} · {member.role}</option>)}</Select></Field>
            <Field label="Expires in days"><Input type="number" min="1" max="365" value={form.expiresInDays} onChange={(event) => setForm({ ...form, expiresInDays: event.target.value })} /></Field>
            <div><p className="label">Scopes</p><div className="grid gap-1 sm:grid-cols-2">{scopes.map((scope) => <label key={scope} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-[var(--green)]" checked={form.scopes.includes(scope)} onChange={() => setForm({ ...form, scopes: form.scopes.includes(scope) ? form.scopes.filter((item) => item !== scope) : [...form.scopes, scope] })} />{scope}</label>)}</div></div>
            <Button onClick={create} disabled={busy === "create" || !form.agentName || !form.representedUserId || form.scopes.length === 0}>{busy === "create" ? "Creating…" : "Create grant"}</Button>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">Agent tokens are hashed at rest. The prefix is shown for identification; the secret is shown once.</p>
        </div>
      </div>
    </div>
  );
}

function AdminImports() {
  const [runs, setRuns] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ runs: Array<Record<string, unknown>> }>("/api/v1/admin/imports").then((result) => setRuns(result.runs)).catch((cause) => setError(describeError(cause)));
  }, []);
  return (
    <div>
      <SectionHead eyebrow="Imports" title="Provenance with a paper trail." description="Source imports record repository, relative path, commit, logical ID and hash. A changed source becomes a reviewable artwork edition; it never silently replaces issued cards." />
      <Notice error={error} />
      <div className="mt-5 grid gap-3">
        {runs.map((run) => {
          const summary = (run.summary_json ? JSON.parse(String(run.summary_json)) : {}) as Record<string, number>;
          return (
            <article key={String(run.id)} className="surface-flat p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{String(run.source)} · {String(run.mode)}</p><p className="mt-0.5 font-mono text-[0.58rem] text-[var(--muted)]">{String(run.id)} · {formatDual(String(run.created_at))}</p></div><Status value={String(run.status)} /></div>
              <p className="mt-2 text-xs text-[var(--muted)]">imported {summary.imported ?? 0} · revised {summary.revised ?? 0} · unchanged {summary.unchanged ?? 0} · failed {summary.failed ?? 0}</p>
            </article>
          );
        })}
        {runs.length === 0 ? <div className="empty"><p>No import runs yet. Use <code className="font-mono">pnpm sources:discover</code> and <code className="font-mono">pnpm sources:preview</code> first.</p></div> : null}
      </div>
      <div className="notice mt-5">
        <p className="eyebrow eyebrow-brass">Repeatable source commands</p>
        <pre className="mt-2 overflow-auto font-mono text-[0.68rem] leading-relaxed text-[var(--muted)]">pnpm sources:discover
pnpm sources:preview
pnpm sources:import --apply
pnpm cards:render
pnpm sources:import --apply --publish</pre>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="surface-flat p-4"><p className="eyebrow">Raw assets</p><p className="mt-2 text-sm">Private by default. Only composed card renders are public exports.</p></div>
        <div className="surface-flat p-4"><p className="eyebrow">Revisions</p><p className="mt-2 text-sm">A changed hash creates a new edition for review. Published identities keep their stable IDs.</p></div>
        <div className="surface-flat p-4"><p className="eyebrow">Credit</p><p className="mt-2 text-sm">Optional source credit is retained per edition; no compulsory rights gate blocks ordinary importing.</p></div>
      </div>
    </div>
  );
}

function AdminIntegrations() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Record<string, unknown>>("/api/v1/admin/status").then(setStatus).catch((cause) => setError(describeError(cause))); }, []);
  const providers = (status?.providers ?? {}) as Record<string, boolean>;
  return (
    <div>
      <SectionHead eyebrow="Integrations" title="Optional outside the core." description="Discord uses a signed HTTP interactions endpoint, not a Gateway connection. Email remains a local outbox. Image generation has no recorded spending ceiling, so no billed job was submitted." />
      <Notice error={error} />
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <section className="surface-flat p-5">
          <div className="flex items-center justify-between gap-3"><p className="eyebrow">Discord</p><span className="badge">{providers.discordApplication ? "interactions ready" : "disabled"}</span></div>
          <p className="mt-2 text-sm text-[var(--muted)]">Foilbury verifies Ed25519 signatures against the raw interaction body, resolves the installation server-side, and reuses the same inventory and award ledger as the website. No privileged intents are enabled.</p>
          <div className="mt-4 flex gap-2"><Button size="sm" variant="secondary" disabled title="Not run in this phase">Test admin webhook</Button><a className="btn btn-secondary btn-sm" href="/docs/discord-handoff">Read handoff</a></div>
          <p className="mt-2 text-xs text-[var(--muted)]">The labelled webhook test is intentionally not executed during this build. The destination is {providers.adminWebhook ? "configured" : "missing"} and its URL is never displayed.</p>
        </section>
        <section className="surface-flat p-5">
          <div className="flex items-center justify-between gap-3"><p className="eyebrow">Email</p><span className="badge">outbox only</span></div>
          <p className="mt-2 text-sm text-[var(--muted)]">Resend is optional. The local outbox records delivery intentions transactionally; no email is sent during setup, startup or tests. Sender remains foilbury@loftwah.com.</p>
          <dl className="mt-4 grid gap-2 text-sm"><div className="flex justify-between gap-3"><dt>Resend key</dt><dd className="text-[var(--muted)]">{providers.resend ? "configured · not sent" : "missing"}</dd></div><div className="flex justify-between gap-3"><dt>Outbound webhook</dt><dd className="text-[var(--muted)]">{providers.adminWebhook ? "configured · not called" : "missing"}</dd></div></dl>
        </section>
        <section className="surface-flat p-5">
          <div className="flex items-center justify-between gap-3"><p className="eyebrow">Generation</p><span className="badge">not run</span></div>
          <p className="mt-2 text-sm text-[var(--muted)]">FAL is {providers.fal ? "configured" : "missing"}, but a populated key is not a spending budget. No recorded ceiling exists, so this build uses supplied and authored layers only. A generation plan endpoint refuses to submit a billed batch.</p>
          <div className="mt-4"><a className="btn btn-secondary btn-sm" href="/admin/catalogue">Use authored layers</a></div>
        </section>
        <section className="surface-flat p-5">
          <div className="flex items-center justify-between gap-3"><p className="eyebrow">Cloudflare</p><span className="badge">deployed</span></div>
          <p className="mt-2 text-sm text-[var(--muted)]">The production Worker uses Cloudflare D1, R2 and KV bindings. Discord interactions and the website share the same deployed domain; media visibility remains authorised by the domain service.</p>
          <p className="mt-3 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-[var(--brass)]">{providers.fal || providers.resend || providers.adminWebhook ? "Some optional providers are configured" : "Optional providers absent — core still works"}</p>
        </section>
      </div>
    </div>
  );
}

function AdminAudit() {
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  useEffect(() => { api<{ items: Array<Record<string, unknown>> }>("/api/v1/admin/audit?limit=150").then((result) => setItems(result.items)).catch((cause) => setError(describeError(cause))); }, []);
  return (
    <div>
      <SectionHead eyebrow="Audit" title="Who did what, and for whom." description="Application commands record actor, represented member, object, request correlation and a redacted metadata payload. Ledger history is never edited in place." />
      <Notice error={error} />
      <div className="mt-5 overflow-auto border border-[var(--line)]">
        <table className="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Object</th><th>Request</th></tr></thead><tbody>
          {items.map((item) => (
            <tr key={String(item.id)}>
              <td className="text-xs text-[var(--muted)]">{formatDual(String(item.created_at))}</td>
              <td><p className="text-sm">{String(item.actor_type)} · {String(item.actor_id).slice(0, 16)}</p><p className="font-mono text-[0.56rem] text-[var(--muted)]">{item.represented_user_id ? `represents ${String(item.represented_user_id).slice(0, 16)}` : "no represented member"}</p></td>
              <td className="font-mono text-[0.68rem]">{String(item.action)}</td>
              <td className="text-xs text-[var(--muted)]">{String(item.object_type)} · {String(item.object_id).slice(0, 18)}</td>
              <td className="font-mono text-[0.56rem] text-[var(--muted)]">{String(item.request_id ?? "—").slice(0, 18)}</td>
            </tr>
          ))}
          {items.length === 0 ? <tr><td colSpan={5} className="text-[var(--muted)]">No audit events yet.</td></tr> : null}
        </tbody></table>
      </div>
    </div>
  );
}

function AdminDesign() {
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<{ items: Card[] }>("/api/v1/admin/cards?limit=200").then((result) => { setCards(result.items); setSelected(result.items[0] ?? null); }).catch((cause) => setError(describeError(cause))); }, []);
  const variants = selected?.editions.flatMap((edition) => edition.variants.map((variant) => ({ ...variant, edition: edition.name }))) ?? [];
  const byMaterial = variants.reduce<Record<string, Array<Variant & { edition: string }>>>((groups, variant) => { (groups[variant.material_key] ??= []).push(variant); return groups; }, {});
  return (
    <div>
      <SectionHead eyebrow="Finish studio" title="One identity, several finishes." description="Every finish is an authored material + frame layer, not a CSS tint. The live card and the exported render use the same pinned recipe and layer names." />
      <Notice error={error} />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label className="field min-w-72"><span className="label">Card</span><select className="select" value={selected?.id ?? ""} onChange={(event) => setSelected(cards.find((card) => card.id === event.target.value) ?? null)}>{cards.map((card) => <option key={card.id} value={card.id}>{card.name} · {card.slug}</option>)}</select></label>
        <p className="mt-4 font-mono text-[0.6rem] uppercase tracking-[0.1em] text-[var(--muted)]">{variants.length} variants · {variants.filter((variant) => variant.render_url).length} rendered</p>
      </div>
      {selected ? (
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(byMaterial).map(([material, items]) => (
            <section key={material} className="border border-[var(--line)] p-3">
              <div className="flex items-center justify-between gap-2"><p className="eyebrow">{material}</p><span className="font-mono text-[0.58rem] text-[var(--muted)]">{items[0]?.edition}</span></div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {items.map((variant) => (
                  <div key={variant.id}>
                    <div className="card-face">{variant.render_url ? <img src={variant.render_url} alt={`${selected.name} — ${variant.name}`} loading="lazy" /> : <div className="card-face-fallback">{selected.name.charAt(0)}</div>}</div>
                    <p className="mt-1 text-[0.68rem]">{variant.name}</p>
                    <p className="font-mono text-[0.55rem] text-[var(--muted)]">{variant.render_url ? "published render" : "awaiting render"}</p>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}
      <div className="notice mt-6">
        <p className="eyebrow eyebrow-brass">Layer contract</p>
        <p className="mt-2 text-sm">background → subject artwork → material → frame → effect → exact application text. Recipe and asset versions are pinned at publication. The static render is composed locally; no image provider is called.</p>
      </div>
    </div>
  );
}

function AdminTopics() {
  const [policies, setPolicies] = useState<Array<{ id: string; channel_key: string; name: string; exclude_tags: string[]; active: boolean }>>([]);
  const [tenant, setTenant] = useState<{ public_catalogue: boolean; blocked_tags: string[]; active_release: number | null } | null>(null);
  const [publicCatalogue, setPublicCatalogue] = useState(true);
  const [blockedTags, setBlockedTags] = useState("");
  const [form, setForm] = useState({ channelKey: "", name: "", excludeTags: "" });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    try {
      const [p, t] = await Promise.all([api<{ items: Array<{ id: string; channel_key: string; name: string; exclude_tags: string[]; active: boolean }> }>("/api/v1/admin/topics"), api<{ public_catalogue: boolean; blocked_tags: string[]; active_release: number | null }>("/api/v1/admin/tenant")]);
      setPolicies(p.items); setTenant(t); setPublicCatalogue(t.public_catalogue); setBlockedTags(t.blocked_tags.join(", "));
    } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void load(); }, []);
  async function saveTenant() {
    setBusy("tenant"); setError(""); setMessage("");
    try {
      await api("/api/v1/admin/tenant", { method: "PATCH", body: { publicCatalogue, blockedTags: blockedTags ? blockedTags.split(",").map((tag) => tag.trim()).filter(Boolean) : [] } });
      setMessage("Tenant publication settings saved. Topic policies can only narrow availability, never override a tenant block.");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function createPolicy() {
    setBusy("create"); setError(""); setMessage("");
    try {
      await api("/api/v1/admin/topics", { method: "POST", body: { channelKey: form.channelKey, name: form.name, excludeTags: form.excludeTags ? form.excludeTags.split(",").map((tag) => tag.trim()).filter(Boolean) : [] } });
      setForm({ channelKey: "", name: "", excludeTags: "" }); setMessage("Community policy created."); await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  async function toggle(policy: { id: string; active: boolean }) {
    setBusy(policy.id); setError(""); setMessage("");
    try { await api(`/api/v1/admin/topics/${policy.id}`, { method: "PATCH", body: { active: !policy.active } }); await load(); } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }
  return (
    <div>
      <SectionHead eyebrow="Topics & availability" title="Narrow the room, never the odds." description="Tenant-wide publication settings and community/entrypoint policies narrow the eligible pool. The preview always recalculates the actual odds; a player preference can narrow further but cannot re-enable a blocked topic." />
      <Notice error={error} message={message} />
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section className="surface-flat p-5">
          <p className="eyebrow">Tenant publication</p>
          <p className="mt-1 text-xs text-[var(--muted)]">Active catalogue release: {tenant?.active_release ? `v${tenant.active_release}` : "none yet"}. The release remains immutable; these settings control future distribution and presentation.</p>
          <label className="mt-4 flex items-center justify-between gap-4"><span className="text-sm font-semibold">Public catalogue</span><Switch checked={publicCatalogue} onCheckedChange={setPublicCatalogue} aria-label="Public catalogue" /></label>
          <div className="mt-4"><Field label="Tenant blocked tags" hint="Comma separated tag slugs; applies to every entrypoint"><Input value={blockedTags} onChange={(event) => setBlockedTags(event.target.value)} placeholder="horror, strong-language" /></Field></div>
          <div className="mt-4"><Button onClick={saveTenant} disabled={busy === "tenant"}>{busy === "tenant" ? "Saving…" : "Save tenant settings"}</Button></div>
        </section>
        <section className="surface-flat p-5">
          <p className="eyebrow">Community / entrypoint policies</p>
          <div className="mt-3 grid gap-3">
            <Field label="Channel key"><Input value={form.channelKey} onChange={(event) => setForm({ ...form, channelKey: event.target.value })} placeholder="family-table" /></Field>
            <Field label="Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Family table" /></Field>
            <Field label="Exclude tags" hint="Comma separated tag slugs"><Input value={form.excludeTags} onChange={(event) => setForm({ ...form, excludeTags: event.target.value })} placeholder="horror" /></Field>
            <Button onClick={createPolicy} disabled={busy === "create" || !form.channelKey || !form.name}>{busy === "create" ? "Creating…" : "Create policy"}</Button>
          </div>
        </section>
      </div>
      <div className="mt-6 overflow-auto border border-[var(--line)]">
        <table className="table"><thead><tr><th>Channel</th><th>Name</th><th>Excluded tags</th><th>Status</th><th /></tr></thead><tbody>
          {policies.map((policy) => (
            <tr key={policy.id}><td className="font-mono text-xs">{policy.channel_key}</td><td>{policy.name}</td><td className="text-[var(--muted)]">{policy.exclude_tags.join(", ") || "—"}</td><td><Status value={policy.active ? "active" : "retired"} /></td><td><Button size="sm" variant="secondary" onClick={() => toggle(policy)} disabled={Boolean(busy)}>{policy.active ? "Disable" : "Enable"}</Button></td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}

export default function AdminApp({ section, platformAdmin = false }: { section: AdminSection; platformAdmin?: boolean }) {
  switch (section) {
    case "overview": return <AdminOverview />;
    case "catalogue": return <AdminCatalogue />;
    case "collections": return <AdminCollections platformAdmin={platformAdmin} />;
    case "team": return <AdminTeam />;
    case "taxonomy": return <AdminTaxonomy />;
    case "topics": return <AdminTopics />;
    case "sets": return <AdminSets />;
    case "pools": return <AdminPools />;
    case "economy": return <AdminEconomy />;
    case "imports": return <AdminImports />;
    case "agents": return <AdminAgents />;
    case "design": return <AdminDesign />;
    case "integrations": return <AdminIntegrations />;
    case "audit": return <AdminAudit />;
    default: return <AdminOverview />;
  }
}
