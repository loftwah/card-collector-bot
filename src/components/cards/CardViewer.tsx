"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Download, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { CARD_STYLE_LABEL } from "@/lib/card-styles";
import { api, describeError } from "@/lib/client";

/**
 * The one card viewer used by the Art Lab, Print Studio, platform brand art,
 * the member cabinet, collection binders, card detail and admin previews.
 *
 * A card object is the trigger. The viewer shows the saved front and back
 * renders (never a recomposed private layer), keeps Download as a separate
 * action, and carries the facts that tell the operator what they are looking
 * at. It is a modal because a card is an object worth standing still for, not
 * because a modal is a convenient container.
 */
export interface CardViewerItem {
  id: string;
  name: string;
  subtitle?: string | null;
  collection?: string | null;
  styleKey?: string | null;
  styleLabel?: string | null;
  finish?: string | null;
  method?: string | null;
  model?: string | null;
  status?: string | null;
  width?: number | null;
  height?: number | null;
  masterWidth?: number | null;
  masterHeight?: number | null;
  printCode?: string | null;
  serial?: string | null;
  audience?: string | null;
  provenance?: string | null;
  front: string;
  back?: string | null;
  master?: string | null;
  downloadUrl?: string | null;
  href?: string | null;
  reviewEndpoint?: string | null;
  canReview?: boolean;
  reviewLikes?: number;
  reviewDislikes?: number;
  reviewDecision?: "like" | "dislike" | null;
}

export interface CardViewerRequest {
  items: CardViewerItem[];
  index?: number;
}

const OPEN_EVENT = "foilbury:card-viewer";

export function openCardViewer(items: CardViewerItem[], index = 0): void {
  if (!items.length || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CardViewerRequest>(OPEN_EVENT, {
      detail: { items, index: Math.max(0, Math.min(items.length - 1, index)) },
    }),
  );
}

function styleLabel(item: CardViewerItem): string | null {
  if (item.styleLabel) return item.styleLabel;
  if (!item.styleKey) return null;
  return CARD_STYLE_LABEL[item.styleKey] ?? item.styleKey;
}

function dimensions(item: CardViewerItem): string | null {
  if (!item.width || !item.height) return null;
  const base = `${item.width} × ${item.height}`;
  if (item.masterWidth && item.masterHeight) {
    return `${base} · master ${item.masterWidth} × ${item.masterHeight}`;
  }
  return base;
}

export default function CardViewer() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [items, setItems] = useState<CardViewerItem[]>([]);
  const [index, setIndex] = useState(0);
  const [side, setSide] = useState<"front" | "back">("front");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);

  const item = items[index] ?? null;
  const hasBack = Boolean(item?.back);

  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
  }, []);

  const move = useCallback(
    (delta: number) => {
      setItems((current) => {
        if (current.length < 2) return current;
        return current;
      });
      setIndex((current) => {
        if (!items.length) return current;
        return (current + delta + items.length) % items.length;
      });
      setSide("front");
    },
    [items.length],
  );

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<CardViewerRequest>).detail;
      if (!detail?.items?.length) return;
      restoreRef.current = document.activeElement as HTMLElement | null;
      setItems(detail.items);
      setIndex(Math.max(0, Math.min(detail.items.length - 1, detail.index ?? 0)));
      setSide("front");
      setReviewComment("");
      setReviewNotice("");
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) dialog.showModal();
      requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
    }
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!item) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [item]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog?.open) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSide("front");
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        if (hasBack) setSide("back");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, hasBack]);

  async function sendReview(decision: "like" | "dislike") {
    if (!item?.reviewEndpoint || reviewBusy) return;
    setReviewBusy(true);
    setReviewNotice("");
    try {
      const result = await api<{
        candidate: { feedback: Array<{ decision: string }> };
      }>(item.reviewEndpoint, {
        method: "POST",
        body: { decision, body: reviewComment.trim() || null },
      });
      const feedback = result.candidate.feedback ?? [];
      const likes = feedback.filter((entry) => entry.decision === "like").length;
      const dislikes = feedback.filter((entry) => entry.decision === "dislike").length;
      setItems((current) =>
        current.map((entry, entryIndex) =>
          entryIndex === index
            ? {
                ...entry,
                reviewDecision: decision,
                reviewLikes: likes,
                reviewDislikes: dislikes,
              }
            : entry,
        ),
      );
      setReviewNotice(decision === "like" ? "Saved: keep" : "Saved: not this");
    } catch (cause) {
      setReviewNotice(describeError(cause));
    } finally {
      setReviewBusy(false);
    }
  }

  function onDialogClose() {
    const restore = restoreRef.current;
    restoreRef.current = null;
    setItems([]);
    setIndex(0);
    setSide("front");
    if (restore && document.contains(restore)) restore.focus({ preventScroll: true });
  }

  if (!item) {
    return <dialog ref={dialogRef} className="card-viewer" onClose={onDialogClose} />;
  }

  const label = styleLabel(item);
  const facts: Array<[string, string | null]> = [
    ["Collection", item.collection ?? null],
    ["Style", label],
    ["Finish", item.finish ?? null],
    ["Method", item.method ?? null],
    ["Model", item.model ?? null],
    ["Status", item.status ? item.status.replaceAll("_", " ") : null],
    ["Dimensions", dimensions(item)],
    ["Print code", item.printCode ?? null],
    ["Serial", item.serial ?? null],
    ["Audience", item.audience ?? null],
  ];
  const visibleFacts = facts.filter((entry): entry is [string, string] => Boolean(entry[1]));
  const downloadUrl =
    item.downloadUrl ?? (side === "back" ? (item.back ?? item.front) : item.front);

  return (
    <dialog
      ref={dialogRef}
      className="card-viewer"
      aria-label={`${item.name} card viewer`}
      onClose={onDialogClose}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== "Tab") return;
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        if (!focusables.length) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || active === dialog)) {
          event.preventDefault();
          first.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
    >
      <div className="card-viewer__sheet">
        <header className="card-viewer__bar">
          <div className="card-viewer__identity">
            <p className="card-viewer__name">{item.name}</p>
            <p className="card-viewer__meta">
              {[item.collection, label, item.finish].filter(Boolean).join(" · ") || "Card"}
            </p>
          </div>
          <div className="card-viewer__bar-actions">
            <a
              className="card-viewer__download"
              href={downloadUrl}
              download
              aria-label={`Download ${item.name} ${side}`}
            >
              <Download size={14} aria-hidden="true" /> Download
            </a>
            <button
              ref={closeButtonRef}
              type="button"
              className="card-viewer__close"
              onClick={close}
              aria-label="Close card viewer"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="card-viewer__body">
          <div className="card-viewer__stage">
            <button
              type="button"
              className="card-viewer__object"
              onClick={() =>
                hasBack && setSide((current) => (current === "front" ? "back" : "front"))
              }
              aria-label={
                hasBack ? `Show ${side === "front" ? "back" : "front"} of ${item.name}` : item.name
              }
              disabled={!hasBack}
            >
              <img
                key={`${item.id}-${side}`}
                src={side === "back" && item.back ? item.back : item.front}
                alt={`${item.name} ${side}${label ? `, ${label} style` : ""}`}
                width={item.width ?? 750}
                height={item.height ?? 1050}
              />
            </button>
            <div className="card-viewer__toolbar">
              <div className="card-viewer__sides" role="group" aria-label="Card face">
                <button
                  type="button"
                  aria-pressed={side === "front"}
                  onClick={() => setSide("front")}
                >
                  Front
                </button>
                <button
                  type="button"
                  aria-pressed={side === "back"}
                  onClick={() => setSide("back")}
                  disabled={!hasBack}
                >
                  Back
                </button>
              </div>
              {item.master ? (
                <a
                  className="card-viewer__master"
                  href={item.master}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open master ↗
                </a>
              ) : null}
              {items.length > 1 ? (
                <div className="card-viewer__pager">
                  <button type="button" onClick={() => move(-1)} aria-label="Previous card">
                    <ArrowLeft size={15} aria-hidden="true" />
                  </button>
                  <span>
                    {index + 1} / {items.length}
                  </span>
                  <button type="button" onClick={() => move(1)} aria-label="Next card">
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <aside className="card-viewer__facts" aria-label="Card facts">
            {item.subtitle ? <p className="card-viewer__subtitle">{item.subtitle}</p> : null}
            <dl>
              {visibleFacts.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {item.reviewEndpoint ? (
              <section className="card-viewer__review" aria-label="Review this card">
                <p className="card-viewer__review-title">Your read</p>
                <div className="card-viewer__votes">
                  <button
                    type="button"
                    data-active={item.reviewDecision === "like" ? "true" : "false"}
                    disabled={!item.canReview || reviewBusy}
                    onClick={() => void sendReview("like")}
                    aria-label={`Keep ${item.name}`}
                  >
                    <ThumbsUp size={16} aria-hidden="true" />
                    <span>Keep</span>
                    <b>{item.reviewLikes ?? 0}</b>
                  </button>
                  <button
                    type="button"
                    data-active={item.reviewDecision === "dislike" ? "true" : "false"}
                    disabled={!item.canReview || reviewBusy}
                    onClick={() => void sendReview("dislike")}
                    aria-label={`Mark ${item.name} as not this`}
                  >
                    <ThumbsDown size={16} aria-hidden="true" />
                    <span>Not this</span>
                    <b>{item.reviewDislikes ?? 0}</b>
                  </button>
                </div>
                <textarea
                  className="card-viewer__comment"
                  value={reviewComment}
                  onChange={(event) => setReviewComment(event.target.value)}
                  placeholder="Optional comment: what works, what is wrong, what to keep."
                  disabled={!item.canReview || reviewBusy}
                  rows={2}
                />
                <p className="card-viewer__review-hint">
                  {item.canReview
                    ? "Add a comment if you want, then pick a thumb. It saves immediately."
                    : "This direction can no longer be re-reviewed. Roll it back first."}
                </p>
                <p className="card-viewer__review-notice" role="status" aria-live="polite">
                  {reviewNotice}
                </p>
              </section>
            ) : null}
            {item.provenance ? <p className="card-viewer__provenance">{item.provenance}</p> : null}
            {item.href ? (
              <a className="card-viewer__inspect" href={item.href}>
                Inspect this copy →
              </a>
            ) : null}
          </aside>
        </div>
      </div>
    </dialog>
  );
}
