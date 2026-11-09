"use client";

import { useEffect, useState } from "react";
import { api, describeError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";

type SetOption = { id: string; name: string; version: number; status: string };
type Snapshot = {
  id: string;
  version: number;
  reward: number;
  roster: Array<[string, string, string, number]>;
  collections: Array<
    [string, string, string, string, string | null, string, string, string | null, string | null]
  >;
};
type Review = { id: string; set_version: number; reviewed_at: string; revoked_at: string | null };
const setPath = (id: string) => `/api/v1/admin/sets/${encodeURIComponent(id)}`;

export default function MemberSetReview({ tenantSlug }: { tenantSlug: string }) {
  const [sets, setSets] = useState<SetOption[] | null>(null);
  const [selected, setSelected] = useState("");
  const [loadedId, setLoadedId] = useState("");
  const [preview, setPreview] = useState<{ snapshot: Snapshot; snapshot_hash: string } | null>(
    null,
  );
  const [history, setHistory] = useState<Review[] | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [listError, setListError] = useState("");
  const [message, setMessage] = useState("");

  async function loadSets() {
    setListError("");
    try {
      const result = await api<{ items: SetOption[] }>("/api/v1/admin/sets");
      setSets(result.items);
    } catch (cause) {
      setSets(null);
      setListError(describeError(cause));
    }
  }
  useEffect(() => {
    void loadSets();
  }, []);
  function choose(id: string) {
    setSelected(id);
    setLoadedId("");
    setPreview(null);
    setHistory(null);
    setConfirmed(false);
    setRevokeConfirm({});
    setError("");
    setHistoryError("");
    setMessage("");
  }
  async function load() {
    if (!selected || busy) return;
    const id = selected;
    setBusy("load");
    setLoadedId(id);
    setPreview(null);
    setHistory(null);
    setConfirmed(false);
    setRevokeConfirm({});
    setError("");
    setHistoryError("");
    setMessage("");
    const [a, b] = await Promise.allSettled([
      api<{ snapshot: Snapshot; snapshot_hash: string }>(`${setPath(id)}/member-review`),
      api<{ items: Review[] }>(`${setPath(id)}/member-reviews`),
    ]);
    if (a.status === "fulfilled") setPreview(a.value);
    else setError(describeError(a.reason));
    if (b.status === "fulfilled") setHistory(b.value.items);
    else setHistoryError(describeError(b.reason));
    setBusy("");
  }
  async function approve() {
    if (!preview || !confirmed || busy) return;
    setBusy("approve");
    setError("");
    setMessage("");
    try {
      await api(`${setPath(loadedId)}/member-review`, {
        method: "POST",
        body: { snapshotHash: preview.snapshot_hash },
      });
      setPreview(null);
      setConfirmed(false);
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
    if (busy || review.revoked_at || !revokeConfirm[review.id]) return;
    setBusy(`revoke-${review.id}`);
    setHistoryError("");
    setMessage("");
    try {
      await api(`/api/v1/admin/member-set-releases/${encodeURIComponent(review.id)}/revoke`, {
        method: "POST",
      });
      setPreview(null);
      setConfirmed(false);
      setHistory(null);
      setRevokeConfirm({});
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
        <p className="eyebrow">Member set releases</p>
        <h2 className="display-sm mt-2 text-3xl">Review a member set.</h2>
        <p className="mt-3 max-w-2xl text-sm text-[var(--muted)]">
          Review applies only to the current Bot, <strong>{tenantSlug}</strong>. Only its current
          owner can review, using a recent passkey or MFA session. No review is recorded until you
          submit it.
        </p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Players see a neutral set label, reward and progress. Private or other Bots’ collections
          are not eligible.
        </p>
      </header>
      <section className="surface-flat grid gap-3 p-5" aria-labelledby="choose-member-set">
        <h3 id="choose-member-set" className="font-semibold">
          Choose a set
        </h3>
        {listError ? (
          <div className="error-box" role="alert">
            {listError}
          </div>
        ) : null}
        {sets?.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No sets are available in this Bot workspace.
          </p>
        ) : null}
        {sets?.length ? (
          <div className="field">
            <label className="label" htmlFor="member-review-set">
              Set
            </label>
            <Select
              id="member-review-set"
              value={selected}
              onChange={(event) => choose(event.target.value)}
              disabled={Boolean(busy)}
            >
              <option value="">Choose a set</option>
              {sets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name} · version {set.version} · {set.status}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void load()} disabled={!selected || Boolean(busy)}>
            {busy === "load" ? "Loading…" : "Load review"}
          </Button>
          <Button variant="secondary" onClick={() => void loadSets()} disabled={Boolean(busy)}>
            Reload sets
          </Button>
        </div>
      </section>
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
        <section className="surface-flat p-5" aria-labelledby="member-review-title">
          <p className="eyebrow">Snapshot to review</p>
          <h3 id="member-review-title" className="display-sm mt-2 text-2xl">
            {sets?.find((set) => set.id === loadedId)?.name ?? "Selected set"}
          </h3>
          <p className="mt-2 text-sm text-[var(--muted)]">
            The display name above is for your workspace. Players receive a neutral set label.
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="studio-stat__label">Set ID / version</dt>
              <dd className="break-all">
                {preview.snapshot.id} · {preview.snapshot.version}
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
                <ul className="mt-2 grid gap-1">
                  {preview.snapshot.collections
                    .filter((row) => row[0] === id)
                    .map(
                      ([
                        ,
                        collectionId,
                        collectionName,
                        scope,
                        owner,
                        status,
                        audience,
                        approved,
                        archived,
                      ]) => (
                        <li key={collectionId} className="text-xs break-words text-[var(--muted)]">
                          {collectionName} · {scope} · {audience} · {status}
                          <span className="block break-words">
                            ID {collectionId} · owner {owner ?? "none"} · public approval{" "}
                            {approved ?? "none"} · archived {archived ?? "no"}
                          </span>
                        </li>
                      ),
                    )}
                </ul>
              </li>
            ))}
          </ol>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium">Technical snapshot hash</summary>
            <p className="mt-2 font-mono text-xs break-all">{preview.snapshot_hash}</p>
          </details>
          <p className="mt-4 text-sm text-[var(--muted)]">
            The server rechecks the roster, collections and reward when you submit. Later changes
            can invalidate this review.
          </p>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={Boolean(busy)}
            />
            <span>
              I have reviewed this exact roster, its collection audiences and the reward for this
              Bot’s members.
            </span>
          </label>
          <div className="mt-4">
            <Button onClick={() => void approve()} disabled={Boolean(busy) || !confirmed}>
              {busy === "approve" ? "Recording…" : "Record member-set review"}
            </Button>
          </div>
        </section>
      ) : null}
      {loadedId ? (
        <section className="surface-flat p-5" aria-labelledby="member-history-title">
          <h3 id="member-history-title" className="display-sm text-2xl">
            Review history
          </h3>
          <p className="mt-2 text-sm text-[var(--muted)]">
            A record that has not been revoked is not necessarily current; later roster or audience
            changes can invalidate it. Existing claims remain recorded.
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
                <p className="mt-2 text-xs break-all text-[var(--muted)]">
                  {review.id} · {review.reviewed_at}
                </p>
                {review.revoked_at ? (
                  <p className="mt-2 text-sm">Revoked {review.revoked_at}</p>
                ) : (
                  <>
                    <label className="mt-4 flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(revokeConfirm[review.id])}
                        onChange={(event) =>
                          setRevokeConfirm((current) => ({
                            ...current,
                            [review.id]: event.target.checked,
                          }))
                        }
                        disabled={Boolean(busy)}
                      />
                      <span>Revoke this recorded member-set review.</span>
                    </label>
                    <Button
                      className="mt-3"
                      variant="secondary"
                      onClick={() => void revoke(review)}
                      disabled={Boolean(busy) || !revokeConfirm[review.id]}
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
