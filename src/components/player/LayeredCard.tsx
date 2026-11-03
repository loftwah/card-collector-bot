"use client";

import { useState } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LayeredCardProps {
  subjectUrl: string;
  backgroundUrl: string | null;
  material: string;
  effect: string | null;
  name: string;
  subtitle?: string | null;
  setName?: string | null;
  characterClass?: string | null;
  rarity?: string | null;
  serial?: string | null;
  subjectWidth?: number | null;
  subjectHeight?: number | null;
  classNameOverride?: string;
  cardBackUrl?: string | null;
  collectionName?: string | null;
  collectionLogo?: string | null;
  collectionDescription?: string | null;
  /** The card body becomes a link; controls stay outside it. */
  href?: string;
  /** Optional secondary control, e.g. an inspector. */
  inspectHref?: string;
  /** Hide the toolbar for pure display surfaces. */
  showToolbar?: boolean;
}

/**
 * The single web card composition.
 *
 * Geometry is owned by `.layered-card` (5:7, container-relative type). This
 * component only decides which authored source goes in the art window:
 * square opaque avatars get the one intentional medallion crop, everything
 * else is contained so a tall cutout or a wide scene is never clipped.
 */
export default function LayeredCard({
  subjectUrl,
  backgroundUrl,
  material,
  effect,
  name,
  subtitle,
  setName,
  characterClass,
  rarity,
  serial,
  subjectWidth,
  subjectHeight,
  classNameOverride,
  cardBackUrl,
  collectionName,
  collectionLogo,
  collectionDescription,
  href,
  inspectHref,
  showToolbar = true,
}: LayeredCardProps) {
  const [flipped, setFlipped] = useState(false);
  const medallion = Boolean(subjectWidth && subjectHeight && subjectWidth === subjectHeight);
  const finish = [material, effect && effect !== "none" ? effect : null]
    .filter(Boolean)
    .map((value) => String(value).replace(/^\w/, (letter) => letter.toUpperCase()))
    .join(" · ");

  const faces = (
    <>
      <div className="layered-card__face" data-hidden={flipped ? "true" : "false"} aria-hidden={flipped}>
        <div className="layered-card__art">
          {backgroundUrl ? <img className="layered-card__bg" src={backgroundUrl} alt="" aria-hidden="true" /> : null}
          <img
            className={cn("layered-card__subject", medallion && "layered-card__subject--medallion")}
            src={subjectUrl}
            alt={`${name} illustration`}
            width={750}
            height={1050}
            decoding="async"
          />
        </div>
        <img className="layered-card__texture" src={`/art/layers/material-${material}.png`} alt="" aria-hidden="true" />
        <img className="layered-card__frame" src={`/art/layers/frame-${material}.png`} alt="" aria-hidden="true" />
        {effect && effect !== "none" ? <img className="layered-card__effect" src={`/art/layers/effect-${effect}.png`} alt="" aria-hidden="true" /> : null}
        {finish ? <span className="layered-card__finish">{finish}</span> : null}
        <div className="layered-card__text">
          <h3 title={name}>{name}</h3>
          {subtitle ? <p className="layered-card__subtitle" title={subtitle}>{subtitle}</p> : null}
          <div className="layered-card__meta">
            <span title={[setName, characterClass, rarity].filter(Boolean).join(" · ")}>
              {setName ?? collectionName ?? "Cabinet"}
              {characterClass || rarity ? ` · ${[characterClass, rarity].filter(Boolean).join(" · ")}` : ""}
            </span>
            <span title={serial ?? finish}>{serial ?? finish}</span>
          </div>
        </div>
      </div>

      <div className="layered-card__face layered-card__back" data-hidden={flipped ? "false" : "true"} aria-hidden={!flipped}>
        <img className="layered-card__back-image" src={cardBackUrl || "/brand/card-back.webp"} alt="" />
        <div className="layered-card__back-copy">
          {collectionLogo ? <img src={collectionLogo} alt="" className="layered-card__back-logo" /> : null}
          <p className="font-mono uppercase" style={{ letterSpacing: "0.14em", color: "#d9bf8b", fontSize: "clamp(0.44rem, 2.9cqw, 0.64rem)" }}>
            {collectionName ?? "Foilbury cabinet"}
          </p>
          <h3>{name}</h3>
          <p className="layered-card__back-bio">{collectionDescription ?? subtitle ?? "A card worth keeping."}</p>
          <p className="layered-card__back-serial">{serial ?? "FOILBURY"}</p>
        </div>
      </div>
    </>
  );

  return (
    <div className={cn("layered-card-shell", classNameOverride)}>
      {href ? (
        <a
          href={href}
          className="layered-card block no-underline"
          aria-label={`Inspect ${name}${serial ? `, serial ${serial}` : ""}`}
        >
          {faces}
        </a>
      ) : (
        <div className="layered-card" role="group" aria-label={`${name} card. Front face shown.`}>
          {faces}
        </div>
      )}
      {showToolbar ? (
        <div className="card-toolbar">
          <button
            type="button"
            className="card-toolbar__button"
            onClick={() => setFlipped((value) => !value)}
            aria-label={flipped ? `Show ${name} front` : `Show ${name} back`}
            aria-pressed={flipped}
          >
            <RotateCcw size={13} aria-hidden="true" /> {flipped ? "Front" : "Back"}
          </button>
          {inspectHref ? (
            <a className="card-toolbar__button" href={inspectHref}>
              Inspect <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
