"use client";

import { useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

interface CollectionChoice {
  id: string;
  name: string;
  cover_url: string | null;
  audience_label: string;
  enabled: boolean;
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function setCollection(id: string, included: boolean) {
    setHiddenCollections((current) => (included ? current.filter((item) => item !== id) : [...new Set([...current, id])]));
  }

  function toggleTag(slug: string) {
    setHideTags((current) => (current.includes(slug) ? current.filter((item) => item !== slug) : [...current, slug]));
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
      setMessage("Preferences saved. New draw previews use these collections straight away.");
      document.documentElement.dataset.motion = reducedMotion ? "reduced" : "full";
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const includedCount = collections.filter((item) => !hiddenCollections.includes(item.id)).length;

  return (
    <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
      <div className="grid gap-6">
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        {message ? <div className="success-box" role="status">{message}</div> : null}

        <section className="surface-flat p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Future draws</p>
              <h3 className="display-sm mt-1 text-2xl">Collections in your capsules</h3>
            </div>
            <span className="badge">{includedCount} of {collections.length} included</span>
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Turn a world off to remove its cards from your future draw odds. Cards you already own, serials, history and badges are never removed. This is your personal choice; it does not change the Bot for anyone else.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {collections.map((collection) => {
              const included = !hiddenCollections.includes(collection.id);
              return (
                <article key={collection.id} className="preference-world">
                  <div className="preference-world__art">
                    {collection.cover_url ? (
                      <img src={collection.cover_url} alt="" width="96" height="134" loading="lazy" />
                    ) : (
                      <span aria-hidden="true" className="preference-world__fallback">{collection.name.slice(0, 2).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{collection.name}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {collection.enabled ? collection.audience_label : "Not dropped in this Bot"}
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={!collection.enabled}
                        onChange={(event) => setCollection(collection.id, event.target.checked)}
                        className="h-4 w-4 accent-[var(--green)]"
                      />
                      {collection.enabled ? (included ? "Included in my draws" : "Off for my draws") : "Unavailable here"}
                    </label>
                  </div>
                </article>
              );
            })}
            {collections.length === 0 ? <p className="text-sm text-[var(--muted)]">No published collections are available in this Bot yet.</p> : null}
          </div>
          {hiddenCollections.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-3">
              <p className="text-xs text-[var(--muted)]">Every world in a capsule hidden? The draw room will show an empty distribution and will not charge you.</p>
              <Button size="sm" variant="ghost" onClick={() => setHiddenCollections([])}>Include every collection</Button>
            </div>
          ) : null}
        </section>

        <section className="surface-flat p-5">
          <p className="eyebrow">Optional content filters</p>
          <p className="mt-2 text-sm text-[var(--muted)]">These are secondary topic filters, separate from collection choice. If a channel already excludes a topic, your filter cannot re-enable it. Leave everything unchecked to use the full eligible pool.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {tags.map((tag) => (
              <label key={tag.slug} className="flex items-center gap-2 border border-[var(--line)] px-3 py-2 text-sm">
                <input type="checkbox" checked={hideTags.includes(tag.slug)} onChange={() => toggleTag(tag.slug)} className="accent-[var(--green)]" />
                Hide {tag.name}
              </label>
            ))}
          </div>
        </section>

        <section className="surface-flat p-5">
          <p className="eyebrow">Motion and sound</p>
          <div className="mt-4 grid gap-4">
            <label className="flex items-center justify-between gap-4">
              <span><span className="block text-sm font-semibold">Reduce motion</span><span className="text-xs text-[var(--muted)]">Disables the foil shimmer and reveal drift. Static finishes remain complete.</span></span>
              <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} aria-label="Reduce motion" />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span><span className="block text-sm font-semibold">Sound feedback</span><span className="text-xs text-[var(--muted)]">Optional short cues. Audio stays silent when no provider is configured.</span></span>
              <Switch checked={soundEnabled} onCheckedChange={setSoundEnabled} aria-label="Enable sound" />
            </label>
          </div>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save preferences"}</Button>
          <a className="btn btn-secondary" href="/play">Back to overview</a>
        </div>
      </div>

      <aside className="grid gap-5">
        <section className="surface-flat p-5">
          <p className="eyebrow">Explicit sharing</p>
          <p className="mt-2 text-sm text-[var(--muted)]">This master switch only allows you to create links. Nothing is shared until you choose one exact card, collection or badge, preview it, and confirm. Turning it off does not revoke existing links; manage those from your showcase.</p>
          <label className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Allow me to create share links</span>
            <Switch checked={sharingEnabled} onCheckedChange={setSharingEnabled} aria-label="Enable share link creation" />
          </label>
          <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">Every link is a snapshot with an expiry. It never silently expands to cards you obtain later, and a secret URL never substitutes for membership.</p>
        </section>
        <section className="border border-[var(--line)] p-5">
          <p className="eyebrow">What changes odds</p>
          <p className="mt-2 text-sm text-[var(--muted)]">Your included collections, Bot availability, channel policy and your optional content filters all shape the eligible distribution. The draw room shows the exact conditional probabilities and asks you to review again whenever any of them change.</p>
        </section>
      </aside>
    </div>
  );
}
