"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { api, apiUpload, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/input";
import { Switch } from "../ui/switch";

interface Collection {
  id: string;
  slug: string;
  name: string;
  description: string;
  scope: "global" | "bot";
  logo_url: string | null;
  banner_url: string | null;
  accent: string;
  status: string;
  view_audience: "public" | "members" | "private";
  public_approved_at: string | null;
  source_work: string | null;
  release_version: number;
  card_count: number;
  enabled: boolean;
  manageable: boolean;
  owner_name: string;
}

interface CardRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  category: { name: string } | null;
}

function CollectionMark({ collection }: { collection: Collection }) {
  if (collection.logo_url) return <img src={collection.logo_url} alt="" className="h-12 w-12 object-contain" />;
  return <span className="grid h-12 w-12 place-items-center border border-[var(--line-strong)] bg-[var(--paper-3)] font-display text-xl">{collection.name.slice(0, 1)}</span>;
}

export default function AdminCollections({ platformAdmin, globalCollectionAdmin = false, botAdmin = false }: { platformAdmin: boolean; globalCollectionAdmin?: boolean; botAdmin?: boolean }) {
  const canCreateGlobal = platformAdmin || globalCollectionAdmin;
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const loadSequence = useRef(0);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [collectionCards, setCollectionCards] = useState<Array<{ id: string; name: string; slug: string; status: string; render_url: string | null }>>([]);
  const [detailId, setDetailId] = useState("");
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const detailSequence = useRef(0);
  const [addIds, setAddIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ name: "", slug: "", description: "", scope: canCreateGlobal ? "global" : "bot", logoUrl: "", accent: "aqua", status: "draft", viewAudience: "members", sourceWork: "" });
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  async function uploadBrand(file: File, role: "logo" | "cover", access: string, scope: string) {
    const data = new FormData();
    data.append("file", file);
    data.append("kind", "brand");
    data.append("name", `${form.name || "Collection"} ${role}`);
    data.append("role", role);
    data.append("access", access === "public" ? "public" : scope === "bot" ? "private" : "member");
    data.append("reviewStatus", "reviewed");
    data.append("provenance", "Uploaded by the collection owner. Review permission before publishing.");
    const result = await apiUpload<{ asset: { id: string } }>("/api/v1/admin/assets", data);
    return `/media/asset/${result.asset.id}`;
  }
  const selected = collections.find((collection) => collection.id === selectedId) ?? null;

  async function load() {
    const sequence = ++loadSequence.current;
    ++detailSequence.current;
    setCollectionCards([]); setAddIds([]); setDetailId(""); setDetailState("idle");
    setLoadState("loading");
    setLoadError("");
    try {
      const [c, cardsResult] = await Promise.all([
        api<{ items: Collection[] }>("/api/v1/admin/collections"),
        api<{ items: CardRow[] }>("/api/v1/admin/cards?limit=200"),
      ]);
      if (sequence !== loadSequence.current) return;
      if (!Array.isArray(c.items) || !Array.isArray(cardsResult.items)) throw new Error("Invalid collection response");
      setCollections(c.items);
      setCards(cardsResult.items);
      setSelectedId((current) => c.items.some((item) => item.id === current) ? current : (c.items[0]?.id ?? ""));
      setDetailRefresh((generation) => generation + 1);
      setLoadState("ready");
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setCollections([]);
      setCards([]);
      setSelectedId("");
      setLoadError(describeError(cause));
      setLoadState("error");
    }
  }
  useEffect(() => { void load(); }, []);

  async function loadCollection(id: string) {
    const sequence = ++detailSequence.current;
    const listSequence = loadSequence.current;
    setCollectionCards([]); setAddIds([]); setDetailId(id); setDetailError("");
    if (!id) { setDetailState("idle"); return; }
    setDetailState("loading");
    try {
      const result = await api<{ cards: Array<{ id: string; name: string; slug: string; status: string; render_url: string | null }> }>(`/api/v1/admin/collections/${id}`);
      if (sequence !== detailSequence.current || listSequence !== loadSequence.current) return;
      if (!Array.isArray(result.cards)) throw new Error("Invalid collection cards response");
      setCollectionCards(result.cards);
      setDetailState("ready");
    } catch (cause) {
      if (sequence !== detailSequence.current || listSequence !== loadSequence.current) return;
      setDetailError(describeError(cause));
      setDetailState("error");
    }
  }
  function chooseCollection(id: string) {
    if (id === selectedId) return;
    ++detailSequence.current;
    setCollectionCards([]); setAddIds([]); setDetailId(""); setDetailState("idle");
    setSelectedId(id);
  }
  useEffect(() => { if (loadState === "ready") void loadCollection(selectedId); }, [selectedId, loadState, detailRefresh]);

  const availableCards = useMemo(() => cards.filter((card) => !collectionCards.some((item) => item.id === card.id) && card.status !== "retired"), [cards, collectionCards]);
  const filteredCollections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return collections.filter((collection) => {
      if (statusFilter !== "all" && collection.status !== statusFilter) return false;
      if (!needle) return true;
      return `${collection.name} ${collection.slug} ${collection.source_work ?? ""} ${collection.owner_name}`.toLowerCase().includes(needle);
    });
  }, [collections, query, statusFilter]);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(filteredCollections.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedCollections = filteredCollections.slice((safePage - 1) * pageSize, safePage * pageSize);

  async function create() {
    setBusy("create"); setError(""); setMessage("");
    try {
      let logoUrl = form.logoUrl;
      let bannerUrl: string | undefined;
      if (logoFile) logoUrl = await uploadBrand(logoFile, "logo", form.viewAudience, form.scope);
      if (coverFile) bannerUrl = await uploadBrand(coverFile, "cover", form.viewAudience, form.scope);
      const result = await api<{ collection: Collection }>("/api/v1/admin/collections", { method: "POST", body: { ...form, logoUrl: logoUrl || undefined, bannerUrl, viewAudience: form.viewAudience, sourceWork: form.sourceWork || undefined } });
      setForm({ name: "", slug: "", description: "", scope: canCreateGlobal ? "global" : "bot", logoUrl: "", accent: "aqua", status: "draft", viewAudience: "members", sourceWork: "" });
      setLogoFile(null);
      setCoverFile(null);
      setMessage(`${result.collection.scope === "global" ? "Global" : "Bot"} collection created.`);
      await load();
      setSelectedId(result.collection.id);
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function toggle(collection: Collection) {
    setBusy(collection.id); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/collections/${collection.id}/enable`, { method: "POST", body: { enabled: !collection.enabled } });
      setMessage(`${collection.name} is now ${collection.enabled ? "off" : "on"} for this Bot. Cards in a disabled collection cannot drop.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function addCards() {
    if (!selected || !addIds.length) return;
    setBusy("add"); setError(""); setMessage("");
    try {
      const result = await api<{ added: number }>(`/api/v1/admin/collections/${selected.id}/cards`, { method: "POST", body: { cardIds: addIds } });
      setAddIds([]);
      setMessage(`${result.added} card${result.added === 1 ? "" : "s"} added to ${selected.name}.`);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function removeCard(cardId: string) {
    if (!selected) return;
    setBusy(cardId); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/collections/${selected.id}/cards/${cardId}`, { method: "DELETE", body: undefined });
      setMessage("Card removed from the collection.");
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function saveCollection() {
    if (!selected) return;
    setBusy("save"); setError(""); setMessage("");
    try {
      let logoUrl = selected.logo_url;
      let bannerUrl = selected.banner_url;
      if (logoFile) logoUrl = await uploadBrand(logoFile, "logo", selected.view_audience, selected.scope);
      if (coverFile) bannerUrl = await uploadBrand(coverFile, "cover", selected.view_audience, selected.scope);
      await api(`/api/v1/admin/collections/${selected.id}`, { method: "PATCH", body: {
        name: selected.name,
        description: selected.description,
        logoUrl,
        bannerUrl,
        accent: selected.accent,
        status: selected.status,
        viewAudience: selected.view_audience,
        sourceWork: selected.source_work,
        expectedVersion: selected.release_version,
      } });
      setMessage("Collection details saved.");
      setLogoFile(null);
      setCoverFile(null);
      await load();
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5">
        <div><p className="eyebrow">Collections</p><h2 className="display-sm mt-1 text-4xl">Worlds with a front door.</h2><p className="mt-2 max-w-3xl text-sm text-[var(--muted)]">A collection is a named world with a logo, description and card membership. Global collections are curated by the Super Admin or a scoped Global Collection Admin and can be turned on or off per Bot. Your Bot collections are private to this Bot.</p></div>
      </div>
      {error ? <div className="error-box mt-4" role="alert">{error}</div> : null}
      {message ? <div className="success-box mt-4" role="status">{message}</div> : null}

      <div className="mt-6 grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="eyebrow">Visible to this Bot</p><span className="font-mono text-[0.6rem] text-[var(--muted)]" role="status">{loadState === "loading" ? "Loading collections…" : loadState === "error" ? "Collections unavailable" : `${collections.filter((collection) => collection.enabled).length} on · ${filteredCollections.length} shown`}</span></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input disabled={loadState !== "ready"} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search world, source or owner" aria-label="Search collections" />
            <Select disabled={loadState !== "ready"} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} aria-label="Filter by status"><option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option></Select>
          </div>
          <div className="studio-collections-loading mt-3 grid gap-2" aria-busy={loadState === "loading"}>
            {loadState === "loading" ? Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex min-h-[6.5rem] items-center gap-3 border border-[var(--line)] p-3" aria-hidden="true">
                <span className="skeleton h-12 w-12 shrink-0" /><span className="grid flex-1 gap-2"><span className="skeleton h-4 w-2/3" /><span className="skeleton h-3 w-4/5" /><span className="skeleton h-3 w-1/2" /></span>
              </div>
            )) : null}
            {loadState === "error" ? <div className="error-box" role="alert"><p>Could not load collections. {loadError}</p><Button className="mt-3" size="sm" variant="secondary" onClick={() => void load()}>Retry loading collections</Button></div> : null}
            {loadState === "ready" ? pagedCollections.map((collection) => (
              <div key={collection.id} className={`min-h-[6.5rem] border p-3 transition-colors ${selectedId === collection.id ? "border-[var(--brass)] bg-[var(--paper-2)]" : "border-[var(--line)]"}`}>
                <div className="flex items-start gap-3">
                  <CollectionMark collection={collection} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => chooseCollection(collection.id)}>
                    <p className="flex items-center gap-2 font-semibold">{collection.name} {collection.scope === "global" ? <span className="badge badge-rare"><Globe2 size={11} /> Global</span> : <span className="badge">Your Bot</span>}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-[var(--muted)]">{collection.description || "No description yet."}</p>
                    <p className="mt-1 font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">{collection.card_count} cards · {collection.status} · {collection.view_audience === "public" ? "public showcase" : collection.view_audience} · {collection.owner_name}</p>
                  </button>
                  <div className="grid justify-items-end gap-2">
                    {collection.scope === "global" && !collection.manageable ? <span className="text-[0.58rem] uppercase tracking-wider text-[var(--muted)]"><Lock size={11} className="inline" /> Read-only</span> : null}
                    {botAdmin ? <Switch checked={collection.enabled} onCheckedChange={() => toggle(collection)} aria-label={`${collection.enabled ? "Disable" : "Enable"} ${collection.name} for this Bot`} disabled={Boolean(busy)} /> : null}
                    {botAdmin ? <span className="text-[0.56rem] uppercase tracking-wider text-[var(--muted)]">{collection.enabled ? "On" : "Off"}</span> : null}
                  </div>
                </div>
              </div>
            )) : null}
            {loadState === "ready" && filteredCollections.length === 0 ? <p className="empty">No collections match this search and status.</p> : null}
          </div>
          {loadState === "ready" && pageCount > 1 ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3">
              <p className="font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">Page {safePage} of {pageCount}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage === 1}>Previous</Button>
                <Button size="sm" variant="secondary" onClick={() => setPage(Math.min(pageCount, safePage + 1))} disabled={safePage === pageCount}>Next</Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className={`surface-flat p-5 ${loadState === "loading" || (loadState === "ready" && selected) ? "min-h-[75rem] xl:min-h-[60rem]" : ""}`}>
          {loadState === "loading" ? <div className="studio-collections-loading grid min-h-[32rem] content-start gap-4" aria-label="Loading collection details" aria-busy="true"><span className="skeleton h-12 w-2/3" /><span className="skeleton h-12 w-full" /><span className="skeleton h-24 w-full" /><span className="skeleton h-12 w-full" /><span className="skeleton h-12 w-full" /></div> : loadState === "error" ? <p className="text-sm text-[var(--muted)]">Collection details are unavailable until the list is loaded.</p> : selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3"><CollectionMark collection={selected} /><div><p className="eyebrow">{selected.scope === "global" ? "Global collection" : "Bot collection"}</p><h3 className="display-sm text-2xl">{selected.name}</h3></div></div>
                <div className="flex flex-wrap gap-2"><span className={`badge ${selected.view_audience === "public" ? "badge-rare" : ""}`}>{selected.view_audience === "public" ? "Public showcase" : selected.view_audience}</span><span className={`badge ${selected.status === "published" ? "badge-rare" : ""}`}>{selected.status}</span></div>
              </div>
              <div className="mt-4 grid gap-3">
                <Field label="Name"><Input value={selected.name} onChange={(event) => setCollections((items) => items.map((item) => item.id === selected.id ? { ...item, name: event.target.value } : item))} disabled={!selected.manageable} /></Field>
                <Field label="Description"><Textarea value={selected.description} onChange={(event) => setCollections((items) => items.map((item) => item.id === selected.id ? { ...item, description: event.target.value } : item))} disabled={!selected.manageable} /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Logo URL" hint="Local path or HTTPS image. Leave empty for the monogram."><Input value={selected.logo_url ?? ""} onChange={(event) => setCollections((items) => items.map((item) => item.id === selected.id ? { ...item, logo_url: event.target.value } : item))} disabled={!selected.manageable} placeholder="/art/collections/bubbles.svg" /></Field>
                  <Field label="Status"><Select value={selected.status} onChange={(event) => setCollections((items) => items.map((item) => item.id === selected.id ? { ...item, status: event.target.value } : item))} disabled={!selected.manageable}><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></Select></Field>
                  <Field label="Viewing audience" hint={selected.view_audience === "public" ? "Approved for the signed-out public showcase." : selected.view_audience === "members" ? "Signed-in members of this album or Bot." : "Owner scope and explicitly invited viewers only."}>
                    <Select value={selected.view_audience} onChange={(event) => setCollections((items) => items.map((item) => item.id === selected.id ? { ...item, view_audience: event.target.value as Collection["view_audience"] } : item))} disabled={!selected.manageable || (!platformAdmin && selected.view_audience === "public")}>
                      <option value="members">Members</option>
                      <option value="private">Private</option>
                      {platformAdmin ? <option value="public">Public showcase (Super Admin approval)</option> : null}
                    </Select>
                  </Field>
                  <Field label="Source work" hint="The work or property this world adapts, if any."><Input value={selected.source_work ?? ""} onChange={(event) => setCollections((items) => items.map((item) => item.id === selected.id ? { ...item, source_work: event.target.value } : item))} disabled={!selected.manageable} /></Field>
                </div>
                {selected.view_audience === "public" ? <p className="notice text-xs">Public approval is explicit. Only approved Loftwah project content should be public. Changing this to members takes effect immediately for new media requests; previously downloaded copies cannot be recalled.</p> : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Upload a logo" hint="PNG, JPEG or WebP up to 8 MB."><Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)} disabled={!selected.manageable} /></Field>
                  <Field label="Upload a cover" hint="Used on the collection panel and album header."><Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)} disabled={!selected.manageable} /></Field>
                </div>
                {selected.manageable ? <Button size="sm" onClick={saveCollection} disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save collection details"}</Button> : <p className="text-xs text-[var(--muted)]">This collection is outside your scope. Ask the Super Admin for a scoped assignment.</p>}
              </div>
            </>
          ) : <p className="text-sm text-[var(--muted)]">Choose a collection to inspect it.</p>}

          {loadState === "ready" && selected ? (
            <div className="mt-6 border-t border-[var(--line)] pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3"><p className="eyebrow">Cards in {selected.name}</p><span className="font-mono text-[0.6rem] text-[var(--muted)]">{detailId === selected.id && detailState === "ready" ? `${collectionCards.length} cards` : ""}</span></div>
              {detailId !== selected.id || detailState === "idle" || detailState === "loading" ? <p className="mt-3 text-sm text-[var(--muted)]" role="status">Loading cards…</p> : detailState === "error" ? <div className="error-box mt-3" role="alert"><p>Could not load cards. {detailError}</p><Button className="mt-3" size="sm" variant="secondary" onClick={() => void loadCollection(selected.id)}>Retry loading cards</Button></div> : <>
              <div className="mt-3 grid gap-2">
                {collectionCards.map((card) => (
                  <div key={card.id} className="flex items-center justify-between gap-3 border border-[var(--line)] px-3 py-2">
                    <div className="min-w-0"><p className="truncate text-sm font-semibold">{card.name}</p><p className="font-mono text-[0.58rem] text-[var(--muted)]">{card.status}</p></div>
                    {selected.manageable ? <Button size="sm" variant="ghost" onClick={() => removeCard(card.id)} disabled={Boolean(busy)} aria-label={`Remove ${card.name}`}><Trash2 size={13} /></Button> : null}
                  </div>
                ))}
                {collectionCards.length === 0 ? <p className="text-sm text-[var(--muted)]">No cards yet. Add the first card below.</p> : null}
              </div>
              {selected.manageable ? (
                <div className="mt-4 border-t border-[var(--line)] pt-4">
                  <p className="eyebrow">Add cards</p>
                  <div className="mt-2 max-h-56 overflow-auto border border-[var(--line)] p-2">
                    {availableCards.map((card) => (
                      <label key={card.id} className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-[var(--ink)]/5">
                        <input type="checkbox" checked={addIds.includes(card.id)} onChange={(event) => setAddIds((ids) => event.target.checked ? [...ids, card.id] : ids.filter((id) => id !== card.id))} />
                        <span>{card.name}</span><span className="ml-auto font-mono text-[0.56rem] text-[var(--muted)]">{card.category?.name ?? "—"}</span>
                      </label>
                    ))}
                    {availableCards.length === 0 ? <p className="p-2 text-xs text-[var(--muted)]">No other cards are available in this catalogue scope.</p> : null}
                  </div>
                  <Button className="mt-3" size="sm" onClick={addCards} disabled={!addIds.length || busy === "add"}>{busy === "add" ? <><Loader2 className="animate-spin" size={13} /> Adding…</> : <><Plus size={13} /> Add selected cards</>}</Button>
                </div>
              ) : null}
              </>}
            </div>
          ) : null}
        </section>
      </div>

      <section className="surface mt-6 p-5">
        <p className="eyebrow">Create a collection</p>
        <h3 className="display-sm mt-1 text-2xl">{platformAdmin ? "A shared world, or one for this Bot." : globalCollectionAdmin ? "A shared world, curated with care." : "A world for this Bot."}</h3>
        <p className="mt-1 text-sm text-[var(--muted)]">{platformAdmin ? "Global collections are visible to every Bot and can be enabled per Bot. Bot collections stay with this tenant." : globalCollectionAdmin ? "Your assignment covers shared collections only. You can edit metadata, branding and release state; public showcase approval and platform root remain with the Super Admin." : "Your collection is private to this Bot. You will see global collections alongside it, but you cannot edit them."}</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="Name"><Input value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); if (!form.slug) setForm((current) => ({ ...current, name: event.target.value, slug: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") })); }} placeholder="NBA Nights" /></Field>
          <Field label="Slug"><Input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="nba-nights" /></Field>
          <Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="A courtside cabinet of icons, rookies and deep cuts." /></Field>
          <Field label="Logo URL" hint="Use a licensed logo you have rights to. Local path or HTTPS."><Input value={form.logoUrl} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} placeholder="/art/collections/your-world.svg" /></Field>
          <Field label="Scope"><Select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} disabled={!canCreateGlobal}>{canCreateGlobal ? <><option value="global">Global · visible to every Bot</option><option value="bot">Bot · private to this Bot</option></> : <option value="bot">Bot · private to this Bot</option>}</Select></Field>
          <Field label="Initial status"><Select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="draft">Draft</option><option value="published">Published</option></Select></Field>
          <Field label="Viewing audience"><Select value={form.viewAudience} onChange={(event) => setForm({ ...form, viewAudience: event.target.value })}>{platformAdmin && form.scope === "global" ? <option value="public">Public showcase (Super Admin approval)</option> : null}<option value="members">Members only</option><option value="private">Private</option></Select></Field>
          <Field label="Source work"><Input value={form.sourceWork} onChange={(event) => setForm({ ...form, sourceWork: event.target.value })} placeholder="e.g. Original Foilbury project" /></Field>
          <Field label="Logo upload"><Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)} /></Field>
          <Field label="Cover upload"><Input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)} /></Field>
        </div>
        <Button className="mt-4" onClick={create} disabled={busy === "create" || form.name.trim().length < 2}>{busy === "create" ? "Creating…" : "Create collection"}</Button>
      </section>
    </div>
  );
}
