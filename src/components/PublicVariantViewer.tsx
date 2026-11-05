"use client";

import { useState } from "react";
import { Box, RotateCcw, Sparkles } from "lucide-react";
import { displayFinish, printTitle as editionPrintTitle } from "@/lib/utils";
import CardInspector from "./player/CardInspector";
import { cn } from "@/lib/utils";

interface Variant {
  id: string;
  name: string;
  edition_name?: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
  back_render_url: string | null;
}

function printTitleOf(variant?: Variant): string | null {
  return editionPrintTitle(variant?.edition_name);
}

export default function PublicVariantViewer({
  name,
  subtitle,
  description,
  bio,
  quote,
  rarity,
  setName,
  tags,
  variants,
  collection,
  cardBackUrl,
  attributes = [],
  sourceWork,
  sourceRefs = [],
  reviewStatus,
}: {
  name: string;
  subtitle: string | null;
  description: string;
  bio?: string | null;
  quote?: string | null;
  rarity: string | null;
  setName: string | null;
  tags: string[];
  variants: Variant[];
  collection?: { name: string; logo_url: string | null; description: string } | null;
  cardBackUrl?: string | null;
  attributes?: Array<{ label?: string; value?: string; unit?: string | null }>;
  sourceWork?: string | null;
  sourceRefs?: string[];
  reviewStatus?: string;
}) {
  const [selected, setSelected] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [inspect, setInspect] = useState(false);
  const variant = variants[selected] ?? variants[0];
  const printTitle = printTitleOf(variant);
  const multiplePrints = new Set(variants.map((item) => item.edition_name).filter(Boolean)).size > 1;
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
      <div className="min-w-0">
        {inspect ? (
          <CardInspector
            frontUrl={variant?.render_url ?? null}
            backUrl={variant?.back_render_url ?? null}
            fallbackUrl={cardBackUrl}
            name={name}
            subtitle={subtitle}
            finish={displayFinish(variant?.name, variant?.material_key, variant?.effect_key)}
            collection={collection?.name ?? null}
            initialEnabled
            initialFlipped={showBack}
            framed
          />
        ) : (
        <div className="card-rail p-3">
          <div className="card-face">
            {showBack ? (
              <div className="relative h-full w-full bg-[var(--ink)]">
                <img src={variant?.back_render_url ?? cardBackUrl ?? "/brand/card-back.webp"} alt={`Back of ${name}`} className="h-full w-full object-cover" />
                {!variant?.back_render_url ? (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#141512] via-[#141512]/80 to-transparent p-5 text-[#f4f0e6]">
                    {collection?.logo_url ? <img src={collection.logo_url} alt="" className="mb-2 h-10 w-10 object-contain" /> : null}
                    <p className="font-mono text-[0.56rem] uppercase tracking-[0.14em] text-[#d9bf8b]">{collection?.name ?? "Foilbury cabinet"}</p>
                    <p className="mt-1 font-display text-2xl leading-tight">{name}</p>
                  </div>
                ) : null}
              </div>
            ) : variant?.render_url ? <img src={variant.render_url} alt={`${name} card in ${variant.name} finish`} /> : <div className="card-face-fallback">{name.charAt(0)}</div>}
          </div>
        </div>
        )}
        {inspect ? null : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-[var(--muted)]">{showBack ? `Card back${printTitle ? ` · ${printTitle}` : ""}` : `Published render · ${printTitle ? `${printTitle} · ` : ""}${variant?.name ?? "Awaiting render"}`}</p><div className="flex flex-wrap gap-1"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowBack((value) => !value)}><RotateCcw size={13} /> {showBack ? "Show front" : "Show back"}</button><button type="button" className="btn btn-secondary btn-sm" onClick={() => setInspect(true)}><Box size={13} /> Inspect in 3D</button></div></div>
        )}
      </div>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center gap-2">
          {rarity ? <span className="badge badge-rare">{rarity}</span> : null}
          {setName ? <span className="badge">{setName}</span> : null}
          {tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
        </div>
        <h1 className="display mt-5 text-[clamp(2.8rem,7vw,5.5rem)]">{name}</h1>
        {printTitle ? (
          <p className="mt-2 text-lg text-[var(--brass)]">Print · {printTitle}</p>
        ) : subtitle ? (
          <p className="mt-2 text-lg text-[var(--brass)]">{subtitle}</p>
        ) : null}
        <p className="prose mt-6 text-[var(--muted)]">{bio || description}</p>
        {quote ? <blockquote className="mt-5 border-l-2 border-[var(--brass)] pl-4 font-display text-2xl leading-snug text-[var(--ink)]">“{quote}”</blockquote> : null}

        {attributes.length ? (
          <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-[var(--line)] pt-5 text-sm">
            {attributes.slice(0, 6).map((attribute) => (
              <div key={`${attribute.label}-${attribute.value}`}>
                <dt className="font-mono text-[0.56rem] uppercase tracking-[0.12em] text-[var(--muted)]">{attribute.label}</dt>
                <dd className="mt-1">{attribute.value}{attribute.unit ? ` ${attribute.unit}` : ""}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <div className="mt-5 grid gap-2 border-t border-[var(--line)] pt-4 text-sm text-[var(--muted)]">
          {sourceWork ? <p><span className="font-mono text-[0.56rem] uppercase tracking-[0.12em]">Source</span> · {sourceWork}</p> : null}
          <p><span className="font-mono text-[0.56rem] uppercase tracking-[0.12em]">Review</span> · {reviewStatus ?? "unreviewed"}</p>
          {sourceRefs.length ? <p className="break-words"><span className="font-mono text-[0.56rem] uppercase tracking-[0.12em]">References</span> · {sourceRefs.length} retained source {sourceRefs.length === 1 ? "link" : "links"} in the editorial record.</p> : null}
        </div>

        <div className="mt-8">
          <p className="eyebrow mb-3">Published finishes</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {variants.map((item, index) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setSelected(index)}
                aria-pressed={index === selected}
                className={cn(
                  "border px-3 py-2 text-left transition-colors",
                  index === selected
                    ? "surface-selected border-ink"
                    : "border-[var(--line)] text-[var(--muted)] hover:border-[var(--brass)] hover:text-[var(--ink)]",
                )}
              >
                <span className="block font-mono text-[0.58rem] uppercase tracking-[0.1em]">
                  {multiplePrints && printTitleOf(item)
                    ? printTitleOf(item)
                    : item.material_key === "diamond"
                      ? "holographic"
                      : item.material_key}
                </span>
                <span className="mt-0.5 block text-sm font-semibold">
                  {displayFinish(item.name, item.material_key, item.effect_key)}
                </span>
                {multiplePrints && printTitleOf(item) ? (
                  <span className="mt-0.5 block font-mono text-[0.5rem] uppercase tracking-[0.08em] text-[var(--muted)]">
                    {item.material_key === "diamond" ? "holographic" : item.material_key}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="notice mt-8 flex gap-3">
          <Sparkles size={18} className="mt-0.5 shrink-0 text-[var(--brass)]" aria-hidden="true" />
          <p className="text-sm leading-relaxed">
            The illustration stays the same identity. The material and effect are separate authored
            layers with pinned recipe versions, so a later asset change cannot silently alter an owned card.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <a className="btn btn-primary" href="/login?next=%2Fplay">Sign in to collect</a>
          <a className="btn btn-secondary" href="/cabinet">Back to the catalogue</a>
        </div>
      </div>
    </div>
  );
}
