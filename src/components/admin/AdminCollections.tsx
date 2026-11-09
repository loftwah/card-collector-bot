"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe2, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { api, apiUpload, ApiClientError, describeError, idempotencyKey } from "@/lib/client";
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
  logo_asset_id?: string | null;
  banner_asset_id?: string | null;
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
interface BrandReview { collection_id:string;collection_name:string;collection_version:number;asset_id:string;asset_revision:number;object_version:string;sha256:string;slot:'logo'|'cover';mime:string;bytes:number;preview_url:string }

function CollectionMark({ collection }: { collection: Collection }) {
  if (collection.logo_url) return <img src={collection.logo_url} alt="" className="h-12 w-12 object-contain" />;
  return <span className="grid h-12 w-12 place-items-center border border-[var(--line-strong)] bg-[var(--paper-3)] font-display text-xl">{collection.name.slice(0, 1)}</span>;
}

export default function AdminCollections({ platformAdmin, globalCollectionAdmin = false, botAdmin = false }: { platformAdmin: boolean; globalCollectionAdmin?: boolean; botAdmin?: boolean }) {
  const canCreateGlobal = platformAdmin || globalCollectionAdmin;
  const [collections, setCollections] = useState<Collection[]>([]);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [pendingCreation, setPendingCreation] = useState(false);
  const [brandRecovery,setBrandRecovery]=useState<{role:'logo'|'cover';key:string;scope:string}|null>(null);
  const [brandReview,setBrandReview]=useState<BrandReview|null>(null);
  const [brandImageLoaded,setBrandImageLoaded]=useState(false);
  const [brandIssues,setBrandIssues]=useState<Array<{collectionId:string;collectionName:string;tenantName:string;currentTenant:boolean;collectionVersion:number;slot:string;reason:string;canClear:boolean}>|null>(null);
  const [moreBrandIssues,setMoreBrandIssues]=useState(false);
  const pendingRequest = useRef<{key:string;body:Record<string,unknown>;signature:string;logo:File|null;cover:File|null}|null>(null);
  const stagedUploads = useRef<{signature:string;logoFile:File|null;coverFile:File|null;logoUrl?:string;bannerUrl?:string}|null>(null);
  const [collectionCards, setCollectionCards] = useState<Array<{ id: string; name: string; slug: string; status: string; render_url: string | null }>>([]);
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

  async function uploadBrand(file: File, role: "logo" | "cover", access: string, scope: string, key?: string) {
    const data = new FormData();
    data.append("file", file);
    data.append("kind", "brand");
    data.append("name", `${form.name || "Collection"} ${role}`);
    data.append("role", role);
    data.append("access", access === "public" ? "public" : scope === "bot" ? "private" : "member");
    data.append("reviewStatus", "reviewed");
    data.append("provenance", "Uploaded by the collection owner. Review permission before publishing.");
    if (key) data.append('collectionScope',scope);
    const result = await apiUpload<{ asset: { id: string } }>("/api/v1/admin/assets", data, key);
    return `/media/asset/${result.asset.id}`;
  }
  const selected = collections.find((collection) => collection.id === selectedId) ?? null;
  useEffect(()=>{setBrandReview(null);setBrandImageLoaded(false);},[selectedId]);

  async function inspectBrand(assetId:string) {
    if (!selected) return;
    setBusy('brand-review');setError('');setMessage('');setBrandReview(null);setBrandImageLoaded(false);
    try {
      const result=await api<{review:BrandReview}>(`/api/v1/admin/collections/${encodeURIComponent(selected.id)}/brand-release?assetId=${encodeURIComponent(assetId)}`);
      setBrandReview(result.review);
    } catch (cause) {setError(describeError(cause));} finally {setBusy('');}
  }
  async function reconcileBrandReferences(collectionId?:string) {
    setBusy('brand-index');setError('');setMessage('');
    try {
      const result=await api<{processed:number;remaining:number}>('/api/v1/admin/collections/brand-reference-index/reconcile',{method:'POST',body:collectionId ? {collectionId} : {}});
      setMessage(result.remaining ? `Checked ${result.processed} collection references. ${result.remaining} remain; run the check again.` : `Collection image references are up to date. Checked ${result.processed} collections.`);
      if (brandIssues) {const issues=await api<{items:typeof brandIssues;more:boolean}>('/api/v1/admin/collections/brand-reference-index/issues');setBrandIssues(issues.items);setMoreBrandIssues(issues.more);}
    } catch (cause) {setError(describeError(cause));} finally {setBusy('');}
  }
  async function inspectBrandIssues() {
    setBusy('brand-issues');setError('');
    try {const result=await api<{items:NonNullable<typeof brandIssues>;more:boolean}>('/api/v1/admin/collections/brand-reference-index/issues');setBrandIssues(result.items);setMoreBrandIssues(result.more);}
    catch (cause) {setError(describeError(cause));} finally {setBusy('');}
  }
  async function startBrandRebuild() {
    if (!window.confirm('Start a full image-reference recheck after repairing the index triggers? Public image access may be unavailable until every pass completes.')) return;
    setBusy('brand-rebuild');setError('');setMessage('');
    try {await api('/api/v1/admin/collections/brand-reference-index/rebuild',{method:'POST',body:{}});setMessage('Full recheck started. Run Check image references until no collections remain.');}
    catch (cause) {setError(describeError(cause));} finally {setBusy('');}
  }
  async function clearBrandIssue(issue:NonNullable<typeof brandIssues>[number]) {
    if (!window.confirm(`Clear the ${issue.slot} URL for ${issue.collectionName}? The original is retained in private history. Public approval, if any, will be withdrawn.`)) return;
    setBusy('brand-clear');setError('');setMessage('');
    try {
      await api('/api/v1/admin/collections/brand-reference-index/clear',{method:'POST',body:{collectionId:issue.collectionId,collectionVersion:issue.collectionVersion,slot:issue.slot}});
      const result=await api<{items:NonNullable<typeof brandIssues>;more:boolean}>('/api/v1/admin/collections/brand-reference-index/issues');setBrandIssues(result.items);setMoreBrandIssues(result.more);
      setMessage('The reference was cleared. Its previous value is retained privately; recheck this collection to update the index.');
    } catch (cause) {setError(describeError(cause));} finally {setBusy('');}
  }
  async function approveBrand() {
    if (!brandReview || !brandImageLoaded || selectedId!==brandReview.collection_id) return;
    setBusy('brand-approve');setError('');setMessage('');
    try {
      await api(`/api/v1/admin/collections/${encodeURIComponent(brandReview.collection_id)}/brand-release`,{method:'POST',body:{assetId:brandReview.asset_id,collectionVersion:brandReview.collection_version,assetRevision:brandReview.asset_revision,objectVersion:brandReview.object_version,sha256:brandReview.sha256}});
      setBrandReview(null);setBrandImageLoaded(false);setMessage('The reviewed image was approved for this collection’s public showcase.');
    } catch (cause) {setBrandReview(null);setBrandImageLoaded(false);setError(describeError(cause));} finally {setBusy('');}
  }

  async function load() {
    try {
      const [c, cardsResult] = await Promise.all([
        api<{ items: Collection[] }>("/api/v1/admin/collections"),
        api<{ items: CardRow[] }>("/api/v1/admin/cards?limit=200"),
      ]);
      setCollections(c.items);
      setCards(cardsResult.items);
      if (!selectedId && c.items[0]) setSelectedId(c.items[0].id);
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  useEffect(() => { setPendingCreation(Boolean(sessionStorage.getItem('foilbury.pending-collection'))); void load(); }, []);

  async function loadCollection(id: string) {
    if (!id) { setCollectionCards([]); return; }
    try {
      const result = await api<{ cards: Array<{ id: string; name: string; slug: string; status: string; render_url: string | null }> }>(`/api/v1/admin/collections/${id}`);
      setCollectionCards(result.cards);
    } catch (cause) { setError(describeError(cause)); }
  }
  useEffect(() => { void loadCollection(selectedId); }, [selectedId]);

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
    let firstAttempt=false;
    try {
      const signature=JSON.stringify(form);
      if (sessionStorage.getItem('foilbury.pending-collection') && !pendingRequest.current)
        throw new Error('A previous request may have created a collection. Check its status before creating another.');
      if (pendingRequest.current && (pendingRequest.current.signature!==signature || pendingRequest.current.logo!==logoFile || pendingRequest.current.cover!==coverFile))
        throw new Error('The previous request may have completed. Restore its original inputs or check its status first.');
      if (!pendingRequest.current) {
        const uploadOne=async (file:File,role:'logo'|'cover')=>{
          type Entry={fingerprint:string;key:string};
          let saved:Partial<Record<'logo'|'cover',Entry>>={};
          const raw=sessionStorage.getItem('foilbury.pending-brand-uploads');
          if (raw) { try { saved=JSON.parse(raw); } catch { throw new Error('The previous image upload could not be recovered.'); } }
          if (!saved || typeof saved!=='object' || ('fingerprint' in saved)) throw new Error('The previous image upload could not be recovered.');
          const digest=async (bytes:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map((b)=>b.toString(16).padStart(2,'0')).join('');
          const fingerprint=await digest(new TextEncoder().encode(JSON.stringify({name:form.name,scope:form.scope,access:form.viewAudience,role,bytes:await digest(await file.arrayBuffer())})));
          let entry=saved[role];const fresh=!entry;
          if (entry && (entry.fingerprint!==fingerprint || !entry.key)) throw new Error('A previous image upload may have completed. Restore the original image and its collection name and scope to retry.');
          if (!entry) { entry={fingerprint,key:idempotencyKey(`brand-${role}`)};saved[role]=entry;sessionStorage.setItem('foilbury.pending-brand-uploads',JSON.stringify(saved)); }
          try { return await uploadBrand(file,role,form.viewAudience,form.scope,entry.key); }
          catch (cause) {
            if (cause instanceof ApiClientError && ['render_input_changed','brand_upload_changed'].includes(cause.code)) setBrandRecovery({role,key:entry.key,scope:form.scope});
            if (fresh && cause instanceof ApiClientError && ['brand_upload_unavailable','asset_size_invalid','asset_type_invalid','asset_corrupt','asset_dimensions_invalid','brand_upload_invalid','idempotency_key_invalid'].includes(cause.code)) {
              delete saved[role];
              if (Object.keys(saved).length) sessionStorage.setItem('foilbury.pending-brand-uploads',JSON.stringify(saved));
              else sessionStorage.removeItem('foilbury.pending-brand-uploads');
            }
            throw cause;
          }
        };
        if (!stagedUploads.current || stagedUploads.current.signature!==signature || stagedUploads.current.logoFile!==logoFile || stagedUploads.current.coverFile!==coverFile)
          stagedUploads.current={signature,logoFile,coverFile,logoUrl:form.logoUrl || undefined};
        const staged=stagedUploads.current;
        if (logoFile && !staged.logoUrl) staged.logoUrl=await uploadOne(logoFile,'logo');
        if (coverFile && !staged.bannerUrl) staged.bannerUrl=await uploadOne(coverFile,'cover');
        const {logoUrl,bannerUrl}=staged;
        pendingRequest.current={key:idempotencyKey('collection'),body:{...form,logoUrl:logoUrl || undefined,bannerUrl,viewAudience:form.viewAudience,sourceWork:form.sourceWork || undefined},signature,logo:logoFile,cover:coverFile};
        firstAttempt=true;
      }
      const pending=pendingRequest.current;
      sessionStorage.setItem('foilbury.pending-collection',pending.key);setPendingCreation(true);
      const result = await api<{ collection: Collection }>("/api/v1/admin/collections", { method: "POST", body:pending.body,idempotencyKey:pending.key });
      sessionStorage.removeItem('foilbury.pending-collection');sessionStorage.removeItem('foilbury.pending-brand-uploads');pendingRequest.current=null;stagedUploads.current=null;setPendingCreation(false);
      setForm({ name: "", slug: "", description: "", scope: canCreateGlobal ? "global" : "bot", logoUrl: "", accent: "aqua", status: "draft", viewAudience: "members", sourceWork: "" });
      setLogoFile(null);
      setCoverFile(null);
      setMessage(`${result.collection.scope === "global" ? "Global" : "Bot"} collection created.`);
      await load();
      setSelectedId(result.collection.id);
    } catch (cause) {
      if (firstAttempt && cause instanceof ApiClientError && ['collection_authority_changed','collection_name_invalid','collection_slug_invalid','bot_collection_not_public','public_requires_publish','human_public_approval_required','validation_failed','invalid_json','body_too_large','idempotency_key_invalid','global_collection_admin_required','collection_not_in_scope','content_capability_required','bot_required','super_admin_required'].includes(cause.code)) {
        sessionStorage.removeItem('foilbury.pending-collection');pendingRequest.current=null;setPendingCreation(false);
      }
      setError(describeError(cause));
    } finally { setBusy(""); }
  }

  async function abandonBrand() {
    if (!brandRecovery) return;
    setBusy('abandon-brand');setError('');setMessage('');
    try {
      await api('/api/v1/admin/assets/uploads/abandon',{method:'POST',body:{key:brandRecovery.key,scope:brandRecovery.scope}});
      const raw=sessionStorage.getItem('foilbury.pending-brand-uploads');
      const saved=raw ? JSON.parse(raw) : {};
      if (saved[brandRecovery.role]?.key===brandRecovery.key) delete saved[brandRecovery.role];
      if (Object.keys(saved).length) sessionStorage.setItem('foilbury.pending-brand-uploads',JSON.stringify(saved));
      else sessionStorage.removeItem('foilbury.pending-brand-uploads');
      if (stagedUploads.current) {
        if (brandRecovery.role==='logo') stagedUploads.current.logoUrl=undefined;
        else stagedUploads.current.bannerUrl=undefined;
      }
      setBrandRecovery(null);setMessage('The earlier image upload was abandoned and retained. Choose the image again to start a new upload.');
    } catch (cause) {setError(describeError(cause));} finally {setBusy('');}
  }

  async function checkPendingCreation() {
    setBusy('recover');setError('');setMessage('');
    try {
      const key=sessionStorage.getItem('foilbury.pending-collection');
      if (!key) {setPendingCreation(false);return;}
      const result=await api<{found:boolean;collection?:Collection}>(`/api/v1/admin/collections/recovery/${encodeURIComponent(key)}`);
      if (!result.found || !result.collection) {setMessage('No collection is visible yet. The request may still be in progress; check again before creating another.');return;}
      sessionStorage.removeItem('foilbury.pending-collection');sessionStorage.removeItem('foilbury.pending-brand-uploads');pendingRequest.current=null;setPendingCreation(false);
      setMessage('The earlier collection was created.');await load();setSelectedId(result.collection.id);
    } catch (cause) {setError(describeError(cause));} finally {setBusy('');}
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
      await load(); await loadCollection(selected.id);
    } catch (cause) { setError(describeError(cause)); } finally { setBusy(""); }
  }

  async function removeCard(cardId: string) {
    if (!selected) return;
    setBusy(cardId); setError(""); setMessage("");
    try {
      await api(`/api/v1/admin/collections/${selected.id}/cards/${cardId}`, { method: "DELETE", body: undefined });
      setMessage("Card removed from the collection.");
      await load(); await loadCollection(selected.id);
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
      {platformAdmin ? <section className="surface mt-6 space-y-3 p-5" aria-labelledby="brand-reference-heading">
        <h3 id="brand-reference-heading" className="font-semibold">Collection image references</h3>
        <p className="text-sm text-[var(--muted)]">Check changed references before public image review. Large backlogs may need more than one pass.</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={()=>reconcileBrandReferences()}>{busy==='brand-index'?'Checking references…':'Check image references'}</Button><Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={inspectBrandIssues}>Inspect reference issues</Button><Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={startBrandRebuild}>Start full recheck after repair</Button></div>
        {brandIssues ? <div className="space-y-2" aria-live="polite">{brandIssues.length ? brandIssues.map((issue)=><div className="border border-[var(--line)] p-3 text-sm" key={`${issue.collectionId}-${issue.slot}`}><p className="font-semibold">{issue.collectionName} · {issue.slot}</p><p className="text-[var(--muted)]">{issue.tenantName}</p><p>{issue.reason}</p><div className="mt-2 flex flex-wrap gap-2">{issue.currentTenant ? <Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={()=>setSelectedId(issue.collectionId)}>Open collection</Button> : null}{issue.canClear ? <Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={()=>clearBrandIssue(issue)}>Clear this URL</Button> : null}<Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={()=>reconcileBrandReferences(issue.collectionId)}>Recheck this collection</Button></div></div>) : <p className="text-sm text-[var(--muted)]">No unresolved URL issues found. Pending checks may remain.</p>}{moreBrandIssues ? <p className="text-sm text-[var(--muted)]">More collections need checking; resolve the listed items and refresh.</p> : null}</div> : null}
      </section> : null}

      <div className="mt-6 grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="eyebrow">Visible to this Bot</p><span className="font-mono text-[0.6rem] text-[var(--muted)]">{collections.filter((collection) => collection.enabled).length} on · {filteredCollections.length} shown</span></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search world, source or owner" aria-label="Search collections" />
            <Select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} aria-label="Filter by status"><option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option></Select>
          </div>
          <div className="mt-3 grid gap-2">
            {pagedCollections.map((collection) => (
              <div key={collection.id} className={`border p-3 transition-colors ${selectedId === collection.id ? "border-[var(--brass)] bg-[var(--paper-2)]" : "border-[var(--line)]"}`}>
                <div className="flex items-start gap-3">
                  <CollectionMark collection={collection} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(collection.id)}>
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
            ))}
            {filteredCollections.length === 0 ? <p className="empty">No collections match this search and status.</p> : null}
          </div>
          {pageCount > 1 ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3">
              <p className="font-mono text-[0.58rem] uppercase tracking-[0.08em] text-[var(--muted)]">Page {safePage} of {pageCount}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPage(Math.max(1, safePage - 1))} disabled={safePage === 1}>Previous</Button>
                <Button size="sm" variant="secondary" onClick={() => setPage(Math.min(pageCount, safePage + 1))} disabled={safePage === pageCount}>Next</Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="surface-flat p-5">
          {selected ? (
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
                {platformAdmin && selected.scope==='global' && selected.status==='published' && selected.view_audience==='public' && selected.public_approved_at ? <section className="space-y-3 border-t border-[var(--line)] pt-4" aria-labelledby="brand-review-heading">
                  <h4 id="brand-review-heading" className="font-semibold">Review public collection images</h4>
                  <p className="text-sm text-[var(--muted)]">Review each image separately. Approval applies to this collection and this exact saved image; changing the collection or image requires another review.</p>
                  <div className="flex flex-wrap gap-2">
                    {selected.logo_asset_id ? <Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={()=>inspectBrand(selected.logo_asset_id!)}>Review logo</Button> : null}
                    {selected.banner_asset_id ? <Button size="sm" variant="secondary" className="min-h-11" disabled={Boolean(busy)} onClick={()=>inspectBrand(selected.banner_asset_id!)}>Review cover</Button> : null}
                  </div>
                  {brandReview && brandReview.collection_id===selected.id ? <div className="space-y-3 border border-[var(--line)] p-3">
                    <p className="text-sm font-semibold">{brandReview.collection_name} · {brandReview.slot==='logo'?'Logo':'Cover'}</p>
                    <img src={brandReview.preview_url} alt={`${brandReview.collection_name} ${brandReview.slot} awaiting review`} className="max-h-72 w-full object-contain" onLoad={()=>setBrandImageLoaded(true)} onError={()=>{setBrandImageLoaded(false);setError('The image could not be loaded. Reload the review before approving.');}} />
                    <p className="break-all font-mono text-xs text-[var(--muted)]">SHA-256 {brandReview.sha256}</p>
                    <p className="text-sm">Approving makes this exact image available on the public showcase for this collection. Confirm its identity, rights and credit before approving.</p>
                    <Button size="sm" className="min-h-11" disabled={!brandImageLoaded || Boolean(busy)} onClick={approveBrand}>{busy==='brand-approve'?'Approving…':'Approve this image for public showcase'}</Button>
                  </div> : null}
                </section> : null}
              </div>
            </>
          ) : <p className="text-sm text-[var(--muted)]">Choose a collection to inspect it.</p>}

          {selected ? (
            <div className="mt-6 border-t border-[var(--line)] pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3"><p className="eyebrow">Cards in {selected.name}</p><span className="font-mono text-[0.6rem] text-[var(--muted)]">{collectionCards.length} cards</span></div>
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
        {pendingCreation ? <Button className="mt-4" variant="secondary" onClick={checkPendingCreation} disabled={busy !== ''}>Check previous collection</Button> : null}
        {brandRecovery ? <Button className="mt-4" variant="secondary" onClick={abandonBrand} disabled={busy !== ''}>Abandon changed {brandRecovery.role} upload</Button> : null}
      </section>
    </div>
  );
}
