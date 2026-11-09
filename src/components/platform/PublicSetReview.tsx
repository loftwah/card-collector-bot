"use client";

import { useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";

type Snapshot = {
  id: string;
  version: number;
  slug: string;
  name: string;
  description: string;
  reward: number;
  roster: Array<[string, string, string, number]>;
};
type Review = {
  id: string;
  set_version: number;
  snapshot_hash: string;
  review_note: string;
  reviewed_by: string;
  reviewed_at: string;
  revoked_at: string | null;
  reason: string | null;
};
type Candidate = {
  id: string;
  name: string;
  version: number;
  eligible: boolean;
  has_history: boolean;
};
const pathFor = (id: string) => `/api/v1/platform/sets/${encodeURIComponent(id)}`;

export default function PublicSetReview({ tenantSlug }: { tenantSlug: string }) {
  const [setId, setSetId] = useState("");
  const [loadedId, setLoadedId] = useState("");
  const [preview, setPreview] = useState<{ snapshot: Snapshot; snapshot_hash: string } | null>(
    null,
  );
  const [history, setHistory] = useState<Review[] | null>(null);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [message, setMessage] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);

  function chooseSet(id: string) {
    setSetId(id);
    setLoadedId("");
    setPreview(null);
    setHistory(null);
    setNote("");
    setConfirmed(false);
    setReasons({});
    setError("");
    setHistoryError("");
    setMessage("");
  }

  async function discover() {
    setBusy("discover");
    setError("");
    setMessage("");
    try {
      const result = await api<{ items: Candidate[] }>(
        "/api/v1/platform/public-set-review-candidates",
      );
      setCandidates(result.items);
    } catch (cause) {
      setCandidates(null);
      setError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  async function load() {
    const id = setId.trim();
    if (!id) return;
    setBusy("load");
    setLoadedId(id);
    setPreview(null);
    setHistory(null);
    setNote("");
    setConfirmed(false);
    setReasons({});
    setError("");
    setHistoryError("");
    setMessage("");
    const [snapshotResult, historyResult] = await Promise.allSettled([
      api<{ snapshot: Snapshot; snapshot_hash: string }>(`${pathFor(id)}/public-review`),
      api<{ items: Review[] }>(`${pathFor(id)}/public-reviews`),
    ]);
    if (snapshotResult.status === "fulfilled") setPreview(snapshotResult.value);
    else setError(describeError(snapshotResult.reason));
    if (historyResult.status === "fulfilled") setHistory(historyResult.value.items);
    else setHistoryError(describeError(historyResult.reason));
    setBusy("");
  }

  async function approve() {
    if (!preview || !confirmed || note.trim().length < 20 || busy) return;
    setBusy("approve");
    setError("");
    setMessage("");
    try {
      await api(`${pathFor(loadedId)}/public-review`, {
        method: "POST",
        body: { snapshotHash: preview.snapshot_hash, note: note.trim() },
      });
      setPreview(null);
      setConfirmed(false);
      setNote("");
      setHistory(null);
      setMessage("Review recorded. Load the set again to inspect its current state and history.");
    } catch (cause) {
      setPreview(null);
      setConfirmed(false);
      setError(`${describeError(cause)} Load the set again before reviewing.`);
    } finally {
      setBusy("");
    }
  }

  async function revoke(review: Review) {
    const reason = (reasons[review.id] ?? "").trim();
    if (reason.length < 20 || busy || review.revoked_at) return;
    setBusy(`revoke-${review.id}`);
    setError("");
    setHistoryError("");
    setMessage("");
    try {
      await api(`/api/v1/platform/public-set-releases/${encodeURIComponent(review.id)}/revoke`, {
        method: "POST",
        body: { reason },
      });
      setPreview(null);
      setConfirmed(false);
      setHistory(null);
      setMessage(
        "Revocation recorded. Load the set again to inspect its current state and history.",
      );
    } catch (cause) {
      setHistoryError(describeError(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-6">
      <header>
        <p className="eyebrow">Public set releases</p>
        <h2 className="display-sm mt-2 text-3xl">Review an exact set.</h2>
        <p className="mt-3 max-w-2xl text-sm text-[var(--muted)]">
          Review applies to the current Bot context, <strong>{tenantSlug}</strong>. Find a set or
          enter an exact set ID. No review is recorded until you submit it.
        </p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          A current passkey or MFA session is required. Access admission alone does not authorise
          this review.
        </p>
      </header>
      <form
        className="surface-flat grid gap-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void discover()}
            disabled={Boolean(busy)}
          >
            {busy === "discover" ? "Finding…" : "Find sets"}
          </Button>
        </div>
        {candidates?.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No eligible sets or review history in this Bot.
          </p>
        ) : null}
        {candidates?.length ? (
          <label className="field">
            <span className="label">Available sets</span>
            <Select
              value={candidates.some((item) => item.id === setId) ? setId : ""}
              onChange={(event) => chooseSet(event.target.value)}
              disabled={Boolean(busy)}
            >
              <option value="">Choose a set</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · version {item.version} ·{" "}
                  {item.eligible ? "eligible" : "history only"}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className="field">
          <span className="label">Set ID</span>
          <Input
            value={setId}
            onChange={(event) => chooseSet(event.target.value)}
            disabled={Boolean(busy)}
            autoComplete="off"
            required
          />
        </label>
        <div>
          <Button type="submit" disabled={!setId.trim() || Boolean(busy)}>
            {busy === "load" ? "Loading…" : "Load review"}
          </Button>
        </div>
      </form>
      {message ? (
        <div className="success-box" role="status">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
      {preview ? (
        <section className="surface-flat p-5" aria-labelledby="set-review-title">
          <p className="eyebrow">Snapshot to review</p>
          <h3 id="set-review-title" className="display-sm mt-2 text-2xl">
            {preview.snapshot.name}
          </h3>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {preview.snapshot.description || "No description supplied."}
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="studio-stat__label">Set ID</dt>
              <dd className="break-all">{preview.snapshot.id}</dd>
            </div>
            <div>
              <dt className="studio-stat__label">Slug / version</dt>
              <dd>
                {preview.snapshot.slug} · {preview.snapshot.version}
              </dd>
            </div>
            <div>
              <dt className="studio-stat__label">Completion reward</dt>
              <dd>✦ {preview.snapshot.reward}</dd>
            </div>
          </dl>
          <h4 className="mt-6 font-semibold">
            Exact roster · {preview.snapshot.roster.length}{" "}
            {preview.snapshot.roster.length === 1 ? "card" : "cards"}
          </h4>
          <ol className="mt-2 grid gap-2">
            {preview.snapshot.roster.map(([id, slug, name, sort]) => (
              <li key={id} className="border border-[var(--line)] p-3 text-sm">
                <strong>{name}</strong>
                <span className="block text-xs break-all text-[var(--muted)]">
                  {slug} · {id} · order {sort}
                </span>
              </li>
            ))}
          </ol>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium">Technical snapshot hash</summary>
            <p className="mt-2 font-mono text-xs break-all">{preview.snapshot_hash}</p>
          </details>
          <p className="mt-4 text-sm text-[var(--muted)]">
            The server rechecks this snapshot and its public eligibility when you submit. Any change
            requires a new review.
          </p>
          <label className="field mt-4">
            <span className="label">Review note · at least 20 characters</span>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              rows={3}
              disabled={Boolean(busy)}
            />
          </label>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={Boolean(busy)}
            />
            <span>
              I have reviewed the exact set, reward and roster shown above for public release.
            </span>
          </label>
          <div className="mt-4">
            <Button
              onClick={() => void approve()}
              disabled={Boolean(busy) || !confirmed || note.trim().length < 20}
            >
              {busy === "approve" ? "Recording…" : "Record public-set review"}
            </Button>
          </div>
        </section>
      ) : null}
      {loadedId ? (
        <section className="surface-flat p-5" aria-labelledby="review-history-title">
          <h3 id="review-history-title" className="display-sm text-2xl">
            Review history
          </h3>
          <p className="mt-2 text-sm text-[var(--muted)]">
            A record that has not been revoked is not necessarily current; later set or audience
            changes can invalidate it.
          </p>
          {historyError ? (
            <div className="error-box mt-3" role="alert">
              {historyError}
            </div>
          ) : null}
          {history?.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">No review recorded for this set.</p>
          ) : null}
          {history === null && !historyError && busy !== "load" ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              Load the set to see its review history.
            </p>
          ) : null}
          <div className="mt-4 grid gap-4">
            {history?.map((review) => (
              <article className="border border-[var(--line)] p-4" key={review.id}>
                <p className="font-semibold">
                  Version {review.set_version} ·{" "}
                  {review.revoked_at ? "Revoked" : "Recorded · not revoked"}
                </p>
                <p className="mt-1 font-mono text-xs break-all text-[var(--muted)]">
                  {review.snapshot_hash}
                </p>
                <p className="mt-2 text-sm">{review.review_note}</p>
                <p className="mt-2 text-xs break-all text-[var(--muted)]">
                  Reviewed by {review.reviewed_by} · {review.reviewed_at}
                </p>
                {review.revoked_at ? (
                  <p className="mt-2 text-sm">
                    Revoked {review.revoked_at} · {review.reason}
                  </p>
                ) : (
                  <>
                    <label className="field mt-4">
                      <span className="label">Revocation reason · at least 20 characters</span>
                      <Textarea
                        value={reasons[review.id] ?? ""}
                        onChange={(event) =>
                          setReasons((current) => ({ ...current, [review.id]: event.target.value }))
                        }
                        maxLength={2000}
                        rows={2}
                        disabled={Boolean(busy)}
                      />
                    </label>
                    <Button
                      className="mt-3"
                      variant="secondary"
                      onClick={() => void revoke(review)}
                      disabled={Boolean(busy) || (reasons[review.id] ?? "").trim().length < 20}
                    >
                      {busy === `revoke-${review.id}` ? "Recording…" : "Revoke review"}
                    </Button>
                  </>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
