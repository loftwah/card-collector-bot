"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  frontUrl: string | null;
  backUrl: string | null;
  name: string;
  subtitle?: string | null;
  finish: string;
  collection?: string | null;
  serial?: string | null;
  fallbackUrl?: string | null;
  initialEnabled?: boolean;
  initialFlipped?: boolean;
  framed?: boolean;
}

/**
 * On-demand 3D inspection. This is deliberately CSS 3D, not a live WebGL canvas:
 * it has a flat fallback, no texture budget, no continuous render loop and no
 * GPU context to lose. Animation runs only while the pointer/keyboard is
 * actively moving the card, and stops when the component is offscreen or the
 * tab is hidden.
 */
export default function CardInspector({
  frontUrl,
  backUrl,
  name,
  subtitle,
  finish,
  collection,
  serial,
  fallbackUrl,
  initialEnabled = false,
  initialFlipped = false,
  framed = false,
}: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [flipped, setFlipped] = useState(initialFlipped);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [reduced, setReduced] = useState<boolean | null>(null);
  const [active, setActive] = useState(true);
  const shell = useRef<HTMLDivElement>(null);
  const modeButton = useRef<HTMLButtonElement>(null);
  const frame = useRef<number | null>(null);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  const front = frontUrl ?? fallbackUrl;
  const back = backUrl ?? fallbackUrl;

  useEffect(() => {
    if (initialEnabled) modeButton.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTilt({ x: 0, y: 0 });
      setFlipped(false);
      setEnabled(false);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [enabled]);

  useEffect(() => {
    if (!shell.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setActive(Boolean(entry?.isIntersecting)),
      { threshold: 0.05 },
    );
    observer.observe(shell.current);
    const visibility = () => setActive(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  const canTilt = enabled && reduced === false && active;
  // The selected side is independent of the presentation mode. Flat, reduced
  // motion and temporarily inactive views still rotate to the chosen face;
  // only the pointer/keyboard tilt is suppressed when interaction is off.
  const style = useMemo(
    () => ({
      transform: `rotateX(${canTilt ? tilt.x : 0}deg) rotateY(${(canTilt ? tilt.y : 0) + (flipped ? 180 : 0)}deg)`,
    }),
    [canTilt, flipped, tilt],
  );

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  function move(clientX: number, clientY: number) {
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const box = shell.current?.getBoundingClientRect();
        if (!box) return;
        const x = ((clientX - box.left) / box.width - 0.5) * 2;
        const y = ((clientY - box.top) / box.height - 0.5) * 2;
        setTilt({ x: clamp(-y * 11, -11, 11), y: clamp(x * 13, -13, 13) });
      });
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!canTilt) return;
    dragging.current = true;
    last.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!canTilt) return;
    if (dragging.current) {
      const dx = event.clientX - last.current.x;
      const dy = event.clientY - last.current.y;
      last.current = { x: event.clientX, y: event.clientY };
      setTilt((current) => ({
        x: clamp(current.x - dy * 0.28, -18, 18),
        y: clamp(current.y + dx * 0.32, -22, 22),
      }));
      return;
    }
    move(event.clientX, event.clientY);
  }

  function onPointerUp() {
    dragging.current = false;
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setTilt((current) => ({ ...current, y: clamp(current.y - 6, -22, 22) }));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setTilt((current) => ({ ...current, y: clamp(current.y + 6, -22, 22) }));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setTilt((current) => ({ ...current, x: clamp(current.x - 4, -18, 18) }));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setTilt((current) => ({ ...current, x: clamp(current.x + 4, -18, 18) }));
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFlipped((value) => !value);
    } else if (event.key === "Escape") {
      setTilt({ x: 0, y: 0 });
      setFlipped(false);
    }
  }

  return (
    <div className="card-inspector">
      <div className={framed ? "card-rail p-3" : "contents"}>
        <div
          ref={shell}
          className={cn(
            "card-inspector__stage",
            framed && "card-inspector__stage--framed",
            enabled && "is-3d",
            canTilt && "is-live",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            onPointerUp();
            if (canTilt) setTilt({ x: 0, y: 0 });
          }}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="group"
          aria-label={`${name} card inspector. Use left and right arrows to tilt, F to flip, Escape to reset.`}
          data-active={active ? "true" : "false"}
          data-flipped={flipped ? "true" : "false"}
          data-mode={enabled ? (canTilt ? "interactive" : "static") : "flat"}
        >
          <div className="card-inspector__object" style={style}>
            <div className="card-inspector__face card-inspector__front" aria-hidden={flipped}>
              {front ? (
                <img
                  src={front}
                  alt={`${name} front, ${finish} finish`}
                  width={750}
                  height={1050}
                />
              ) : (
                <div className="card-face-fallback">{name.charAt(0)}</div>
              )}
            </div>
            <div className="card-inspector__face card-inspector__back" aria-hidden={!flipped}>
              {back ? (
                <img
                  src={back}
                  alt={`${name} back, ${finish} finish`}
                  width={750}
                  height={1050}
                  loading="lazy"
                />
              ) : (
                <div className="card-face-fallback">Back</div>
              )}
            </div>
            <div className="card-inspector__edge" aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className="card-inspector__controls">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setFlipped((value) => !value)}
          aria-pressed={flipped}
        >
          <RotateCcw size={14} /> {flipped ? "View front" : "View back"}
        </button>
        <button
          type="button"
          className={cn("btn btn-sm", enabled ? "btn-primary" : "btn-secondary")}
          ref={modeButton}
          onClick={() => {
            setEnabled((value) => {
              const next = !value;
              setTilt(next ? { x: -4, y: 7 } : { x: 0, y: 0 });
              return next;
            });
          }}
          aria-pressed={enabled}
        >
          <Box size={14} /> {enabled ? "Exit 3D" : "Inspect in 3D"}
        </button>
        {enabled ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setTilt({ x: 0, y: 0 });
              setFlipped(false);
            }}
          >
            Reset
          </button>
        ) : null}
      </div>
      <p className="mt-2 font-mono text-[0.56rem] tracking-[0.1em] text-[var(--muted)] uppercase">
        {reduced
          ? "Static inspection · reduced motion is on"
          : enabled
            ? "Drag or use arrow keys · F flips · Escape resets"
            : `Flat view · ${collection ?? "Cabinet"}${serial ? ` · ${serial}` : ""}`}
      </p>
      <p className="sr-only" aria-live="polite">
        {flipped ? "Showing card back" : "Showing card front"}.
        {canTilt
          ? ` Tilt ${Math.round(tilt.y)} degrees horizontally, ${Math.round(tilt.x)} degrees vertically.`
          : ""}
      </p>
    </div>
  );
}
