"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, Loader2, RotateCcw, Save, X } from "lucide-react";
import { ApiClientError, api, describeError } from "@/lib/client";
import { cn } from "@/lib/utils";
import {
  PROFILE_AVATAR_DECORATIONS,
  PROFILE_AVATAR_DECORATION_LABELS,
  PROFILE_EFFECTS,
  PROFILE_EFFECT_LABELS,
  PROFILE_FRAMES,
  PROFILE_FRAME_LABELS,
  PROFILE_NAME_TREATMENTS,
  PROFILE_NAME_TREATMENT_LABELS,
  type ProfilePresentationSelection,
} from "@/lib/profile-presentation";
import type {
  ProfileCopyView,
  ProfilePresentationOptions,
  ResolvedProfilePresentation,
} from "@/server/modules/profile-presentation";
import { Button } from "../ui/button";

export interface ProfileLookOption {
  key: string;
  name: string;
  note: string;
}

interface PreferencesResponse {
  profile_look: string;
  profile_bio: string;
  profile_presentation: ProfilePresentationSelection;
  profile_presentation_version: number;
}

function collectionFor(options: ProfilePresentationOptions, key: string) {
  if (!key.startsWith("collection:")) return null;
  const id = key.slice("collection:".length);
  return options.collections.find((collection) => collection.id === id) ?? null;
}

function selectedCopies(options: ProfilePresentationOptions, ids: string[]): ProfileCopyView[] {
  const favourites = options.copies.filter((copy) => copy.favourite);
  if (!ids.length) return favourites.slice(0, 8);
  const byId = new Map(favourites.map((copy) => [copy.id, copy]));
  return ids.map((id) => byId.get(id)).filter((copy): copy is ProfileCopyView => Boolean(copy)).slice(0, 8);
}

function selectedBadges(options: ProfilePresentationOptions, ids: string[]) {
  if (!ids.length) return options.badges.slice(0, 6);
  const byId = new Map(options.badges.map((badge) => [badge.id, badge]));
  return ids.map((id) => byId.get(id)).filter((badge): badge is ProfilePresentationOptions["badges"][number] => Boolean(badge)).slice(0, 6);
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = [...items];
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

function ProfilePreview({
  draft,
  look,
  bio,
  options,
  mode,
}: {
  draft: ProfilePresentationSelection;
  look: string;
  bio: string;
  options: ProfilePresentationOptions;
  mode: "compact" | "full";
}) {
  const portrait = collectionFor(options, draft.portrait);
  const banner = collectionFor(options, draft.banner);
  const featured =
    options.copies.find((copy) => copy.id === draft.featuredInstanceId) ??
    options.copies.find((copy) => copy.favourite) ??
    options.copies[0] ??
    null;
  const favourites = selectedCopies(options, draft.favouriteInstanceIds).filter((copy) => copy.id !== featured?.id);
  const badges = selectedBadges(options, draft.badgeIds);
  const bannerUrl = banner?.bannerUrl ?? banner?.coverUrl ?? null;
  const initials = "You";

  return (
    <div
      className={cn("profile-preview", mode === "compact" && "profile-preview--compact")}
      data-profile-look={look}
      data-profile-frame={draft.frame}
      data-avatar-decoration={draft.avatarDecoration}
      data-name-treatment={draft.nameTreatment}
      data-profile-effect={draft.effect}
      aria-label="Live profile preview"
    >
      <div className="profile-preview__hero">
        {bannerUrl ? <img className="profile-preview__banner" src={bannerUrl} alt="" aria-hidden="true" /> : null}
        <div className="profile-preview__identity">
          {portrait?.logoUrl ? (
            <span className="profile-avatar profile-avatar--image" aria-hidden="true">
              <img src={portrait.logoUrl} alt="" width="48" height="48" />
            </span>
          ) : (
            <span className="profile-avatar" aria-hidden="true">
              {initials}
            </span>
          )}
          <div className="min-w-0">
            <p className="profile-preview__name">Your collector name</p>
            <p className="profile-preview__meta">
              {look} · {featured ? "featured copy" : "no featured copy"}
            </p>
          </div>
        </div>
        {bio ? <p className="profile-preview__bio">{bio}</p> : null}
      </div>

      <div className="profile-preview__feature">
        {featured ? (
          <>
            <div className="profile-preview__card">
              {featured.renderUrl ? (
                <img src={featured.renderUrl} alt={`${featured.cardName} preview`} width="300" height="420" />
              ) : (
                <span className="card-face-fallback">{featured.cardName.charAt(0)}</span>
              )}
            </div>
            <div className="profile-preview__copy">
              <p className="profile-preview__card-name">{featured.cardName}</p>
              <p className="profile-preview__card-meta">
                {featured.variantName} · {featured.finish}
              </p>
              <p className="profile-preview__serial">{featured.serial}</p>
              <span className="badge badge-signal">Exact owned copy</span>
            </div>
          </>
        ) : (
          <p className="profile-preview__empty">Choose an owned copy to feature here.</p>
        )}
      </div>

      {mode === "full" ? (
        <>
          <div className="profile-preview__shelf" aria-label="Favourite shelf">
            {favourites.length ? (
              favourites.slice(0, 4).map((copy) => (
                <div className="profile-preview__shelf-card" key={copy.id}>
                  {copy.thumbnailUrl ?? copy.renderUrl ? (
                    <img src={copy.thumbnailUrl ?? copy.renderUrl ?? ""} alt="" width="120" height="168" loading="lazy" />
                  ) : (
                    <span className="card-face-fallback">{copy.cardName.charAt(0)}</span>
                  )}
                  <p>{copy.cardName}</p>
                  <span>{copy.finish}</span>
                </div>
              ))
            ) : (
              <p className="profile-preview__empty">Favourite cards appear on your shelf.</p>
            )}
          </div>
          {badges.length ? (
            <div className="profile-preview__badges" aria-label="Selected badges">
              {badges.map((badge) => (
                <span className="badge" key={badge.id}>
                  {badge.name}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function ProfileCustomiser({
  initialLook,
  initialBio,
  looks,
  presentation,
  options,
}: {
  initialLook: string;
  initialBio: string;
  looks: ProfileLookOption[];
  presentation: ResolvedProfilePresentation;
  options: ProfilePresentationOptions;
}) {
  const savedBase = useMemo(
    () => ({ look: initialLook, bio: initialBio, selection: presentation.selection, version: presentation.version }),
    [initialLook, initialBio, presentation.selection, presentation.version],
  );
  const [look, setLook] = useState(initialLook);
  const [bio, setBio] = useState(initialBio);
  const [draft, setDraft] = useState<ProfilePresentationSelection>(presentation.selection);
  const [saved, setSaved] = useState(savedBase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [previewMode, setPreviewMode] = useState<"compact" | "full">("full");

  const portraitOptions = options.collections.filter((collection) => Boolean(collection.logoUrl));
  const bannerOptions = options.collections.filter((collection) => Boolean(collection.bannerUrl ?? collection.coverUrl));
  const favouriteCopies = options.copies.filter((copy) => copy.favourite);
  const currentFavourites = selectedCopies(options, draft.favouriteInstanceIds);
  const currentBadges = selectedBadges(options, draft.badgeIds);
  const dirty =
    look !== saved.look ||
    bio !== saved.bio ||
    JSON.stringify(draft) !== JSON.stringify(saved.selection);
  const remainingFavourites = favouriteCopies.filter((copy) => !currentFavourites.some((item) => item.id === copy.id));
  const remainingBadges = options.badges.filter((badge) => !currentBadges.some((item) => item.id === badge.id));

  function update<K extends keyof ProfilePresentationSelection>(key: K, value: ProfilePresentationSelection[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  }

  function reset() {
    setLook(saved.look);
    setBio(saved.bio);
    setDraft(saved.selection);
    setError("");
    setStale(false);
    setNotice("Changes discarded. Your last saved composition is shown.");
  }

  async function loadLatest() {
    setBusy(true);
    setError("");
    try {
      const latest = await api<PreferencesResponse>("/api/v1/me/preferences");
      setSaved({
        look: latest.profile_look,
        bio: latest.profile_bio,
        selection: latest.profile_presentation,
        version: latest.profile_presentation_version,
      });
      setStale(false);
      setNotice("Loaded the latest saved profile. Your unsaved edits are still here; save them to apply.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<PreferencesResponse>("/api/v1/me/preferences", {
        method: "PATCH",
        body: {
          profileLook: look,
          profileBio: bio.trim(),
          profilePresentation: draft,
          profilePresentationVersion: saved.version,
        },
      });
      const nextSelection = result.profile_presentation ?? draft;
      setSaved({
        look: result.profile_look ?? look,
        bio: result.profile_bio ?? bio.trim(),
        selection: nextSelection,
        version: result.profile_presentation_version ?? saved.version + 1,
      });
      setDraft(nextSelection);
      setBio(result.profile_bio ?? bio.trim());
      setLook(result.profile_look ?? look);
      setStale(false);
      setNotice("Profile saved. The composition, featured copy and shelf order are now live.");
      const page = document.querySelector<HTMLElement>(".profile-page");
      if (page) {
        page.dataset.profileLook = result.profile_look ?? look;
        page.dataset.profileFrame = nextSelection.frame;
        page.dataset.avatarDecoration = nextSelection.avatarDecoration;
        page.dataset.nameTreatment = nextSelection.nameTreatment;
        page.dataset.profileEffect = nextSelection.effect;
      }
      const bioNode = document.querySelector<HTMLElement>("[data-profile-bio]");
      if (bioNode) bioNode.textContent = result.profile_bio ?? bio.trim();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === "profile_presentation_stale") {
        setStale(true);
        const details = cause.details as
          | { current_version?: number; current_presentation?: ProfilePresentationSelection }
          | undefined;
        if (details?.current_presentation) {
          setSaved((current) => ({
            ...current,
            selection: details.current_presentation!,
            version: details.current_version ?? current.version,
          }));
        }
      }
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="customise" className="profile-section profile-customiser">
      <div className="profile-section__head">
        <div>
          <h2 className="profile-section__title">Customise your profile</h2>
          <p className="profile-section__lede">
            Mix independent pieces, choose the exact copy you want to feature and arrange the shelf.
            Preview stays local until you save.
          </p>
        </div>
        <span className="badge">Saved to this Bot</span>
      </div>

      {error ? (
        <div className="error-box" role="alert">
          <p>{error}</p>
          {stale ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={loadLatest} disabled={busy}>
                Load latest saved profile
              </Button>
              <span className="text-sm">Your edits remain in the editor.</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <div className="success-box" role="status">
          {notice}
        </div>
      ) : null}

      <div className="profile-customiser__layout">
        <div className="profile-customiser__controls">
          <fieldset className="profile-customiser__group">
            <legend>Starter look</legend>
            <div className="profile-look-picker">
              {looks.map((option) => (
                <label
                  key={option.key}
                  className={cn("profile-look profile-look-choice", look === option.key && "is-selected")}
                  data-look={option.key}
                  data-selected={look === option.key}
                >
                  <input
                    type="radio"
                    name="profile-look"
                    value={option.key}
                    checked={look === option.key}
                    onChange={() => {
                      setLook(option.key);
                      setNotice("");
                      setError("");
                    }}
                  />
                  <span className="profile-look__name">{option.name}</span>
                  <span className="profile-look__note">{option.note}</span>
                  {look === option.key ? <Check size={14} aria-hidden="true" /> : null}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Portrait</legend>
            <label className="field">
              <span>Portrait artwork</span>
              <select value={draft.portrait} onChange={(event) => update("portrait", event.target.value)}>
                <option value="monogram">Monogram</option>
                {portraitOptions.map((collection) => (
                  <option key={collection.id} value={`collection:${collection.id}`}>
                    {collection.name} mark
                  </option>
                ))}
              </select>
            </label>
            <p className="profile-customiser__hint">
              A collection mark shows affinity. It does not claim ownership of a card or collection.
            </p>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Banner</legend>
            <label className="field">
              <span>Banner artwork</span>
              <select value={draft.banner} onChange={(event) => update("banner", event.target.value)}>
                <option value="none">No banner</option>
                {bannerOptions.map((collection) => (
                  <option key={collection.id} value={`collection:${collection.id}`}>
                    {collection.name}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Frame</legend>
            <div className="profile-option-row">
              {PROFILE_FRAMES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="profile-option"
                  data-selected={draft.frame === value}
                  aria-pressed={draft.frame === value}
                  onClick={() => update("frame", value)}
                >
                  {PROFILE_FRAME_LABELS[value]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Avatar decoration</legend>
            <div className="profile-option-row">
              {PROFILE_AVATAR_DECORATIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="profile-option"
                  data-selected={draft.avatarDecoration === value}
                  aria-pressed={draft.avatarDecoration === value}
                  onClick={() => update("avatarDecoration", value)}
                >
                  {PROFILE_AVATAR_DECORATION_LABELS[value]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Name treatment</legend>
            <div className="profile-option-row">
              {PROFILE_NAME_TREATMENTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="profile-option"
                  data-selected={draft.nameTreatment === value}
                  aria-pressed={draft.nameTreatment === value}
                  onClick={() => update("nameTreatment", value)}
                >
                  {PROFILE_NAME_TREATMENT_LABELS[value]}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Optional effect</legend>
            <div className="profile-option-row">
              {PROFILE_EFFECTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="profile-option"
                  data-selected={draft.effect === value}
                  aria-pressed={draft.effect === value}
                  onClick={() => update("effect", value)}
                >
                  {PROFILE_EFFECT_LABELS[value]}
                </button>
              ))}
            </div>
            <p className="profile-customiser__hint">
              Effects are static and never required to read the card, name or badges.
            </p>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Featured copy</legend>
            <label className="field">
              <span>Exact owned copy</span>
              <select
                value={draft.featuredInstanceId ?? ""}
                onChange={(event) => update("featuredInstanceId", event.target.value || null)}
              >
                <option value="">No featured copy</option>
                {options.copies.map((copy) => (
                  <option key={copy.id} value={copy.id}>
                    {copy.cardName} · {copy.finish} · {copy.serial}
                  </option>
                ))}
              </select>
            </label>
            <p className="profile-customiser__hint">
              The featured copy must be owned. Choosing it never moves, mints or changes the card.
            </p>
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Favourite shelf order</legend>
            {currentFavourites.length ? (
              <ol className="profile-order-list">
                {currentFavourites.map((copy, index) => (
                  <li key={copy.id}>
                    <span className="min-w-0">
                      <strong>{copy.cardName}</strong>
                      <small>
                        {copy.finish} · {copy.serial}
                      </small>
                    </span>
                    <span className="profile-order-list__actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${copy.cardName} up`}
                        onClick={() => update("favouriteInstanceIds", move(currentFavourites, index, -1).map((item) => item.id))}
                        disabled={index === 0}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${copy.cardName} down`}
                        onClick={() => update("favouriteInstanceIds", move(currentFavourites, index, 1).map((item) => item.id))}
                        disabled={index === currentFavourites.length - 1}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${copy.cardName} from the shelf`}
                        onClick={() =>
                          update(
                            "favouriteInstanceIds",
                            currentFavourites.filter((item) => item.id !== copy.id).map((item) => item.id),
                          )
                        }
                        disabled={currentFavourites.length <= 1}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-customiser__hint">
                Favourite cards in your collection first; they become the shelf you can reorder here.
              </p>
            )}
            {remainingFavourites.length ? (
              <label className="field">
                <span>Add a favourite</span>
                <select
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return;
                    update("favouriteInstanceIds", [...currentFavourites.map((item) => item.id), event.target.value]);
                  }}
                >
                  <option value="">Choose a favourite</option>
                  {remainingFavourites.map((copy) => (
                    <option key={copy.id} value={copy.id}>
                      {copy.cardName} · {copy.finish}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>

          <fieldset className="profile-customiser__group">
            <legend>Badge order</legend>
            {currentBadges.length ? (
              <ol className="profile-order-list">
                {currentBadges.map((badge, index) => (
                  <li key={badge.id}>
                    <span className="min-w-0">
                      <strong>{badge.name}</strong>
                      <small>{badge.category} · earned</small>
                    </span>
                    <span className="profile-order-list__actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${badge.name} up`}
                        onClick={() => update("badgeIds", move(currentBadges, index, -1).map((item) => item.id))}
                        disabled={index === 0}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move ${badge.name} down`}
                        onClick={() => update("badgeIds", move(currentBadges, index, 1).map((item) => item.id))}
                        disabled={index === currentBadges.length - 1}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${badge.name} from the profile`}
                        onClick={() =>
                          update(
                            "badgeIds",
                            currentBadges.filter((item) => item.id !== badge.id).map((item) => item.id),
                          )
                        }
                        disabled={currentBadges.length <= 1}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-customiser__hint">
                Earn a badge and it becomes available here. Only earned badges can be selected.
              </p>
            )}
            {remainingBadges.length ? (
              <label className="field">
                <span>Add a badge</span>
                <select
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return;
                    update("badgeIds", [...currentBadges.map((item) => item.id), event.target.value]);
                  }}
                >
                  <option value="">Choose an earned badge</option>
                  {remainingBadges.map((badge) => (
                    <option key={badge.id} value={badge.id}>
                      {badge.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </fieldset>

          <label className="field profile-customiser__note">
            <span>Collector note</span>
            <textarea
              value={bio}
              maxLength={160}
              rows={3}
              onChange={(event) => {
                setBio(event.target.value);
                setError("");
                setNotice("");
              }}
            />
            <small>{160 - bio.length} characters left</small>
          </label>
        </div>

        <aside className="profile-customiser__preview" aria-label="Profile preview">
          <div className="profile-customiser__preview-head">
            <h3>Live preview</h3>
            <div className="profile-option-row" role="group" aria-label="Preview size">
              <button
                type="button"
                className="profile-option"
                data-selected={previewMode === "compact"}
                aria-pressed={previewMode === "compact"}
                onClick={() => setPreviewMode("compact")}
              >
                Compact
              </button>
              <button
                type="button"
                className="profile-option"
                data-selected={previewMode === "full"}
                aria-pressed={previewMode === "full"}
                onClick={() => setPreviewMode("full")}
              >
                Full
              </button>
            </div>
          </div>
          <ProfilePreview draft={draft} look={look} bio={bio} options={options} mode={previewMode} />
          <p className="profile-customiser__hint">
            This preview uses your real name, saved artwork and owned copies. Nothing changes until you save.
          </p>
        </aside>
      </div>

      <div className="profile-customiser__footer">
        <p className="profile-customiser__state" role="status">
          {dirty ? "Unsaved changes" : "All changes saved"}
        </p>
        <div className="profile-customiser__actions">
          <Button type="button" variant="secondary" onClick={reset} disabled={busy || !dirty}>
            <RotateCcw size={15} aria-hidden="true" /> Discard changes
          </Button>
          <Button type="button" onClick={save} disabled={busy || !dirty}>
            {busy ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            {busy ? "Saving" : "Save profile"}
          </Button>
        </div>
      </div>
    </section>
  );
}
