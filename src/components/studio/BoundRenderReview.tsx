"use client";

import { useEffect, useState } from "react";
import { api, apiPath, ApiClientError, describeError } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { clearRecyclePending, readRecyclePending, reserveRecyclePending } from "@/lib/recycle-pending";

type Manifest = {
  collectionId: string;
  cardId: string;
  variantId: string;
  editionId: string;
  editionName: string;
  recipeId: string;
  recipeVersion: number;
  cardVersion: number;
  metadata: {
    name: string;
    subtitle: string;
    setName: string;
    serial: string;
    material: string;
    effect: string;
  };
  [key: string]: unknown;
};
type Snapshot = {
  manifest: Manifest;
  manifestSha256: string;
  attempt: number;
  front: { sha256: string; mime: string };
  back: { sha256: string; mime: string };
};
type Loaded = { jobId: string; snapshot: Snapshot; frontUrl: string; backUrl: string };
type Pending = {
  jobId: string;
  attempt: number;
  body: {
    decision: "approved" | "rejected";
    manifestSha256: string;
    frontSha256: string;
    backSha256: string;
    note: string;
  };
};
const pathFor = (id: string) => `/api/v1/admin/bound-renders/${encodeURIComponent(id)}`;
const hashPattern = /^[a-f0-9]{64}$/;

async function verifiedImage(
  path: string,
  expected: { sha256: string; mime: string },
): Promise<string> {
  if (
    !hashPattern.test(expected.sha256) ||
    !["image/png", "image/jpeg", "image/webp"].includes(expected.mime)
  )
    throw new Error("The preview details are invalid. Load the render again.");
  const response = await fetch(apiPath(path), { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("A preview could not be loaded. Load the render again.");
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > 8 * 1024 * 1024 || blob.type.split(";")[0] !== expected.mime)
    throw new Error("A preview has an unexpected size or type. Load the render again.");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== expected.sha256)
    throw new Error("The preview changed while loading. Load the render again.");
  return URL.createObjectURL(blob);
}

export default function BoundRenderReview({environment,accountId,botId}:{environment:string;accountId:string;botId:string}) {
  const [jobId, setJobId] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [seen, setSeen] = useState({ front: false, back: false });
  const [detailsOpened, setDetailsOpened] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const recoveryScope = JSON.stringify(['render-review',environment,accountId,botId]);
  const requestKey = (request: Pending) => JSON.stringify([request.jobId,request.attempt,request.body.manifestSha256,request.body.frontSha256,request.body.backSha256,request.body.decision,request.body.note]);
  useEffect(() => {
    let active = true;
    setRecoveryReady(false);
    setPending(null);
    setJobId('');
    setError('');
    void readRecyclePending<Pending>(recoveryScope).then((saved) => {
      if (!active) return;
      if (saved) {
        const request = saved.preview;
        if (!request || !/^[A-Za-z0-9_-]{1,200}$/.test(request.jobId) || !Number.isSafeInteger(request.attempt) || request.attempt < 1 ||
          !['approved','rejected'].includes(request.body?.decision) || !hashPattern.test(request.body?.manifestSha256 ?? '') ||
          !hashPattern.test(request.body?.frontSha256 ?? '') || !hashPattern.test(request.body?.backSha256 ?? '') ||
          typeof request.body?.note !== 'string' || request.body.note.length > 2000 || saved.key !== requestKey(request))
          throw new Error('Saved review recovery is invalid. Contact an administrator before recording another decision.');
        setPending(request);
        setJobId(request.jobId);
      }
      setRecoveryReady(true);
    }).catch(() => { if (active) setError('Review recovery storage is unavailable or invalid. Restore access before recording another decision.'); });
    return () => { active = false; };
  }, [recoveryScope]);
  useEffect(
    () => () => {
      if (loaded) {
        URL.revokeObjectURL(loaded.frontUrl);
        URL.revokeObjectURL(loaded.backUrl);
      }
    },
    [loaded],
  );
  function clear() {
    setLoaded(null);
    setSeen({ front: false, back: false });
    setDetailsOpened(false);
    setConfirmed(false);
  }
  async function load() {
    if (pending) return;
    const id = jobId.trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      setError("Enter the render job ID supplied by your operator.");
      return;
    }
    setBusy("load");
    setError("");
    setMessage("");
    clear();
    let frontUrl = "",
      backUrl = "";
    try {
      const snapshot = await api<Snapshot>(`${pathFor(id)}/review`);
      if (!hashPattern.test(snapshot.manifestSha256))
        throw new Error("The manifest digest is invalid. Load the render again.");
      frontUrl = await verifiedImage(`${pathFor(id)}/preview/front`, snapshot.front);
      backUrl = await verifiedImage(`${pathFor(id)}/preview/back`, snapshot.back);
      setLoaded({ jobId: id, snapshot, frontUrl, backUrl });
      frontUrl = "";
      backUrl = "";
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      if (frontUrl) URL.revokeObjectURL(frontUrl);
      if (backUrl) URL.revokeObjectURL(backUrl);
      setBusy("");
    }
  }
  async function decide(decision: "approved" | "rejected") {
    if (!recoveryReady || !loaded || pending || !confirmed || !seen.front || !seen.back || !detailsOpened || busy)
      return;
    const { snapshot, jobId: id } = loaded;
    const request: Pending = {
      jobId: id,
      attempt: snapshot.attempt,
      body: {
        decision,
        manifestSha256: snapshot.manifestSha256,
        frontSha256: snapshot.front.sha256,
        backSha256: snapshot.back.sha256,
        note,
      },
    };
    try {
      const saved = await reserveRecyclePending(recoveryScope, {key:requestKey(request),preview:request});
      setPending(saved.pending.preview);
      if (!saved.created) {
        setError('Another review decision is awaiting recovery. Retry that decision first.');
        return;
      }
      await sendDecision(request);
    } catch {
      setError('Recovery storage is unavailable. No review was sent; restore storage before trying again.');
    }
  }
  async function sendDecision(request: Pending, recovering = false) {
    if (busy) return;
    setBusy(request.body.decision);
    setError("");
    setMessage("");
    try {
      const receipt = await api<{
        id: string;
        attempt: number;
        decision: string;
        reviewId: string;
      }>(`${pathFor(request.jobId)}/review`, {
        method: "POST",
        body: request.body,
      });
      if (
        receipt.id !== request.jobId ||
        receipt.attempt !== request.attempt ||
        receipt.decision !== request.body.decision ||
        typeof receipt.reviewId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(receipt.reviewId)
      )
        throw new Error("The review receipt could not be confirmed.");
      await clearRecyclePending(recoveryScope,requestKey(request));
      setPending(null);
      clear();
      setNote("");
      setMessage(
        `Review ${request.body.decision === "approved" ? "approved" : "rejected"}. This records a decision; it does not publish the card.`,
      );
    } catch (cause) {
      if (!recovering && cause instanceof ApiClientError && cause.status === 409 && cause.code !== 'render_review_receipt_pending') {
        try {
          await clearRecyclePending(recoveryScope,requestKey(request));
          setPending(null);
          clear();
          setError(`${describeError(cause)} Load the render again before reviewing.`);
        } catch {
          setError('The review was not accepted, but recovery storage could not be updated. Retry the same decision after restoring storage.');
        }
      } else {
        setError(
          `The review outcome could not be confirmed. Retry the same decision. ${describeError(cause)}`,
        );
      }
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="space-y-6" aria-labelledby="render-review-heading">
      <div className="studio-rule">
        <div>
          <p className="eyebrow">Studio · creative review</p>
          <h2 id="render-review-heading" className="display-sm text-4xl">
            Review a rendered card
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
            Inspect the exact front, back and render inputs before recording a decision. Recording a
            review does not publish the card.
          </p>
        </div>
      </div>
      <div className="surface-flat max-w-3xl space-y-4 p-5">
        <label htmlFor="render-job" className="block text-sm font-semibold">
          Render job ID
        </label>
        <p className="text-sm text-[var(--muted)]">
          Enter the ID supplied by your render operator.
        </p>
        <div className="flex flex-wrap gap-3">
          <Input
            id="render-job"
            value={jobId}
            disabled={!recoveryReady || Boolean(busy) || Boolean(pending)}
            onChange={(e) => {
              setJobId(e.target.value);
              clear();
              setError("");
              setMessage("");
            }}
            className="min-w-0 flex-1"
          />
          <Button onClick={load} disabled={!recoveryReady || Boolean(busy) || Boolean(pending)}>
            {busy === "load" ? "Loading…" : "Load render"}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="surface-flat max-w-3xl space-y-3 p-5">
          <p className="text-sm">
            A review decision needs confirmation. Retry the same decision on this browser.
          </p>
          <p className="text-sm font-semibold">{pending.body.decision === 'approved' ? 'Approve' : 'Reject'} · <span className="break-all">{pending.jobId}</span> · attempt {pending.attempt}</p>
          <details className="text-sm">
            <summary className="cursor-pointer font-semibold">Pending decision details</summary>
            <p className="mt-2 whitespace-pre-wrap break-words">Note: {pending.body.note || 'None'}</p>
            <p className="mt-2 break-all text-xs">Manifest: {pending.body.manifestSha256}<br />Front: {pending.body.frontSha256}<br />Back: {pending.body.backSha256}</p>
          </details>
          <Button
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() => void sendDecision(pending, true)}
          >
            {busy ? "Checking…" : "Retry same decision"}
          </Button>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {loaded ? (
        <>
          <div className="surface-flat p-5">
            <p className="eyebrow">
              Attempt {loaded.snapshot.attempt} · {loaded.snapshot.manifest.metadata.serial}
            </p>
            <h3 className="display-sm mt-2 text-3xl">{loaded.snapshot.manifest.metadata.name}</h3>
            <p className="mt-2 text-sm text-[var(--muted)]">
              {loaded.snapshot.manifest.editionName} · {loaded.snapshot.manifest.metadata.material}{" "}
              · {loaded.snapshot.manifest.metadata.effect}
            </p>
            <p className="mt-3 text-sm">
              Collection: {loaded.snapshot.manifest.metadata.setName}{" "}
              <span className="text-[var(--muted)]">({loaded.snapshot.manifest.collectionId})</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed">
              {loaded.snapshot.manifest.metadata.serial === "PUBLIC SHOWCASE"
                ? "Approving a public-showcase render requires a current human Super Admin with recent passkey or MFA authentication. Scoped creative reviewers may inspect or reject it."
                : "This is a scoped creative review. Access is checked for every linked collection."}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["front", "back"] as const).map((side) => (
              <figure className="surface-flat p-3" key={side}>
                <figcaption className="mb-2 text-sm font-semibold capitalize">{side}</figcaption>
                <img
                  className="mx-auto h-auto w-full max-w-sm"
                  src={side === "front" ? loaded.frontUrl : loaded.backUrl}
                  alt={`${side} of ${loaded.snapshot.manifest.metadata.name}`}
                  onLoad={() => setSeen((current) => ({ ...current, [side]: true }))}
                  onError={() => {
                    clear();
                    setError("An image could not be displayed. Load the render again.");
                  }}
                />
              </figure>
            ))}
          </div>
          <details
            className="surface-flat p-5"
            onToggle={(e) => {
              if (e.currentTarget.open) setDetailsOpened(true);
            }}
          >
            <summary className="cursor-pointer font-semibold">
              Exact render manifest and digests
            </summary>
            <p className="mt-3 text-xs break-all">
              Manifest SHA-256: {loaded.snapshot.manifestSha256}
              <br />
              Front SHA-256: {loaded.snapshot.front.sha256}
              <br />
              Back SHA-256: {loaded.snapshot.back.sha256}
            </p>
            <pre className="mt-4 max-h-96 overflow-auto text-xs break-all whitespace-pre-wrap">
              {JSON.stringify(loaded.snapshot.manifest, null, 2)}
            </pre>
          </details>
          <div className="surface-flat max-w-3xl space-y-4 p-5">
            <label htmlFor="render-note" className="block text-sm font-semibold">
              Review note <span className="font-normal text-[var(--muted)]">(optional)</span>
            </label>
            <Textarea
              id="render-note"
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={Boolean(busy) || Boolean(pending)}
            />
            {!detailsOpened ? (
              <p className="text-sm text-[var(--muted)]">
                Open the manifest above before confirming your review.
              </p>
            ) : null}
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={
                  Boolean(busy) || Boolean(pending) || !seen.front || !seen.back || !detailsOpened
                }
              />
              <span>I inspected both displayed sides and the render details above.</span>
            </label>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => void decide("approved")}
                disabled={
                  !confirmed || !seen.front || !seen.back || Boolean(busy) || Boolean(pending)
                }
              >
                {busy === "approved" ? "Recording…" : "Approve render"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void decide("rejected")}
                disabled={
                  !confirmed || !seen.front || !seen.back || Boolean(busy) || Boolean(pending)
                }
              >
                {busy === "rejected" ? "Recording…" : "Reject render"}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
