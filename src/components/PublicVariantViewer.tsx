"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface Variant {
  id: string;
  name: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
}

export default function PublicVariantViewer({
  name,
  subtitle,
  description,
  rarity,
  setName,
  tags,
  variants,
}: {
  name: string;
  subtitle: string | null;
  description: string;
  rarity: string | null;
  setName: string | null;
  tags: string[];
  variants: Variant[];
}) {
  const [selected, setSelected] = useState(0);
  const variant = variants[selected] ?? variants[0];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
      <div>
        <div className="card-rail p-3">
          <div className="card-face">
            {variant?.render_url ? <img src={variant.render_url} alt={`${name} card in ${variant.name} finish`} /> : <div className="card-face-fallback">{name.charAt(0)}</div>}
          </div>
        </div>
        <p className="mt-3 text-center font-mono text-[0.6rem] uppercase tracking-[0.12em] text-[var(--muted)]">Published render · {variant?.name ?? "Awaiting render"}</p>
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {rarity ? <span className="badge badge-rare">{rarity}</span> : null}
          {setName ? <span className="badge">{setName}</span> : null}
          {tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
        </div>
        <h1 className="display mt-5 text-[clamp(2.8rem,7vw,5.5rem)]">{name}</h1>
        {subtitle ? <p className="mt-2 text-lg text-[var(--brass)]">{subtitle}</p> : null}
        <p className="prose mt-6 text-[var(--muted)]">{description}</p>

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
                    ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]"
                    : "border-[var(--line)] text-[var(--muted)] hover:border-[var(--brass)] hover:text-[var(--ink)]",
                )}
              >
                <span className="block font-mono text-[0.58rem] uppercase tracking-[0.1em]">{item.material_key}</span>
                <span className="mt-0.5 block text-sm font-semibold">{item.name}</span>
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
