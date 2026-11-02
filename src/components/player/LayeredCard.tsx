"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
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
}

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
}: LayeredCardProps) {
  const [flipped, setFlipped] = useState(false);
  const ratio = subjectWidth && subjectHeight ? subjectWidth / subjectHeight : 1;
  const shape = subjectWidth && subjectHeight && subjectWidth === subjectHeight ? "medallion" : ratio < 0.75 ? "cutout" : "portrait";
  const materialUrl = `/art/layers/material-${material}.png`;
  const frameUrl = `/art/layers/frame-${material}.png`;
  return (
    <div className={cn("layered-card-shell", classNameOverride)}>
      <div className={cn("layered-card", flipped && "is-flipped")} data-flipped={flipped ? "true" : "false"}>
      {backgroundUrl ? <img className="layered-card__bg" src={backgroundUrl} alt="" aria-hidden="true" /> : null}
      <div className={cn("layered-card__subject-wrap", shape)}>
        <img
          className="layered-card__subject"
          src={subjectUrl}
          alt={`${name} illustration`}
          style={
            shape === "cutout"
              ? { objectFit: "contain", objectPosition: "bottom center", width: "86%", height: "72%", left: "7%", bottom: "12%" }
              : shape === "medallion"
                ? { objectFit: "cover", borderRadius: "50%", width: "64%", height: "auto", aspectRatio: "1", left: "18%", bottom: "21%", border: "2px solid rgba(217,191,139,.8)" }
                : { objectFit: "cover", clipPath: "polygon(0 100%, 0 26%, 22% 0, 78% 0, 100% 26%, 100% 100%)", width: "76%", height: "64%", left: "12%", bottom: "16%" }
          }
        />
      </div>
      <img className="layered-card__texture" src={materialUrl} alt="" aria-hidden="true" />
      <img className="layered-card__frame" src={frameUrl} alt="" aria-hidden="true" />
      {effect && effect !== "none" ? <img className="layered-card__effect" src={`/art/layers/effect-${effect}.png`} alt="" aria-hidden="true" /> : null}
      <div className="layered-card__back" aria-hidden={!flipped}>
        <img className="layered-card__back-image" src={cardBackUrl || "/brand/card-back.webp"} alt="" />
        <div className="layered-card__back-copy">
          {collectionLogo ? <img src={collectionLogo} alt="" className="layered-card__back-logo" /> : null}
          <p className="font-mono text-[0.55rem] uppercase tracking-[0.18em] text-[#d9bf8b]">{collectionName ?? "Foilbury cabinet"}</p>
          <h3>{name}</h3>
          <p>{collectionDescription ?? "A card worth keeping."}</p>
          <p className="font-mono text-[0.55rem] uppercase tracking-[0.14em]">{serial ?? "FOILBURY"}</p>
        </div>
      </div>
      <div className="layered-card__text">
        <p className="font-mono text-[0.55rem] uppercase tracking-[0.16em] text-[#d9bf8b]">{setName ?? "Cabinet"}</p>
        <h3>{name}</h3>
        {subtitle ? <p>{subtitle}</p> : null}
        <div className="layered-card__meta">
          <span>{[characterClass, rarity].filter(Boolean).join(" · ") || material}</span>
          <span>{serial ?? material.toUpperCase()}</span>
        </div>
      </div>
      </div>
      <button type="button" className="layered-card__flip" onClick={() => setFlipped((value) => !value)} aria-label={flipped ? "Show card front" : "Show card back"} aria-pressed={flipped}>
        <RotateCcw size={14} /> {flipped ? "Front" : "Back"}
      </button>
    </div>
  );
}
