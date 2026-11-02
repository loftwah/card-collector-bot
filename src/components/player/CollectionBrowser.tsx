"use client";

import { useState } from "react";
import { Heart, Lock, Search } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { cn } from "@/lib/utils";

interface Item {
  id: string;
  card_name: string;
  card_slug: string;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  rarity_name: string | null;
  serial: string;
  status: string;
  favourite: number;
  locked: number;
  render_url: string | null;
  acquired_at: string;
}

export default function CollectionBrowser({ initialItems, sets, collections = [], initialCollection = "" }: { initialItems: Item[]; sets: Array<{ slug: string; name: string }>; collections?: Array<{ slug: string; name: string; logo_url: string | null }>; initialCollection?: string }) {
  const [items, setItems] = useState(initialItems);
  const [search, setSearch] = useState("");
  const [favouriteOnly, setFavouriteOnly] = useState(false);
  const [setSlug, setSetSlug] = useState("");
  const [collectionSlug, setCollectionSlug] = useState(initialCollection);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load(next?: { search?: string; favourite?: boolean; set?: string; collection?: string }) {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      const q = next?.search ?? search;
      const f = next?.favourite ?? favouriteOnly;
      const s = next?.set ?? setSlug;
      const collection = next?.collection ?? collectionSlug;
      if (q) params.set("search", q);
      if (f) params.set("favourite", "true");
      if (s) params.set("set", s);
      if (collection) params.set("collection", collection);
      params.set("limit", "300");
      const result = await api<{ items: Item[] }>(`/api/v1/inventory?${params.toString()}`);
      setItems(result.items);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function favourite(item: Item) {
    const next = !item.favourite;
    setItems((current) => current.map((row) => (row.id === item.id ? { ...row, favourite: next ? 1 : 0 } : row)));
    try {
      await api(`/api/v1/instances/${item.id}/favourite`, { method: "POST", body: { favourite: next } });
    } catch (cause) {
      setItems((current) => current.map((row) => (row.id === item.id ? { ...row, favourite: item.favourite } : row)));
      setError(describeError(cause));
    }
  }

  return (
    <div>
      <form
        className="grid gap-3 border-b border-[var(--line)] pb-5 md:grid-cols-[1fr_auto_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <label className="field">
          <span className="label">Search your collection</span>
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" aria-hidden="true" />
            <input className="input pl-9" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Card name, finish or description" />
          </div>
        </label>
        <label className="field">
          <span className="label">Collection</span>
          <select className="select" value={collectionSlug} onChange={(event) => { setCollectionSlug(event.target.value); void load({ collection: event.target.value }); }}>
            <option value="">All collections</option>
            {collections.map((collection) => <option key={collection.slug} value={collection.slug}>{collection.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Set</span>
          <select className="select" value={setSlug} onChange={(event) => { setSetSlug(event.target.value); void load({ set: event.target.value }); }}>
            <option value="">All sets</option>
            {sets.map((set) => <option key={set.slug} value={set.slug}>{set.name}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className={cn("btn btn-secondary btn-sm", favouriteOnly && "border-[var(--brass)] text-[var(--brass)]")}
            aria-pressed={favouriteOnly}
            onClick={() => { const next = !favouriteOnly; setFavouriteOnly(next); void load({ favourite: next }); }}
          >
            <Heart size={14} aria-hidden="true" /> Favourites
          </button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>{loading ? "Loading…" : "Apply"}</button>
        </div>
      </form>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--muted)]" aria-live="polite">{items.length} card{items.length === 1 ? "" : "s"} in view</p>
        <p className="font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[var(--muted)]">Foil ledger lives on the server</p>
      </div>

      {error ? <div className="error-box mt-4" role="alert">{error}</div> : null}

      {items.length ? (
        <div className="card-grid mt-5">
          {items.map((item) => (
            <article key={item.id} className="group relative">
              <a href={`/play/card/${item.id}`} className="block no-underline">
                <div className="card-face">
                  {item.render_url ? <img src={item.render_url} alt={`${item.card_name} — ${item.variant_name}`} loading="lazy" /> : <div className="card-face-fallback">{item.card_name.charAt(0)}</div>}
                </div>
                <div className="mt-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="display-sm text-base leading-tight">{item.card_name}</p>
                    {item.status === "reserved" ? <span className="badge">Reserved</span> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">{item.variant_name}</p>
                  <p className="mt-1 font-mono text-[0.56rem] uppercase tracking-[0.1em] text-[var(--muted)]">{item.serial}</p>
                </div>
              </a>
              <div className="absolute right-2 top-2 flex gap-1">
                <button
                  type="button"
                  className={cn("flex h-8 w-8 items-center justify-center rounded-full border backdrop-blur", item.favourite ? "border-[var(--brass)] bg-[var(--paper)]/90 text-[var(--brass)]" : "border-white/30 bg-black/30 text-white/80")}
                  onClick={() => favourite(item)}
                  aria-label={item.favourite ? `Remove ${item.card_name} from favourites` : `Favourite ${item.card_name}`}
                  aria-pressed={Boolean(item.favourite)}
                >
                  <Heart size={14} fill={item.favourite ? "currentColor" : "none"} />
                </button>
                {item.locked ? <span className="flex h-8 w-8 items-center justify-center rounded-full border border-white/30 bg-black/35 text-white/80" title="Locked"><Lock size={13} /></span> : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty mt-5">
          <div>
            <p className="display-sm text-2xl">{loading ? "Looking through the drawers…" : "No cards match this view."}</p>
            {!loading ? <p className="mt-2 text-sm">Try removing a filter, or open the <a className="underline" href="/play/draw">draw room</a>.</p> : null}
          </div>
        </div>
      )}
    </div>
  );
}
