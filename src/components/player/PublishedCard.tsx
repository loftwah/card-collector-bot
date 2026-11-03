"use client";

import { useState } from "react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A published card is one front render and one back render. This is the
 * member-facing presentation: it is the same saved artwork the renderer
 * produced, so it stays in parity with the album, the detail inspector and
 * Discord. It deliberately does not re-compose the private source layers.
 */
export default function PublishedCard({
  frontUrl,
  backUrl,
  name,
  serial,
  href,
  inspectHref,
  showToolbar = true,
  className,
}: {
  frontUrl: string;
  backUrl?: string | null;
  name: string;
  serial?: string | null;
  href?: string;
  inspectHref?: string;
  showToolbar?: boolean;
  className?: string;
}) {
  const [flipped, setFlipped] = useState(false);
  const back = backUrl || frontUrl;

  const faces = (
    <>
      <img
        className="published-card__face"
        src={frontUrl}
        alt={`${name} front`}
        width="750"
        height="1050"
        data-hidden={flipped ? "true" : "false"}
      />
      <img
        className="published-card__face published-card__back"
        src={back}
        alt={`${name} back${serial ? `, ${serial}` : ""}`}
        width="750"
        height="1050"
        loading="eager"
        data-hidden={flipped ? "false" : "true"}
      />
    </>
  );

  return (
    <div className={cn("published-card-shell", className)}>
      {href ? (
        <a href={href} className="published-card block no-underline" aria-label={`Inspect ${name}`}>
          {faces}
        </a>
      ) : (
        <div className="published-card">{faces}</div>
      )}
      {showToolbar ? (
        <div className="card-toolbar">
          <button
            type="button"
            className="card-toolbar__button"
            onClick={() => setFlipped((value) => !value)}
            aria-pressed={flipped}
            aria-label={flipped ? `Show ${name} front` : `Show ${name} back`}
          >
            <RotateCcw size={13} aria-hidden="true" /> {flipped ? "Front" : "Back"}
          </button>
          {inspectHref ? (
            <a className="card-toolbar__button" href={inspectHref}>
              Inspect <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          ) : null}
          <span className="font-mono text-[0.54rem] tracking-[0.08em] text-[var(--muted)] uppercase">
            {serial ?? "Published render"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
