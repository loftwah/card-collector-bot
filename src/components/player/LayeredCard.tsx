"use client";

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
}: LayeredCardProps) {
  const ratio = subjectWidth && subjectHeight ? subjectWidth / subjectHeight : 1;
  const shape = subjectWidth && subjectHeight && subjectWidth === subjectHeight ? "medallion" : ratio < 0.75 ? "cutout" : "portrait";
  const materialUrl = `/art/layers/material-${material}.png`;
  const frameUrl = `/art/layers/frame-${material}.png`;
  return (
    <div className={cn("layered-card", classNameOverride)}>
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
  );
}
