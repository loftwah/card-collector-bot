"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Handshake, Heart, Loader2, Lock, Search } from "lucide-react";
import { ApiClientError, api, describeError } from "@/lib/client";
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
  duplicate_count: number;
  render_url: string | null;
  thumbnail_url: string | null;
  acquired_at: string;
}

interface FilterState {
  search: string;
  favourite: boolean;
  set: string;
  collection: string;
  finish: string;
  duplicates: boolean;
  sort: string;
}

const FINISH_OPTIONS = [
  { value: "", label: "All finishes" },
  { value: "plain", label: "Plain" },
  { value: "silver", label: "Silver" },
  { value: "gold", label: "Gold" },
  { value: "holographic", label: "Holographic" },
] as const;

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Name A–Z" },
  { value: "finish", label: "Finish" },
] as const;

const PAGE_SIZE = 24;

export default function CollectionBrowser({
  initialItems,
  initialTotal,
  scopeKey,
  sets,
  collections = [],
  initialCollection = "",
  initialSearch = "",
  initialFavourite = false,
  initialSet = "",
}: {
  initialItems: Item[];
  initialTotal?: number;
  scopeKey: string;
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
  const [finish, setFinish] = useState("");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [sort, setSort] = useState("newest");
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [placeholderCount, setPlaceholderCount] = useState(8);
  const [placeholderHeight, setPlaceholderHeight] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const initialScope = useRef(scopeKey);
  const [scopeInvalidated, setScopeInvalidated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [failedFilter, setFailedFilter] = useState<FilterState | null>(null);
  const [failedMode, setFailedMode] = useState<"replace" | "append" | null>(null);
  const requestId = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const hasMore = items.length < total;
  const scopeChanged = scopeInvalidated || initialScope.current !== scopeKey;

  const load = useCallback(
    async (next: Partial<FilterState> = {}, mode: "replace" | "append" = "replace") => {
      const filters: FilterState = {
        search: next.search ?? search,
        favourite: next.favourite ?? favouriteOnly,
        set: next.set ?? setSlug,
        collection: next.collection ?? collectionSlug,
        finish: next.finish ?? finish,
        duplicates: next.duplicates ?? duplicatesOnly,
        sort: next.sort ?? sort,
      };
      const sequence = ++requestId.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const offset = mode === "append" ? items.length : 0;
      if (mode === "append") setLoadingMore(true);
      else {
        setPlaceholderCount(Math.min(PAGE_SIZE, Math.max(1, items.length || 8)));
        setPlaceholderHeight(gridRef.current?.offsetHeight ?? 0);
        setItems([]);
        setTotal(0);
        setLoading(true);
      }
      setError("");
      setFailedFilter(null);
      setFailedMode(null);

      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.favourite) params.set("favourite", "true");
      if (filters.set) params.set("set", filters.set);
      if (filters.collection) params.set("collection", filters.collection);
      if (filters.finish) params.set("finish", filters.finish);
      if (filters.duplicates) params.set("duplicates", "true");
      if (filters.sort && filters.sort !== "newest") params.set("sort", filters.sort);
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
          ["search", "favourite", "set", "collection", "finish", "duplicates", "sort"].forEach(
            (key) => url.searchParams.delete(key),
          );
          if (filters.search) url.searchParams.set("search", filters.search);
          if (filters.favourite) url.searchParams.set("favourite", "true");
          if (filters.set) url.searchParams.set("set", filters.set);
          if (filters.collection) url.searchParams.set("collection", filters.collection);
          if (filters.finish) url.searchParams.set("finish", filters.finish);
          if (filters.duplicates) url.searchParams.set("duplicates", "true");
          if (filters.sort && filters.sort !== "newest") url.searchParams.set("sort", filters.sort);
          window.history.replaceState({}, "", url);
        }
      } catch (cause) {
        if (controller.signal.aborted || sequence !== requestId.current) return;
        setError(describeError(cause));
        setFailedFilter(filters);
        const authLost =
          cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403);
        if (authLost) {
          setItems([]);
          setTotal(0);
        }
        setFailedMode(authLost ? "replace" : mode);
      } finally {
        if (sequence === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [collectionSlug, duplicatesOnly, favouriteOnly, finish, items.length, search, setSlug, sort],
  );

  /* Restore a filtered view from the URL after back/forward/deep-link. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial: FilterState = {
      search: params.get("search") ?? "",
      favourite: params.get("favourite") === "true",
      set: params.get("set") ?? "",
      collection: params.get("collection") ?? initialCollection,
      finish: params.get("finish") ?? "",
      duplicates: params.get("duplicates") === "true",
      sort: params.get("sort") ?? "newest",
    };
    const alreadyRendered =
      initial.search === initialSearch &&
      initial.favourite === initialFavourite &&
      initial.set === initialSet &&
      initial.collection === initialCollection &&
      initial.finish === "" &&
      initial.duplicates === false &&
      initial.sort === "newest";
    if (alreadyRendered) return;
    setSearch(initial.search);
    setFavouriteOnly(initial.favourite);
    setSetSlug(initial.set);
    setCollectionSlug(initial.collection);
    setFinish(initial.finish);
    setDuplicatesOnly(initial.duplicates);
    setSort(initial.sort);
    void load(initial);
    // Runs once for the initial URL; filters are re-applied explicitly after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setHydrated(true);
    return () => abort.current?.abort();
  }, []);

  useEffect(() => {
    if (initialScope.current === scopeKey) return;
    abort.current?.abort();
    requestId.current += 1;
    setItems([]);
    setTotal(0);
    setScopeInvalidated(true);
  }, [scopeKey]);

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
  const hasFilters = Boolean(
    search || favouriteOnly || setSlug || collectionSlug || finish || duplicatesOnly,
  );

  if (scopeChanged) {
    return (
      <p className="notice" role="alert">
        Your account or Bot changed. Reload this page to view the current collection.
      </p>
    );
  }

  return (
    <div className="collection-browser" data-hydrated={hydrated ? "true" : "false"}>
      <form
        className="inventory-filters border-b border-[var(--line)] pb-5"
        method="get"
        action="/play/collection"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        {favouriteOnly ? <input type="hidden" name="favourite" value="true" /> : null}
        <label className="field inventory-filters__search">
          <span className="label">Search your cards</span>
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
              placeholder="Name, serial, finish or collection"
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
          <span className="label">Finish</span>
          <select
            className="select"
            name="finish"
            value={finish}
            onChange={(event) => {
              setFinish(event.target.value);
              void load({ finish: event.target.value });
            }}
          >
            {FINISH_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Sort</span>
          <select
            className="select"
            name="sort"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              void load({ sort: event.target.value });
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
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
        <label className="inventory-check">
          <input
            type="checkbox"
            name="duplicates"
            value="true"
            checked={duplicatesOnly}
            onChange={(event) => {
              setDuplicatesOnly(event.target.checked);
              void load({ duplicates: event.target.checked });
            }}
          />
          <span>Duplicates only</span>
        </label>
        <div className="inventory-filters__actions">
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </button>
          <a className="btn btn-ghost btn-sm" href="/play/collection">
            Reset
          </a>
        </div>
      </form>

      <div className="inventory-quickfilters" aria-label="Quick filters">
        <button
          type="button"
          className="inventory-chip"
          aria-pressed={!finish && !duplicatesOnly}
          onClick={() => {
            setFinish("");
            setDuplicatesOnly(false);
            void load({ finish: "", duplicates: false });
          }}
        >
          All cards
        </button>
        <button
          type="button"
          className="inventory-chip"
          aria-pressed={duplicatesOnly}
          onClick={() => {
            setDuplicatesOnly(true);
            void load({ duplicates: true, finish: "" });
            setFinish("");
          }}
        >
          Duplicates
        </button>
        {FINISH_OPTIONS.filter((option) => option.value).map((option) => (
          <button
            key={option.value}
            type="button"
            className="inventory-chip"
            aria-pressed={finish === option.value}
            onClick={() => {
              setFinish(option.value);
              setDuplicatesOnly(false);
              void load({ finish: option.value, duplicates: false });
            }}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          className={cn("inventory-chip", favouriteOnly && "is-active")}
          aria-pressed={favouriteOnly}
          onClick={() => {
            const next = !favouriteOnly;
            setFavouriteOnly(next);
            void load({ favourite: next });
          }}
        >
          <Heart size={13} aria-hidden="true" /> Favourites
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p
          className="font-mono text-[0.62rem] tracking-[0.12em] text-[var(--muted)] uppercase"
          aria-live="polite"
        >
          {loading
            ? "Loading your cards…"
            : failedFilter && failedMode === "replace"
              ? "Filters not applied"
              : visibleLabel}
        </p>
        <p className="font-mono text-[0.58rem] tracking-[0.12em] text-[var(--muted)] uppercase">
          Foil ledger lives on the server
        </p>
      </div>

      {error ? (
        <div className="error-box mt-4" role="alert">
          <p>{error}</p>
          {failedFilter && failedMode === "replace" ? (
            <p className="mt-1 text-sm">
              The selected filters could not be loaded. Try again to see your cards.
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary btn-sm mt-2"
            onClick={() => void load(failedFilter ?? {}, failedMode ?? "replace")}
          >
            Try again
          </button>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div
          className="inventory-grid mt-5 content-start"
          style={{ minHeight: placeholderHeight || undefined }}
          aria-hidden="true"
        >
          {Array.from({ length: placeholderCount }, (_, index) => (
            <div key={index} className="grid gap-2">
              <div className="skeleton aspect-[5/7] w-full" />
              <div className="skeleton h-3 w-2/3" />
              <div className="skeleton h-2 w-1/2" />
            </div>
          ))}
        </div>
      ) : failedFilter && failedMode === "replace" ? null : items.length ? (
        <>
          <div ref={gridRef} className="inventory-grid mt-5">
            {items.map((item, index) => (
              <article key={item.id} className="inventory-card">
                <div className="inventory-card__object">
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
                <div className="inventory-card__body">
                  <div className="inventory-card__title-row">
                    <h3 className="inventory-card__name">{item.card_name}</h3>
                    {item.status === "reserved" ? <span className="badge">Reserved</span> : null}
                  </div>
                  <p className="inventory-card__finish">
                    {printTitle(item.edition_name) ? `${printTitle(item.edition_name)} · ` : ""}
                    {item.variant_name}
                  </p>
                  <p className="inventory-card__serial">{item.serial}</p>
                  <div className="inventory-card__badges">
                    {item.duplicate_count > 1 ? (
                      <span className="badge">Duplicate ×{item.duplicate_count}</span>
                    ) : null}
                    {item.locked ? (
                      <span className="badge">
                        <Lock size={11} aria-hidden="true" /> Locked
                      </span>
                    ) : null}
                    {item.favourite ? <span className="badge">Favourite</span> : null}
                  </div>
                  <div className="inventory-card__actions">
                    <a className="btn btn-secondary btn-sm" href={`/play/card/${item.id}`}>
                      Inspect
                    </a>
                    <button
                      type="button"
                      className={cn("inventory-icon-button", item.favourite && "is-active")}
                      onClick={() => favourite(item)}
                      aria-label={
                        item.favourite
                          ? `Remove ${item.card_name} from favourites`
                          : `Favourite ${item.card_name}`
                      }
                      aria-pressed={Boolean(item.favourite)}
                    >
                      <Heart size={15} fill={item.favourite ? "currentColor" : "none"} />
                    </button>
                    {item.status === "owned" && !item.locked ? (
                      <a
                        className="inventory-icon-button"
                        href="/play/trades#workbench"
                        aria-label={`Trade or gift ${item.card_name}`}
                        title="Trade or gift"
                      >
                        <Handshake size={15} />
                      </a>
                    ) : null}
                  </div>
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
              {hasFilters ? "No cards match this view." : "Your library is empty."}
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
