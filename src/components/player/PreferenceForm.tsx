"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

interface CollectionChoice {
  id: string;
  name: string;
  logo_url: string | null;
  banner_url: string | null;
  audience_label: string;
  enabled: boolean;
}

interface SavedPreferences {
  hidden: string[];
  tags: string[];
  motion: boolean;
  sound: boolean;
  sharing: boolean;
}

function fingerprint(value: SavedPreferences) {
  return JSON.stringify({
    hidden: [...value.hidden].sort(),
    tags: [...value.tags].sort(),
    motion: value.motion,
    sound: value.sound,
    sharing: value.sharing,
  });
}

function shareKind(kind: string) {
  if (kind === "achievement") return "Badge";
  if (kind === "collection") return "Collection";
  if (kind === "profile") return "Profile";
  if (kind === "wishlist") return "Wishlist";
  if (kind === "card") return "Card";
  return "Snapshot";
}

function shareStatus(status: string) {
  return status === "active" ? "Active" : status === "revoked" ? "Revoked" : status;
}

export default function PreferenceForm({
  initial,
  tags,
  collections,
}: {
  initial: {
    hidden_collection_ids: string[];
    hide_tags: string[];
    reduced_motion: boolean;
    sound_enabled: boolean;
    sharing_enabled: boolean;
  };
  tags: Array<{ slug: string; name: string }>;
  collections: CollectionChoice[];
}) {
  const [hiddenCollections, setHiddenCollections] = useState(initial.hidden_collection_ids);
  const [hideTags, setHideTags] = useState(initial.hide_tags);
  const [reducedMotion, setReducedMotion] = useState(initial.reduced_motion);
  const [soundEnabled, setSoundEnabled] = useState(initial.sound_enabled);
  const [sharingEnabled, setSharingEnabled] = useState(initial.sharing_enabled);
  const [saved, setSaved] = useState<SavedPreferences>({
    hidden: [...initial.hidden_collection_ids],
    tags: [...initial.hide_tags],
    motion: initial.reduced_motion,
    sound: initial.sound_enabled,
    sharing: initial.sharing_enabled,
  });
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [shareLinks, setShareLinks] = useState<
    Array<{
      id: string;
      kind: string;
      status: string;
      created_at: string;
      expires_at: string;
      preview: Record<string, unknown>;
    }>
  >([]);
  const [sharesBusy, setSharesBusy] = useState("");

  const current: SavedPreferences = {
    hidden: hiddenCollections,
    tags: hideTags,
    motion: reducedMotion,
    sound: soundEnabled,
    sharing: sharingEnabled,
  };
  const dirty = fingerprint(current) !== fingerprint(saved);

  const enabledCollections = collections.filter((collection) => collection.enabled);
  const includedCount = enabledCollections.filter(
    (collection) => !hiddenCollections.includes(collection.id),
  ).length;
  const visibleCollections = query.trim()
    ? collections.filter((collection) =>
        collection.name.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : collections;

  async function loadShares() {
    try {
      const result = await api<{ items: typeof shareLinks }>("/api/v1/shares");
      setShareLinks(result.items);
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  useEffect(() => {
    void loadShares();
  }, []);

  async function revokeShare(id: string) {
    setSharesBusy(id);
    setError("");
    try {
      await api(`/api/v1/shares/${id}/revoke`, { method: "POST", body: {} });
      setMessage("Share revoked. The link stops resolving; already-copied bytes cannot be recalled.");
      await loadShares();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSharesBusy("");
    }
  }

  async function revokeAllShares() {
    setSharesBusy("all");
    setError("");
    try {
      const active = shareLinks.filter((link) => link.status === "active");
      for (const link of active) {
        await api(`/api/v1/shares/${link.id}/revoke`, { method: "POST", body: {} });
      }
      setMessage(`${active.length} active share link${active.length === 1 ? "" : "s"} revoked.`);
      await loadShares();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSharesBusy("");
    }
  }

  function setCollection(id: string, included: boolean) {
    setHiddenCollections((currentHidden) =>
      included
        ? currentHidden.filter((item) => item !== id)
        : [...new Set([...currentHidden, id])],
    );
  }

  function toggleTag(slug: string) {
    setHideTags((currentTags) =>
      currentTags.includes(slug)
        ? currentTags.filter((item) => item !== slug)
        : [...currentTags, slug],
    );
  }

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/v1/me/preferences", {
        method: "PATCH",
        body: {
          hiddenCollectionIds: hiddenCollections,
          hideTags,
          reducedMotion,
          soundEnabled,
          sharingEnabled,
        },
      });
      setSaved({
        hidden: [...hiddenCollections],
        tags: [...hideTags],
        motion: reducedMotion,
        sound: soundEnabled,
        sharing: sharingEnabled,
      });
      setMessage("Preferences saved. New draw previews use these collections straight away.");
      document.documentElement.dataset.motion = reducedMotion ? "reduced" : "full";
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setHiddenCollections([...saved.hidden]);
    setHideTags([...saved.tags]);
    setReducedMotion(saved.motion);
    setSoundEnabled(saved.sound);
    setSharingEnabled(saved.sharing);
    setError("");
    setMessage("Unsaved changes discarded.");
  }

  return (
    <div className="preference-layout">
      <div className="grid gap-5">
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        {message ? <div className="success-box" role="status">{message}</div> : null}

        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">Collections in your capsules</h2>
              <p className="member-panel__note">
                Turn a world off to remove its cards from your future draw odds. Cards you already
                own, serials, history and badges are never removed.
              </p>
            </div>
            <p className="member-count">{includedCount} of {enabledCollections.length} included</p>
          </div>
          <div className="member-panel__pad">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label className="field w-full max-w-sm">
                <span className="label">Find a collection</span>
                <input
                  className="input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Collection name"
                />
              </label>
              {hiddenCollections.length > 0 ? (
                <Button size="sm" variant="secondary" onClick={() => setHiddenCollections([])}>
                  Include every collection
                </Button>
              ) : null}
            </div>

            <div className="preference-worlds mt-4">
              {visibleCollections.map((collection, index) => {
                const included = !hiddenCollections.includes(collection.id);
                const art = collection.banner_url ?? collection.logo_url;
                const isBanner = Boolean(collection.banner_url);
                return (
                  <label key={collection.id} className="preference-world">
                    <span
                      className={[
                        "preference-world__art",
                        isBanner ? "preference-world__art--banner" : "preference-world__art--mark",
                      ].join(" ")}
                    >
                      {art ? (
                        <img
                          src={art}
                          alt=""
                          width={isBanner ? 1600 : 512}
                          height={isBanner ? 900 : 512}
                          loading={index < 8 ? "eager" : "lazy"}
                          decoding="async"
                        />
                      ) : (
                        <span aria-hidden="true" className="preference-world__fallback">
                          {collection.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="preference-world__name">{collection.name}</span>
                      <span className="preference-world__meta">
                        {collection.enabled ? collection.audience_label : "Not dropped in this Bot"}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={collection.enabled && included}
                      disabled={!collection.enabled}
                      onChange={(event) => setCollection(collection.id, event.target.checked)}
                      aria-label={`Include ${collection.name} in future draws`}
                    />
                  </label>
                );
              })}
            </div>

            {visibleCollections.length === 0 ? (
              <p className="mt-4 text-sm text-[var(--muted)]">No collections match that search.</p>
            ) : null}
            {includedCount === 0 && enabledCollections.length > 0 ? (
              <p className="mt-4 text-sm text-[var(--muted)]">
                Every available collection is hidden. The draw room will show an empty distribution
                and will not charge you.
              </p>
            ) : null}
          </div>
        </section>

        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">Optional content filters</h2>
              <p className="member-panel__note">
                Secondary topic filters, separate from collection choice. If a channel already
                excludes a topic, your filter cannot re-enable it.
              </p>
            </div>
          </div>
          <div className="member-panel__pad">
            {tags.length ? (
              <div className="preference-tags">
                {tags.map((tag) => (
                  <label key={tag.slug} className="preference-tag">
                    <input
                      type="checkbox"
                      checked={hideTags.includes(tag.slug)}
                      onChange={() => toggleTag(tag.slug)}
                    />
                    Hide {tag.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                No optional filters are configured for this Bot.
              </p>
            )}
          </div>
        </section>

        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">Motion and sound</h2>
              <p className="member-panel__note">
                These stay under your control even when a profile look includes an effect.
              </p>
            </div>
          </div>
          <div className="member-panel__pad grid gap-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-semibold">Reduce motion</span>
                <span className="block text-xs text-[var(--muted)]">
                  Disables the foil shimmer and reveal drift. Static finishes remain complete.
                </span>
              </span>
              <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} aria-label="Reduce motion" />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-semibold">Sound feedback</span>
                <span className="block text-xs text-[var(--muted)]">
                  Optional short cues. Audio stays silent when no provider is configured.
                </span>
              </span>
              <Switch checked={soundEnabled} onCheckedChange={setSoundEnabled} aria-label="Enable sound" />
            </label>
          </div>
        </section>

        <div className="preference-actions">
          <Button onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
          <Button variant="secondary" onClick={discard} disabled={!dirty || busy}>
            Discard changes
          </Button>
          <span className="preference-dirty" role="status" aria-live="polite">
            {busy ? "Saving" : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
        </div>
      </div>

      <aside className="grid gap-5">
        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">Explicit sharing</h2>
              <p className="member-panel__note">
                This master switch only allows you to create links. Nothing is shared until you
                choose one exact card, collection, badge, wishlist or profile.
              </p>
            </div>
          </div>
          <div className="member-panel__pad">
            <label className="flex items-center justify-between gap-4">
              <span className="text-sm font-semibold">Allow me to create share links</span>
              <Switch
                checked={sharingEnabled}
                onCheckedChange={setSharingEnabled}
                aria-label="Enable share link creation"
              />
            </label>
            <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
              Every link is a snapshot with an expiry. It never silently expands to cards you obtain
              later, and a secret URL never substitutes for membership. Turning this off stops new
              links only; existing active links stay live until they expire or you revoke them under
              Manage shares.
            </p>
          </div>
        </section>

        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">Manage shares</h2>
              <p className="member-panel__note">Each link is a fixed snapshot.</p>
            </div>
            {shareLinks.some((link) => link.status === "active") ? (
              <Button size="sm" variant="ghost" onClick={revokeAllShares} disabled={Boolean(sharesBusy)}>
                {sharesBusy === "all" ? "Revoking…" : "Revoke all active"}
              </Button>
            ) : null}
          </div>
          <div className="member-panel__pad grid gap-2">
            {shareLinks.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No share links have been created.</p>
            ) : (
              shareLinks.map((link) => {
                const label = String(
                  link.preview.card_name ??
                    link.preview.collection_name ??
                    link.preview.achievement_name ??
                    link.preview.display_name ??
                    shareKind(link.kind),
                );
                return (
                  <div key={link.id} className="rounded-[8px] border border-[var(--line)] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{label}</p>
                        <p className="mt-0.5 text-xs text-[var(--muted)]">
                          {shareKind(link.kind)} · {shareStatus(link.status)} · expires{" "}
                          {new Date(link.expires_at).toLocaleDateString("en-AU")}
                        </p>
                      </div>
                      {link.status === "active" ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => revokeShare(link.id)}
                          disabled={Boolean(sharesBusy)}
                        >
                          {sharesBusy === link.id ? "Revoking…" : "Revoke"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              A link is a fixed snapshot. It never silently grows to include cards you obtain later,
              and a secret URL never substitutes for membership on member-only content.
            </p>
          </div>
        </section>

        <section className="member-panel">
          <div className="member-panel__head">
            <div>
              <h2 className="member-panel__title">What changes odds</h2>
              <p className="member-panel__note">
                Your included collections, Bot availability, channel policy and optional content
                filters all shape the eligible distribution.
              </p>
            </div>
          </div>
          <div className="member-panel__pad">
            <p className="text-sm leading-relaxed text-[var(--muted)]">
              The draw room shows the exact conditional probabilities and asks you to review again
              whenever any of them change.
            </p>
            <a className="btn btn-secondary btn-sm mt-3" href="/play/draw">
              Open the draw room
            </a>
          </div>
        </section>
      </aside>
    </div>
  );
}
