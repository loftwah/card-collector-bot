"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { api, describeError } from "@/lib/client";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

export interface ProfileLookOption {
  key: string;
  name: string;
  note: string;
}

export interface ProfilePreviewCard {
  id: string;
  card_name: string;
  render_url: string | null;
  thumbnail_url: string | null;
}

export default function ProfileCustomiser({
  initialLook,
  initialBio,
  looks,
  cards,
}: {
  initialLook: string;
  initialBio: string;
  looks: ProfileLookOption[];
  cards: ProfilePreviewCard[];
}) {
  const [look, setLook] = useState(initialLook);
  const [bio, setBio] = useState(initialBio);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await api("/api/v1/me/preferences", {
        method: "PATCH",
        body: { profileLook: look, profileBio: bio },
      });
      document.querySelector<HTMLElement>(".profile-page")?.setAttribute("data-profile-look", look);
      const bioNode = document.querySelector<HTMLElement>("[data-profile-bio]");
      if (bioNode) bioNode.textContent = bio;
      setSaved("Profile saved. Your next share uses this look and note.");
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const previewCards = cards.length
    ? cards
    : [{ id: "placeholder", card_name: "Your cards", render_url: null, thumbnail_url: null }];

  return (
    <section id="customise" className="profile-section profile-customiser">
      <div className="profile-section__head">
        <div>
          <h2 className="profile-section__title">Customise your profile</h2>
        </div>
        <span className="badge">Saved to this Bot</span>
      </div>
      <p className="profile-section__lede">
        Choose a composition and write a short collector note. The look changes the featured
        specimen and shelf on this page; the note appears here and in your next profile share.
      </p>

      <fieldset className="profile-look-picker">
        <legend className="sr-only">Choose a profile look</legend>
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
              onChange={() => setLook(option.key)}
            />
            <span className="profile-look__preview" aria-hidden="true">
              {Array.from({ length: 4 }).map((_, index) => {
                const card = previewCards[index];
                return (
                  <span className="profile-look__card" data-slot={index + 1}>
                    {card?.render_url ? (
                      <img src={card.thumbnail_url ?? card.render_url} alt="" loading="lazy" />
                    ) : (
                      <span className="profile-look__placeholder" />
                    )}
                  </span>
                );
              })}
            </span>
            <span className="profile-look__body">
              <span className="profile-look__name">
                {option.name}
                {look === option.key ? <Check size={13} aria-hidden="true" /> : null}
              </span>
              <span className="profile-look__note">{option.note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="field profile-bio-field">
        <span className="label">Collector note</span>
        <textarea
          className="textarea"
          maxLength={160}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          placeholder="A short note about what you collect."
        />
        <span className="profile-bio-count">{bio.length}/160</span>
      </label>

      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      {saved ? (
        <div className="success-box" role="status">
          {saved}
        </div>
      ) : null}

      <div className="profile-customiser__actions">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Saving…
            </>
          ) : (
            "Save profile"
          )}
        </Button>
        <p>No inventory, serial or badge changes. The note is plain text.</p>
      </div>
    </section>
  );
}
