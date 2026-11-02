"use client";

import { useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export default function PreferenceForm({
  initial,
  tags,
}: {
  initial: { hide_tags: string[]; reduced_motion: boolean; sound_enabled: boolean; sharing_enabled: boolean };
  tags: Array<{ slug: string; name: string }>;
}) {
  const [hideTags, setHideTags] = useState(initial.hide_tags);
  const [reducedMotion, setReducedMotion] = useState(initial.reduced_motion);
  const [soundEnabled, setSoundEnabled] = useState(initial.sound_enabled);
  const [sharingEnabled, setSharingEnabled] = useState(initial.sharing_enabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [shareUrl, setShareUrl] = useState("");

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
        body: { hideTags, reducedMotion, soundEnabled, sharingEnabled },
      });
      setMessage("Preferences saved. Topic restrictions still apply on top of your choices.");
      document.documentElement.dataset.motion = reducedMotion ? "reduced" : "full";
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createShare() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ url: string }>("/api/v1/shares", { method: "POST", body: { expiresInDays: 7 } });
      setShareUrl(result.url);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
      <div className="grid gap-6">
        {error ? <div className="error-box" role="alert">{error}</div> : null}
        {message ? <div className="success-box" role="status">{message}</div> : null}
        <section className="surface-flat p-5">
          <p className="eyebrow">Motion and sound</p>
          <div className="mt-4 grid gap-4">
            <label className="flex items-center justify-between gap-4">
              <span><span className="block text-sm font-semibold">Reduce motion</span><span className="text-xs text-[var(--muted)]">Disables the foil shimmer and reveal drift. Static finishes remain complete.</span></span>
              <Switch checked={reducedMotion} onCheckedChange={setReducedMotion} aria-label="Reduce motion" />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span><span className="block text-sm font-semibold">Sound feedback</span><span className="text-xs text-[var(--muted)]">Optional short cues. Audio is unavailable rather than blocking if no provider is configured.</span></span>
              <Switch checked={soundEnabled} onCheckedChange={setSoundEnabled} aria-label="Enable sound" />
            </label>
          </div>
        </section>

        <section className="surface-flat p-5">
          <p className="eyebrow">Preferences can narrow, never widen</p>
          <p className="mt-2 text-sm text-[var(--muted)]">Hide topics you do not want to see in future draws. If a public channel already excludes a topic, your preferences cannot re-enable it.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {tags.map((tag) => (
              <label key={tag.slug} className="flex items-center gap-2 border border-[var(--line)] px-3 py-2 text-sm">
                <input type="checkbox" checked={hideTags.includes(tag.slug)} onChange={() => toggleTag(tag.slug)} className="accent-[var(--green)]" />
                {tag.name}
              </label>
            ))}
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
          <p className="mt-2 text-sm text-[var(--muted)]">Sharing is off by default. When enabled, a share link shows only the public renders you explicitly exported; it does not expose your private source assets or raw library.</p>
          <label className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm font-semibold">Allow share links</span>
            <Switch checked={sharingEnabled} onCheckedChange={setSharingEnabled} aria-label="Enable sharing" />
          </label>
          <div className="mt-4">
            <Button size="sm" variant="secondary" onClick={createShare} disabled={!sharingEnabled || busy}>Create 7 day link</Button>
          </div>
          {shareUrl ? <p className="mt-3 break-all font-mono text-xs text-[var(--green)]">{shareUrl}</p> : null}
        </section>
        <section className="border border-[var(--line)] p-5">
          <p className="eyebrow">Accessibility</p>
          <p className="mt-2 text-sm text-[var(--muted)]">The cabinet supports light and dark presentation, keyboard navigation, visible focus and reduced motion. Rarity is always labelled, never conveyed by colour alone.</p>
        </section>
      </aside>
    </div>
  );
}
