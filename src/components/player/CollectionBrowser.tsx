"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Loader2, Lock, Search } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { cn, printTitle } from "@/lib/utils";

interface Item {
  id: string;
  card_name: string;
  card_slug: string;
  edition_name: string;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  rarity_name: string | null;
  serial: string;
  status: string;
  favourite: number;
  locked: number;
  render_url: string | null;
  thumbnail_url: string | null;
  acquired_at: string;
}

interface FilterState {
  search: string;
  favourite: boolean;
  set: string;
  collection: string;
}

const PAGE_SIZE = 24;

export default function CollectionBrowser({
  initialItems,
  initialTotal,
  sets,
  collections = [],
  initialCollection = "",
  initialSearch = "",
  initialFavourite = false,
  initialSet = "",
}: {
  initialItems: Item[];
  initialTotal?: number;
  sets: Array<{ slug: string; name: string }>;
  collections?: Array<{ slug: string; name: string; logo_url: string | null }>;
  initialCollection?: string;
  initialSearch?: string;
  initialFavourite?: boolean;
  initialSet?: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal ?? initialItems.length);
  const [search, setSearch] = useState(initialSearch);
  const [favouriteOnly, setFavouriteOnly] = useState(initialFavourite);
  const [setSlug, setSetSlug] = useState(initialSet);
  const [collectionSlug, setCollectionSlug] = useState(initialCollection);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [failedFilter, setFailedFilter] = useState<FilterState | null>(null);
  const requestId = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const hasMore = items.length < total;

  const load = useCallback(
    async (next: Partial<FilterState> = {}, mode: "replace" | "append" = "replace") => {
      const filters: FilterState = {
        search: next.search ?? search,
        favourite: next.favourite ?? favouriteOnly,
        set: next.set ?? setSlug,
        collection: next.collection ?? collectionSlug,
      };
      const sequence = ++requestId.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const offset = mode === "append" ? items.length : 0;
      if (mode === "append") setLoadingMore(true);
      else setLoading(true);
      setError("");
      setFailedFilter(null);

      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.favourite) params.set("favourite", "true");
      if (filters.set) params.set("set", filters.set);
      if (filters.collection) params.set("collection", filters.collection);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));

      try {
        const result = await api<{ items: Item[]; total: number }>(
          `/api/v1/inventory?${params.toString()}`,
          {
            signal: controller.signal,
          },
        );
        if (sequence !== requestId.current) return;
        setItems((current) => (mode === "append" ? [...current, ...result.items] : result.items));
        setTotal(Number.isFinite(result.total) ? result.total : result.items.length);
        if (mode === "replace" && typeof window !== "undefined") {
          const url = new URL(window.location.href);
          ["search", "favourite", "set", "collection"].forEach((key) =>
            url.searchParams.delete(key),
          );
          if (filters.search) url.searchParams.set("search", filters.search);
          if (filters.favourite) url.searchParams.set("favourite", "true");
          if (filters.set) url.searchParams.set("set", filters.set);
          if (filters.collection) url.searchParams.set("collection", filters.collection);
          window.history.replaceState({}, "", url);
        }
      } catch (cause) {
        if (controller.signal.aborted || sequence !== requestId.current) return;
        setError(describeError(cause));
        setFailedFilter(filters);
      } finally {
        if (sequence === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [collectionSlug, favouriteOnly, items.length, search, setSlug],
  );

  /* Restore a filtered view from the URL after back/forward/deep-link. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial: FilterState = {
      search: params.get("search") ?? "",
      favourite: params.get("favourite") === "true",
      set: params.get("set") ?? "",
      collection: params.get("collection") ?? initialCollection,
    };
    const alreadyRendered =
      initial.search === initialSearch &&
      initial.favourite === initialFavourite &&
      initial.set === initialSet &&
      initial.collection === initialCollection;
    if (alreadyRendered) return;
    setSearch(initial.search);
    setFavouriteOnly(initial.favourite);
    setSetSlug(initial.set);
    setCollectionSlug(initial.collection);
    void load(initial);
    // Runs once for the initial URL; filters are re-applied explicitly after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setHydrated(true);
    return () => abort.current?.abort();
  }, []);

  async function favourite(item: Item) {
    const next = !item.favourite;
    setItems((current) =>
      current.map((row) => (row.id === item.id ? { ...row, favourite: next ? 1 : 0 } : row)),
    );
    try {
      await api(`/api/v1/instances/${item.id}/favourite`, {
        method: "POST",
        body: { favourite: next },
      });
    } catch (cause) {
      setItems((current) =>
        current.map((row) => (row.id === item.id ? { ...row, favourite: item.favourite } : row)),
      );
      setError(describeError(cause));
    }
  }

  const countLabel = total === 1 ? "1 card" : `${total} cards`;
  const visibleLabel =
    items.length === total
      ? `${countLabel} in this view`
      : `${items.length} of ${countLabel} loaded`;
  const hasFilters = Boolean(search || favouriteOnly || setSlug || collectionSlug);

  return (
    <div data-hydrated={hydrated ? "true" : "false"}>
      <form
        className="grid gap-3 border-b border-[var(--line)] pb-5 md:grid-cols-[1fr_auto_auto_auto]"
        method="get"
        action="/play/collection"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        {favouriteOnly ? <input type="hidden" name="favourite" value="true" /> : null}
        <label className="field">
          <span className="label">Search your collection</span>
          <div className="relative">
            <Search
              size={15}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--muted)]"
              aria-hidden="true"
            />
            <input
              className="input pl-9"
              type="search"
              name="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void load();
                }
              }}
              placeholder="Card name, finish or description"
            />
          </div>
        </label>
        <label className="field">
          <span className="label">Collection</span>
          <select
            className="select"
            name="collection"
            value={collectionSlug}
            onChange={(event) => {
              setCollectionSlug(event.target.value);
              void load({ collection: event.target.value });
            }}
          >
            <option value="">All collections</option>
            {collections.map((collection) => (
              <option key={collection.slug} value={collection.slug}>
                {collection.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Set</span>
          <select
            className="select"
            name="set"
            value={setSlug}
            onChange={(event) => {
              setSetSlug(event.target.value);
              void load({ set: event.target.value });
            }}
          >
            <option value="">All sets</option>
            {sets.map((set) => (
              <option key={set.slug} value={set.slug}>
                {set.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className={cn(
              "btn btn-secondary btn-sm",
              favouriteOnly && "!border-[var(--signal)] !text-[var(--signal)]",
            )}
            aria-pressed={favouriteOnly}
            onClick={() => {
              const next = !favouriteOnly;
              setFavouriteOnly(next);
              void load({ favourite: next });
            }}
          >
            <Heart size={14} aria-hidden="true" /> Favourites
          </button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p
          className="font-mono text-[0.62rem] tracking-[0.12em] text-[var(--muted)] uppercase"
          aria-live="polite"
        >
          {loading ? "Loading your cards…" : visibleLabel}
        </p>
        <p className="font-mono text-[0.58rem] tracking-[0.12em] text-[var(--muted)] uppercase">
          Foil ledger lives on the server
        </p>
      </div>

      {error ? (
        <div className="error-box mt-4" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="btn btn-secondary btn-sm mt-2"
            onClick={() => void load(failedFilter ?? {}, "replace")}
          >
            Try again
          </button>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="card-grid mt-5" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="grid gap-2">
              <div className="skeleton aspect-[5/7] w-full" />
              <div className="skeleton h-3 w-2/3" />
              <div className="skeleton h-2 w-1/2" />
            </div>
          ))}
        </div>
      ) : items.length ? (
        <>
          <div className="card-grid mt-5">
            {items.map((item, index) => (
              <article key={item.id} className="group">
                <a href={`/play/card/${item.id}`} className="block no-underline">
                  <div className="card-face">
                    {item.render_url ? (
                      <img
                        src={item.thumbnail_url ?? item.render_url}
                        alt={`${item.card_name} — ${printTitle(item.edition_name) ?? item.variant_name}`}
                        loading={index < 4 ? "eager" : "lazy"}
                        width="300"
                        height="420"
                      />
                    ) : (
                      <div className="card-face-fallback">{item.card_name.charAt(0)}</div>
                    )}
                  </div>
                  <div className="mt-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="display-sm line-clamp-2 text-base leading-tight">
                        {item.card_name}
                      </p>
                      {item.status === "reserved" ? <span className="badge">Reserved</span> : null}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                      {printTitle(item.edition_name) ? `${printTitle(item.edition_name)} · ` : ""}
                      {item.variant_name}
                    </p>
                    <p className="mt-1 font-mono text-[0.56rem] tracking-[0.1em] text-[var(--muted)] uppercase">
                      {item.serial}
                    </p>
                  </div>
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    className={cn(
                      "btn btn-ghost collection-favourite gap-2 px-2 text-xs",
                      item.favourite ? "text-[var(--signal)]" : "text-[var(--muted)]",
                    )}
                    onClick={() => favourite(item)}
                    aria-label={
                      item.favourite
                        ? `Remove ${item.card_name} from favourites`
                        : `Favourite ${item.card_name}`
                    }
                    aria-pressed={Boolean(item.favourite)}
                  >
                    <Heart size={14} fill={item.favourite ? "currentColor" : "none"} />
                    {item.favourite ? "Favourited" : "Favourite"}
                  </button>
                  {item.locked ? (
                    <span
                      className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--muted)]"
                      title="Locked"
                    >
                      <Lock size={13} />
                      Locked
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          {hasMore ? (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void load({}, "append")}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Loading more…
                  </>
                ) : (
                  `Load ${Math.min(PAGE_SIZE, total - items.length)} more`
                )}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty mt-5">
          <div>
            <p className="display-sm text-2xl">
              {hasFilters ? "No cards match this view." : "Your drawers are empty."}
            </p>
            <p className="mt-2 text-sm">
              {hasFilters
                ? "Try removing a filter, or open the draw room."
                : "Claim the daily allowance, then open a capsule to start your collection."}
            </p>
            {hasFilters ? (
              <a className="btn btn-secondary btn-sm mt-4" href="/play/collection">
                Reset filters
              </a>
            ) : (
              <a className="btn btn-primary btn-sm mt-4" href="/play/draw">
                Open a capsule
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
