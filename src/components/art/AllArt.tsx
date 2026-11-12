"use client";

import { useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/client";
import {
  ART_GRADES,
  ART_TASTE_FILTERS,
  type ArtTaste,
  type ArtTasteKind,
  type ArtTastePiece,
} from "@/lib/art-taste";
import CardViewer, { openCardViewer } from "../cards/CardViewer";

const ENDPOINT = "/api/v1/studio/art/taste";
const FILTERS = [
  ["any", "Any grade"],
  ["ungraded", "Ungraded"],
  ["graded", "Graded"],
  ["favourites", "Favourites"],
] as const;

function gradeMatches(piece: ArtTastePiece, filter: (typeof FILTERS)[number][0]) {
  const grade = piece.taste?.grade;
  if (filter === "ungraded") return grade == null;
  if (filter === "graded") return grade != null;
  if (filter === "favourites") return grade === 5;
  return true;
}

export default function AllArt() {
  const [pieces, setPieces] = useState<ArtTastePiece[]>([]);
  const [kind, setKind] = useState<ArtTasteKind | "all">("all");
  const [grade, setGrade] = useState<(typeof FILTERS)[number][0]>("any");
  const [collection, setCollection] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activePiece, setActivePiece] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();
    api<{ pieces: ArtTastePiece[] }>(ENDPOINT, { signal: controller.signal })
      .then(({ pieces }) => {
        if (!controller.signal.aborted) setPieces(pieces);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(describeError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const category = pieces.filter((piece) => kind === "all" || piece.kind === kind);
  const collections = [
    ...new Set(category.flatMap((piece) => (piece.collection ? [piece.collection] : []))),
  ].sort((a, b) => a.localeCompare(b));
  const visible = category.filter(
    (piece) =>
      (!collection || piece.collection === collection) &&
      (piece.id === activePiece || gradeMatches(piece, grade)),
  );

  function openAt(index: number) {
    openCardViewer(
      visible.map((piece) => ({
        id: piece.id,
        name: piece.name,
        subtitle: piece.caption,
        collection: piece.collection,
        width: piece.width,
        height: piece.height,
        status: piece.status,
        provenance: piece.provenance,
        front: piece.image,
        back: piece.back,
        canReview: Boolean(piece.candidateReview),
        reviewEndpoint: piece.candidateReview?.endpoint,
        reviewLikes: piece.candidateReview?.likes,
        reviewDislikes: piece.candidateReview?.dislikes,
        reviewDecision: piece.candidateReview?.decision,
        href: piece.brief ? `/studio/art?brief=${encodeURIComponent(piece.brief)}` : undefined,
      })),
      index,
    );
  }

  async function save(pieceId: string, patch: Partial<ArtTaste>) {
    const taste = await api<ArtTaste>(ENDPOINT, { body: { pieceId, ...patch } });
    setPieces((current) =>
      current.map((piece) => (piece.id === pieceId ? { ...piece, taste } : piece)),
    );
    if (patch.note !== undefined) {
      setDrafts((current) => {
        if (current[pieceId] !== patch.note) return current;
        const next = { ...current };
        delete next[pieceId];
        return next;
      });
    }
  }

  return (
    <div className="min-w-0">
      <CardViewer />
      <header className="all-art-bar">
        <div>
          <h1 className="review-wall-title">Art review wall</h1>
          <p className="review-wall-intro">
            Grade what catches your eye and note what you’d change. Your grades and notes are
            private to you.
          </p>
        </div>
        <a className="btn btn-secondary min-h-11 shrink-0" href="/studio/art">
          Art Lab
        </a>
      </header>

      <nav className="all-art-filters" aria-label="Artwork type">
        {ART_TASTE_FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="chip min-h-11"
            data-active={kind === key}
            aria-pressed={kind === key}
            onClick={() => {
              setKind(key);
              setCollection("");
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="review-wall-controls">
        <label>
          <span className="sr-only">Filter by grade</span>
          <select
            className="select min-h-11"
            value={grade}
            onChange={(event) => setGrade(event.target.value as typeof grade)}
          >
            {FILTERS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {collections.length > 0 && (
          <label className="review-wall-collection">
            <span className="sr-only">Filter by collection</span>
            <select
              className="select min-h-11"
              value={collection}
              onChange={(event) => setCollection(event.target.value)}
            >
              <option value="">Any collection</option>
              {collections.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
        {!loading && !error && <span role="status">{visible.length} pieces</span>}
      </div>

      {loading ? (
        <p role="status" className="notice">
          Loading artwork…
        </p>
      ) : error ? (
        <div className="notice" role="alert">
          <p>Couldn’t load the review wall. {error}</p>
          <button
            className="btn btn-secondary min-h-11"
            type="button"
            onClick={() => {
              setError("");
              setLoading(true);
              setAttempt(attempt + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : visible.length ? (
        <div className="review-wall">
          {visible.map((piece, index) => (
            <ReviewTile
              key={piece.id}
              piece={piece}
              eager={index < 4}
              open={() => openAt(index)}
              save={save}
              note={drafts[piece.id] ?? piece.taste?.note ?? ""}
              editNote={(value) => setDrafts((current) => ({ ...current, [piece.id]: value }))}
              setActive={setActivePiece}
            />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>No artwork matches these filters.</p>
        </div>
      )}
    </div>
  );
}

function ReviewTile({
  piece,
  eager,
  open,
  save,
  note,
  editNote,
  setActive,
}: {
  piece: ArtTastePiece;
  eager: boolean;
  open: () => void;
  save: (pieceId: string, patch: Partial<ArtTaste>) => Promise<void>;
  note: string;
  editNote: (note: string) => void;
  setActive: (id: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [message, setMessage] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const name = `${piece.name} · ${piece.caption}`;

  async function submit(patch: Partial<ArtTaste>) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      await save(piece.id, patch);
      setMessage("Saved");
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <article
      className="review-tile"
      data-kind={piece.kind}
      data-mark={piece.caption === "Mark"}
      onFocus={() => setActive(piece.id)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setActive(null);
      }}
    >
      <button
        type="button"
        className="all-art-tile"
        onClick={open}
        disabled={imageFailed}
        aria-label={`Open ${name} full size`}
      >
        <span className="all-art-tile__object">
          {imageFailed ? (
            <span className="review-tile-missing">Image unavailable</span>
          ) : (
            <img
              src={piece.image}
              alt=""
              width={piece.width ?? undefined}
              height={piece.height ?? undefined}
              loading={eager ? "eager" : "lazy"}
              onError={() => setImageFailed(true)}
            />
          )}
        </span>
        <strong>{piece.name}</strong>
        <span className="review-tile-caption">
          {piece.caption}
          {piece.status ? ` · ${piece.status.replaceAll("_", " ")}` : ""}
        </span>
      </button>
      <label className="review-tile-grade">
        <span className="sr-only">Grade {name}</span>
        <select
          className="select min-h-11"
          value={piece.taste?.grade ?? ""}
          aria-disabled={busy}
          onChange={(event) =>
            void submit({ grade: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">Ungraded</option>
          {ART_GRADES.map(([value, label]) => (
            <option value={value} key={value}>
              {value} · {label}
            </option>
          ))}
        </select>
      </label>
      <details className="review-tile-note">
        <summary>{piece.taste?.note ? "Your note" : "Add note"}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ note });
          }}
        >
          <label>
            <span className="sr-only">Note on {name}</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(event) => editNote(event.target.value)}
            />
          </label>
          <button
            className="btn btn-secondary min-h-11"
            type="submit"
            disabled={busy || note.trim() === (piece.taste?.note ?? "")}
          >
            Save note
          </button>
        </form>
      </details>
      {piece.brief && (
        <a
          className="review-tile-brief"
          href={`/studio/art?brief=${encodeURIComponent(piece.brief)}`}
        >
          Open brief
        </a>
      )}
      <div className="review-tile-message" role="status">
        {busy ? "Saving…" : message}
      </div>
    </article>
  );
}
