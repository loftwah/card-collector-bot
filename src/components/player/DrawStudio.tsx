"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowRight, Eye, EyeOff, RotateCcw, Sparkles } from "lucide-react";
import { ApiClientError, api, describeError, idempotencyKey } from "@/lib/client";
import { Button } from "../ui/button";
import ShareLinkButton from "./ShareLinkButton";
import { cn, pct, printTitle as editionPrintTitle } from "@/lib/utils";
import {
  canDraw,
  clearForeignOperations,
  classifyDrawFailure,
  createDrawOperation,
  drawScopeKey,
  findRecoverableOperation,
  initialDrawStudioState,
  isLockedPhase,
  normaliseChannel,
  operationBody,
  operationOf,
  operationPayload,
  receiptOf,
  reduceDrawStudio,
  removeOperation,
  revealDelayMs,
  saveOperation,
  withOperationStatus,
  type DrawFailure,
  type DrawOperation,
  type DrawPhase,
  type DrawPool,
  type DrawPreview,
  type DrawReceipt,
  type DrawScope,
  type DrawStudioState,
  type OperationStorage,
  type PreviewChange,
  type PreviewTarget,
} from "./draw-studio-state";

const SIGN_IN_HREF = "/login?next=%2Fplay%2Fdraw";

function browserStorage(): OperationStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function initialSelection(pools: DrawPool[], initialPool: string): PreviewTarget {
  const pool = pools.find((item) => item.slug === initialPool) ?? pools[0];
  return { pool: pool?.slug ?? "", channel: "" };
}

function previewMatchesSelection(preview: DrawPreview, selection: PreviewTarget): boolean {
  return (
    preview.pool.slug === selection.pool &&
    normaliseChannel(preview.filters.channel_key) === selection.channel
  );
}

function isDrawPreview(value: unknown): value is DrawPreview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Partial<DrawPreview>;
  return (
    typeof preview.pool?.slug === "string" &&
    typeof preview.expected_revision === "number" &&
    typeof preview.distribution_fingerprint === "string" &&
    typeof preview.price === "number" &&
    typeof preview.eligible_count === "number" &&
    Array.isArray(preview.entries) &&
    Boolean(preview.filters) &&
    typeof preview.currency?.name === "string" &&
    typeof preview.currency?.symbol === "string"
  );
}

function isDrawReceipt(value: unknown): value is DrawReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<DrawReceipt>;
  return (
    typeof receipt.draw_id === "string" &&
    typeof receipt.instance_id === "string" &&
    typeof receipt.card_name === "string" &&
    typeof receipt.variant_name === "string" &&
    typeof receipt.serial === "string" &&
    typeof receipt.price === "number" &&
    typeof receipt.probability_bps === "number" &&
    typeof receipt.pool_revision === "number" &&
    typeof receipt.replayed === "boolean" &&
    typeof receipt.new_subject === "boolean" &&
    typeof receipt.new_finish === "boolean" &&
    typeof receipt.owned_copies === "number" &&
    typeof receipt.random_commitment === "string"
  );
}

function receiptBalance(receipt: DrawReceipt): number | undefined {
  return receipt.current_balance ?? receipt.balance_after ?? receipt.balance_after_debit;
}

function failureFrom(
  cause: unknown,
  timedOut: boolean,
  timeoutMessage = "The receipt check timed out. We will not start another opening; check again when the connection returns.",
): DrawFailure {
  if (timedOut) {
    return {
      kind: "unknown",
      message: timeoutMessage,
      retryable: true,
    };
  }
  if (cause instanceof ApiClientError) {
    return classifyDrawFailure({
      status: cause.status,
      code: cause.code,
      message: describeError(cause),
    });
  }
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return {
      kind: "unknown",
      message:
        "The opening was interrupted before the receipt arrived. Check again before drawing.",
      retryable: true,
    };
  }
  return classifyDrawFailure({ message: describeError(cause) });
}

function drawLabel(state: DrawStudioState): string {
  const { phase, preview } = state;
  switch (phase.status) {
    case "loading":
      return "Loading odds…";
    case "ready":
      return `Draw for ✦ ${preview?.price ?? 0}`;
    case "blocked":
      switch (phase.reason) {
        case "empty_pool":
          return "No eligible cards";
        case "insufficient_funds":
          return "Not enough Foil";
        case "preview_error":
        case "no_preview":
          return "Odds unavailable";
        case "stale_preview":
          return "Review the new odds";
        case "signed_out":
          return "Sign in to continue";
        case "request_rejected":
          return "Try again";
        default:
          return "Unavailable";
      }
    case "submitting":
      return "Drawing…";
    case "unknown":
      return "Confirming opening…";
    case "reconciling":
      return "Checking receipt…";
    case "committed":
      return "Opening committed";
    case "revealed":
      return "Opening complete";
    default:
      return "Draw";
  }
}

function changedOddsCopy(change: PreviewChange, receiptKnown: boolean): string {
  const previous = `revision ${change.previousRevision} at ✦ ${change.previousPrice}`;
  const current = `revision ${change.currentRevision} at ✦ ${change.currentPrice}`;
  const distribution = change.distributionChanged
    ? " The eligible cards or their weights also changed."
    : "";
  if (receiptKnown) {
    return `Your saved request used ${previous}. The live capsule is now ${current}.${distribution} The receipt below is the committed original; open another to use the new odds.`;
  }
  return `Your saved request used ${previous}. The live capsule is now ${current}.${distribution} We will not rebind the saved request to the new odds.`;
}

function DrawReceiptPanel({
  receipt,
  phase,
  visible,
  waitingForReveal,
  revealRef,
  onShowNow,
  onReplay,
  onToggleVisible,
  onOpenAnother,
}: {
  receipt: DrawReceipt;
  phase: Extract<DrawPhase, { status: "committed" | "revealed" }>;
  visible: boolean;
  waitingForReveal: boolean;
  revealRef: RefObject<HTMLDivElement | null>;
  onShowNow: () => void;
  onReplay: () => void;
  onToggleVisible: () => void;
  onOpenAnother: () => void;
}) {
  return (
    <div
      className={cn("draw-reveal mt-5", phase.status === "revealed" && visible && "is-revealed")}
      data-stage={visible ? "revealed" : "anticipation"}
      aria-live="polite"
      tabIndex={-1}
      ref={revealRef}
    >
      <div className="draw-reveal__stage">
        <div className="draw-reveal__beam" aria-hidden="true"></div>
        <div className="draw-reveal__card">
          {receipt.render_url ? (
            <img
              src={receipt.render_url}
              alt={`${receipt.card_name} — ${
                editionPrintTitle(receipt.edition_name) ?? receipt.variant_name
              }`}
              decoding="sync"
            />
          ) : (
            <div className="card-face-fallback">Card render unavailable</div>
          )}
        </div>
        {waitingForReveal ? (
          <div className="draw-reveal__wait">
            <span>
              {phase.status === "committed"
                ? "Receipt committed. Revealing your card…"
                : "Replaying the reveal…"}
            </span>
            <button type="button" className="btn btn-secondary" onClick={onShowNow}>
              Show result now
            </button>
          </div>
        ) : null}
      </div>
      <div className="draw-reveal__receipt">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="studio-kicker">
              {receipt.replayed
                ? "Recorded result · replayed safely"
                : phase.source === "reconcile"
                  ? "Recovered draw receipt"
                  : "Committed draw receipt"}
            </p>
            <h3 className="display-sm mt-1 text-3xl uppercase">{receipt.card_name}</h3>
            <p className="text-sm text-[var(--brass)]">
              {editionPrintTitle(receipt.edition_name)
                ? `${editionPrintTitle(receipt.edition_name)} · `
                : ""}
              {receipt.variant_name} · {receipt.serial}
            </p>
          </div>
          {phase.status === "revealed" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-secondary" onClick={onReplay}>
                <RotateCcw size={14} /> Replay
              </button>
              <button type="button" className="btn btn-secondary" onClick={onToggleVisible}>
                {visible ? <EyeOff size={14} /> : <Eye size={14} />} {visible ? "Hide" : "Show"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onOpenAnother}>
                <Sparkles size={14} /> Open another
              </button>
            </div>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className={cn("badge", receipt.new_subject && "badge-signal")}>
            {receipt.new_subject ? "New subject" : `Duplicate · ${receipt.owned_copies} owned`}
          </span>
          <span className={cn("badge", receipt.new_finish && "badge-signal")}>
            {receipt.new_finish ? "New finish" : "Finish already held"}
          </span>
          <span className="badge">Opening −✦ {receipt.price}</span>
          {receipt.balance_after_debit !== undefined ? (
            <span className="badge">After debit ✦ {receipt.balance_after_debit}</span>
          ) : null}
          {(receipt.credits_total ?? 0) > 0 ? (
            <span className="badge badge-signal">Reward +✦ {receipt.credits_total}</span>
          ) : null}
          {receipt.balance_after !== undefined ? (
            <span className="badge">Settled balance ✦ {receipt.balance_after}</span>
          ) : null}
          <span className="badge">{pct(receipt.probability_bps)} shown chance</span>
        </div>
        <div
          className={cn(
            "mt-4 overflow-hidden transition-all duration-500",
            visible ? "max-h-[38rem] opacity-100" : "max-h-0 opacity-0",
          )}
          aria-hidden={!visible}
          inert={!visible}
        >
          <p className="text-sm text-[var(--muted)]">
            This exact copy was selected from pool revision {receipt.pool_revision}. The result was
            committed before this animation. A retry or reload reads the same receipt and can never
            reroll or charge twice.
          </p>
          {receipt.achievements?.length ? (
            <div className="mt-3 border border-[var(--signal)] bg-[var(--ice)]/30 p-3">
              <p className="studio-stat__label">Unlocked with this draw</p>
              <ul className="mt-1 grid gap-1 text-sm">
                {receipt.achievements.slice(0, 4).map((achievement) => (
                  <li key={achievement.id}>
                    <strong>{achievement.name}</strong>
                    {achievement.reward_state === "failed"
                      ? " · reward pending retry (not yet credited)"
                      : achievement.reward_state &&
                          achievement.reward_state !== "granted" &&
                          achievement.reward_amount > 0
                        ? " · reward not yet credited"
                        : achievement.reward_amount
                          ? ` · +${achievement.reward_amount} Foil`
                          : " · cosmetic badge"}
                  </li>
                ))}
                {receipt.achievements.length > 4 ? (
                  <li className="text-xs text-[var(--muted)]">
                    +{receipt.achievements.length - 4} more in the achievement cabinet
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
          <p className="mt-2 font-mono text-[0.56rem] break-all text-[var(--muted)]">
            draw proof {receipt.random_commitment.slice(0, 32)}…
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a className="btn btn-primary" href={`/play/card/${receipt.instance_id}`}>
              Inspect this copy <ArrowRight size={14} />
            </a>
            <ShareLinkButton
              kind="latest"
              targetId={receipt.instance_id}
              label="Share latest pull"
              size="md"
            />
          </div>
        </div>
        {!visible && phase.status === "revealed" ? (
          <p className="mt-3 text-sm text-[var(--muted)]">
            The card is already saved in your album. Show it, replay the moment, or inspect it later
            — nothing is lost.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function DrawStudio({
  pools,
  initialBalance,
  initialPool = "",
  environment,
  accountId,
  botId,
}: {
  pools: DrawPool[];
  initialBalance: number;
  initialPool?: string;
  environment: string;
  accountId: string;
  botId: string;
}) {
  const scope = useMemo<DrawScope>(
    () => ({ environment, accountId, botId }),
    [environment, accountId, botId],
  );
  const scopeKey = useMemo(() => drawScopeKey(scope), [scope]);
  const bootstrapSelection = useMemo(
    () => initialSelection(pools, initialPool),
    [pools, initialPool],
  );
  const [state, dispatch] = useReducer(
    reduceDrawStudio,
    initialDrawStudioState({
      scope,
      selection: bootstrapSelection,
      balance: initialBalance,
    }),
  );
  const [reduced, setReduced] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");

  const storageRef = useRef<OperationStorage | null>(null);
  const previewRequestRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const drawAbortRef = useRef<AbortController | null>(null);
  const reconcileAbortRef = useRef<AbortController | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const submitLockRef = useRef(false);
  const activeOperationKeyRef = useRef<string | null>(null);
  const scopeKeyRef = useRef(scopeKey);
  const reducedRef = useRef(reduced);
  const revealRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const drawButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusDrawOnReadyRef = useRef(false);

  useEffect(() => {
    scopeKeyRef.current = scopeKey;
  }, [scopeKey]);

  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  const clearRevealTimer = useCallback(() => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  const scheduleReveal = useCallback(
    (operationKey: string, replay = false) => {
      clearRevealTimer();
      const delay = revealDelayMs(reducedRef.current, replay);
      if (delay <= 0) {
        dispatch({ type: "reveal/show", scopeKey: scopeKeyRef.current, operationKey });
        return;
      }
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = null;
        dispatch({ type: "reveal/show", scopeKey: scopeKeyRef.current, operationKey });
      }, delay);
    },
    [clearRevealTimer],
  );

  const persistOperation = useCallback((operation: DrawOperation): boolean => {
    const saved = saveOperation(storageRef.current, operation);
    setStorageWarning(
      saved
        ? ""
        : "This browser could not save the recovery record. Keep this page open until the receipt is shown.",
    );
    return saved;
  }, []);

  const removePersistedOperation = useCallback((operation: DrawOperation) => {
    removeOperation(storageRef.current, operation.scope, operation.payload.pool);
    setStorageWarning("");
  }, []);

  const loadPreview = useCallback(async (target: PreviewTarget) => {
    if (!target.pool) {
      dispatch({
        type: "preview/cleared",
        scopeKey: scopeKeyRef.current,
        message: "Choose a capsule to see its exact odds.",
      });
      return;
    }

    const requestScopeKey = scopeKeyRef.current;
    const requestId = ++previewRequestRef.current;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    dispatch({
      type: "preview/requested",
      scopeKey: requestScopeKey,
      requestId,
      target,
    });

    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);

    try {
      const query = target.channel ? `?channel=${encodeURIComponent(target.channel)}` : "";
      const data = await api<DrawPreview>(
        `/api/v1/pools/${encodeURIComponent(target.pool)}${query}`,
        { signal: controller.signal },
      );
      if (requestId !== previewRequestRef.current) return;
      if (!isDrawPreview(data)) {
        throw new Error("The capsule preview could not be read. Nothing has been charged.");
      }
      if (
        data.pool.slug !== target.pool ||
        normaliseChannel(data.filters.channel_key) !== target.channel
      ) {
        throw new Error(
          "The capsule preview changed. Select the capsule again to review its odds.",
        );
      }
      dispatch({
        type: "preview/succeeded",
        scopeKey: requestScopeKey,
        requestId,
        target,
        preview: data,
      });
    } catch (cause) {
      if (requestId !== previewRequestRef.current) return;
      if (controller.signal.aborted && !timedOut) return;
      const message = timedOut
        ? "The capsule preview timed out. Nothing has been charged."
        : describeError(cause);
      dispatch({
        type: "preview/failed",
        scopeKey: requestScopeKey,
        requestId,
        target,
        message,
        authRequired:
          cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403),
      });
    } finally {
      window.clearTimeout(timeout);
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
    }
  }, []);

  const reconcile = useCallback(
    async (operation: DrawOperation, expectedScopeKey: string) => {
      if (drawScopeKey(operation.scope) !== expectedScopeKey) return;
      const requestScopeKey = drawScopeKey(operation.scope);
      activeOperationKeyRef.current = operation.key;
      const pending =
        operation.status === "committed" ? operation : withOperationStatus(operation, "unknown");
      persistOperation(pending);

      reconcileAbortRef.current?.abort();
      const controller = new AbortController();
      reconcileAbortRef.current = controller;
      dispatch({
        type: "reconcile/started",
        scopeKey: requestScopeKey,
        operation: pending,
      });

      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 20_000);

      try {
        const data = await api<DrawReceipt>("/api/v1/draws", {
          method: "POST",
          body: operationBody(operation),
          idempotencyKey: operation.key,
          signal: controller.signal,
        });
        if (controller.signal.aborted && !timedOut) return;
        if (activeOperationKeyRef.current !== operation.key) return;
        if (!isDrawReceipt(data)) {
          throw new Error(
            "The receipt could not be read. The opening may have committed; check again before drawing.",
          );
        }
        const committed = withOperationStatus(operation, "committed");
        persistOperation(committed);
        dispatch({
          type: "draw/committed",
          scopeKey: requestScopeKey,
          operation: committed,
          receipt: data,
          source: "reconcile",
          balance: receiptBalance(data),
        });
        scheduleReveal(operation.key);
        void loadPreview({
          pool: operation.payload.pool,
          channel: operation.payload.channelKey,
        });
      } catch (cause) {
        if (controller.signal.aborted && !timedOut) return;
        if (activeOperationKeyRef.current !== operation.key) return;
        const failure = failureFrom(cause, timedOut);
        if (failure.kind === "aborted") return;

        if (failure.kind === "auth") {
          // A session may expire after a committed draw. Keep the operation so
          // signing in again can read the same receipt without a new key.
          dispatch({
            type: "reconcile/unknown",
            scopeKey: requestScopeKey,
            operation: pending,
            reason: "signed_out",
            message: failure.message,
            retryable: true,
          });
          return;
        }

        if (failure.kind === "conflict") {
          dispatch({
            type: "reconcile/unknown",
            scopeKey: requestScopeKey,
            operation: pending,
            reason: "conflict",
            message: failure.message,
            retryable: false,
          });
          return;
        }

        if (failure.kind === "unknown") {
          dispatch({
            type: "reconcile/unknown",
            scopeKey: requestScopeKey,
            operation: pending,
            reason: "lost",
            message: failure.message,
            retryable: failure.retryable,
          });
          return;
        }

        // A definitive rejection is proof that no receipt was committed for
        // this key. It is safe to release the saved request.
        activeOperationKeyRef.current = null;
        removePersistedOperation(operation);
        dispatch({
          type: "reconcile/rejected",
          scopeKey: requestScopeKey,
          operationKey: operation.key,
          reason: failure.reason,
          message: failure.message,
        });
        void loadPreview({
          pool: operation.payload.pool,
          channel: operation.payload.channelKey,
        });
      } finally {
        window.clearTimeout(timeout);
        if (reconcileAbortRef.current === controller) reconcileAbortRef.current = null;
      }
    },
    [loadPreview, persistOperation, removePersistedOperation, scheduleReveal],
  );

  const draw = useCallback(
    async (current: DrawStudioState, expectedScopeKey: string) => {
      if (submitLockRef.current || activeOperationKeyRef.current) return;
      if (!canDraw(current) || !current.preview) return;
      if (drawScopeKey(current.scope) !== expectedScopeKey) return;

      const requestScopeKey = drawScopeKey(current.scope);
      const operation = createDrawOperation({
        scope: current.scope,
        key: idempotencyKey("draw"),
        payload: operationPayload(current.preview, current.selection.channel),
      });
      submitLockRef.current = true;
      activeOperationKeyRef.current = operation.key;
      // Persist before the request leaves the browser. A reload from this point
      // must find the same key and the same canonical payload.
      persistOperation(operation);
      dispatch({ type: "draw/started", scopeKey: requestScopeKey, operation });

      drawAbortRef.current?.abort();
      const controller = new AbortController();
      drawAbortRef.current = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 20_000);

      try {
        const data = await api<DrawReceipt>("/api/v1/draws", {
          method: "POST",
          body: operationBody(operation),
          idempotencyKey: operation.key,
          signal: controller.signal,
        });
        if (controller.signal.aborted && !timedOut) return;
        if (activeOperationKeyRef.current !== operation.key) return;
        if (!isDrawReceipt(data)) {
          throw new Error(
            "The receipt could not be read. The opening may have committed; check again before drawing.",
          );
        }
        const committed = withOperationStatus(operation, "committed");
        persistOperation(committed);
        dispatch({
          type: "draw/committed",
          scopeKey: requestScopeKey,
          operation: committed,
          receipt: data,
          source: "submit",
          balance: receiptBalance(data),
        });
        void loadPreview({
          pool: operation.payload.pool,
          channel: operation.payload.channelKey,
        });
        scheduleReveal(operation.key);
      } catch (cause) {
        if (controller.signal.aborted && !timedOut) return;
        if (activeOperationKeyRef.current !== operation.key) return;
        const failure = failureFrom(
          cause,
          timedOut,
          "The opening timed out before the receipt arrived. Nothing new was charged; check again before drawing.",
        );
        if (failure.kind === "aborted") return;

        if (failure.kind === "unknown" || failure.kind === "conflict") {
          const uncertain = withOperationStatus(operation, "unknown");
          persistOperation(uncertain);
          dispatch({
            type: "draw/unknown",
            scopeKey: requestScopeKey,
            operation: uncertain,
            reason: failure.kind === "conflict" ? "conflict" : "lost",
            message: failure.message,
            retryable: failure.kind === "unknown" ? failure.retryable : false,
          });
          return;
        }

        // Authentication and definitive 4xx responses happen before the D1
        // batch, so there is no receipt to recover for this key.
        activeOperationKeyRef.current = null;
        removePersistedOperation(operation);
        dispatch({
          type: "draw/rejected",
          scopeKey: requestScopeKey,
          operationKey: operation.key,
          reason: failure.kind === "auth" ? "signed_out" : failure.reason,
          message: failure.message,
        });
        // Keep the draw-level sign-in prompt visible. Refreshing a public
        // preview must not erase the stronger action's auth requirement.
        if (failure.kind !== "auth") {
          void loadPreview({
            pool: operation.payload.pool,
            channel: operation.payload.channelKey,
          });
        }
      } finally {
        submitLockRef.current = false;
        window.clearTimeout(timeout);
        if (drawAbortRef.current === controller) drawAbortRef.current = null;
      }
    },
    [loadPreview, persistOperation, removePersistedOperation, scheduleReveal],
  );

  const checkAgain = useCallback(
    (current: DrawStudioState, expectedScopeKey: string) => {
      const operation = operationOf(current.phase);
      if (operation) void reconcile(operation, expectedScopeKey);
    },
    [reconcile],
  );

  const retryPreview = useCallback(
    (target: PreviewTarget) => {
      focusDrawOnReadyRef.current = true;
      void loadPreview(target);
    },
    [loadPreview],
  );

  const openAnother = useCallback(
    (current: DrawStudioState) => {
      if (current.phase.status !== "revealed") return;
      activeOperationKeyRef.current = null;
      removePersistedOperation(current.phase.operation);
      focusDrawOnReadyRef.current = true;
      dispatch({ type: "operation/reset", scopeKey: drawScopeKey(current.scope) });
      void loadPreview(current.selection);
    },
    [loadPreview, removePersistedOperation],
  );

  const replayReveal = useCallback(
    (current: DrawStudioState) => {
      if (current.phase.status !== "revealed") return;
      clearRevealTimer();
      dispatch({
        type: "reveal/replay",
        scopeKey: drawScopeKey(current.scope),
        operationKey: current.phase.operation.key,
      });
      scheduleReveal(current.phase.operation.key, true);
    },
    [clearRevealTimer, scheduleReveal],
  );

  const showNow = useCallback(
    (current: DrawStudioState) => {
      if (
        current.phase.status !== "committed" &&
        !(current.phase.status === "revealed" && current.phase.replaying)
      ) {
        return;
      }
      clearRevealTimer();
      dispatch({
        type: "reveal/show",
        scopeKey: drawScopeKey(current.scope),
        operationKey: current.phase.operation.key,
      });
    },
    [clearRevealTimer],
  );

  const setVisible = useCallback(
    (current: DrawStudioState, visible: boolean) => {
      if (current.phase.status !== "revealed") return;
      clearRevealTimer();
      dispatch({
        type: visible ? "reveal/show" : "reveal/hide",
        scopeKey: drawScopeKey(current.scope),
        operationKey: current.phase.operation.key,
      });
    },
    [clearRevealTimer],
  );

  const choosePool = useCallback((current: DrawStudioState, pool: string) => {
    if (isLockedPhase(current.phase)) return;
    focusDrawOnReadyRef.current = false;
    activeOperationKeyRef.current = null;
    dispatch({
      type: "selection/changed",
      scopeKey: drawScopeKey(current.scope),
      selection: { pool, channel: current.selection.channel },
    });
  }, []);

  const chooseChannel = useCallback((current: DrawStudioState, channel: string) => {
    if (isLockedPhase(current.phase)) return;
    focusDrawOnReadyRef.current = false;
    activeOperationKeyRef.current = null;
    dispatch({
      type: "selection/changed",
      scopeKey: drawScopeKey(current.scope),
      selection: { pool: current.selection.pool, channel },
    });
  }, []);

  // Recover before asking for fresh odds. The operation is keyed to the same
  // environment, account and Bot, and carries the original payload.
  useEffect(() => {
    const storage = browserStorage();
    storageRef.current = storage;
    activeOperationKeyRef.current = null;
    focusDrawOnReadyRef.current = false;
    setStorageWarning("");
    const currentScope = { environment, accountId, botId };
    const currentScopeKey = drawScopeKey(currentScope);
    scopeKeyRef.current = currentScopeKey;
    dispatch({
      type: "scope/changed",
      scopeKey: currentScopeKey,
      scope: currentScope,
      selection: bootstrapSelection,
      balance: initialBalance,
    });
    clearForeignOperations(storage, currentScope);
    const recovered = findRecoverableOperation(storage, currentScope);
    if (recovered) {
      dispatch({
        type: "recovery/found",
        scopeKey: currentScopeKey,
        operation: recovered,
      });
      void reconcile(recovered, currentScopeKey);
    }
    return () => {
      drawAbortRef.current?.abort();
      reconcileAbortRef.current?.abort();
      clearRevealTimer();
      submitLockRef.current = false;
    };
    // The scope is the recovery boundary. The initial selection and balance are
    // captured when that boundary changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    if (!state.selection.pool) {
      dispatch({
        type: "preview/cleared",
        scopeKey,
        message: "Choose a capsule to see its exact odds.",
      });
      return;
    }
    void loadPreview(state.selection);
    return () => {
      previewRequestRef.current += 1;
      previewAbortRef.current?.abort();
    };
  }, [state.selection.pool, state.selection.channel, scopeKey, loadPreview]);

  useEffect(() => {
    if (!reduced) return;
    if (
      state.phase.status === "committed" ||
      (state.phase.status === "revealed" && state.phase.replaying)
    ) {
      clearRevealTimer();
      dispatch({
        type: "reveal/show",
        scopeKey: drawScopeKey(state.scope),
        operationKey: state.phase.operation.key,
      });
    }
  }, [reduced, state.phase, state.scope, clearRevealTimer]);

  useEffect(() => {
    if (state.phase.status === "committed" || state.phase.status === "revealed") {
      revealRef.current?.focus({ preventScroll: true });
    }
    if (state.phase.status === "unknown" || state.phase.status === "reconciling") {
      statusRef.current?.focus({ preventScroll: true });
    }
  }, [state.phase.status]);

  useEffect(() => {
    if (state.phase.status === "ready" && focusDrawOnReadyRef.current) {
      focusDrawOnReadyRef.current = false;
      drawButtonRef.current?.focus({ preventScroll: true });
    }
  }, [state.phase.status]);

  useEffect(() => {
    if (state.phase.status === "revealed") {
      removePersistedOperation(state.phase.operation);
    }
    if (state.phase.status !== "committed" && state.phase.status !== "revealed") {
      clearRevealTimer();
    }
  }, [state.phase, clearRevealTimer, removePersistedOperation]);

  useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-foil-balance]").forEach((node) => {
      // The site header says "7000 Foil"; the draw and album cards use the
      // glyph. Keep each surface's existing notation instead of flattening it.
      node.textContent = (node.textContent ?? "").includes("Foil")
        ? `${state.balance} Foil`
        : `✦ ${state.balance}`;
    });
  }, [state.balance]);

  useEffect(() => {
    return () => {
      clearRevealTimer();
      previewAbortRef.current?.abort();
      drawAbortRef.current?.abort();
      reconcileAbortRef.current?.abort();
    };
  }, [clearRevealTimer]);

  const preview =
    state.preview && previewMatchesSelection(state.preview, state.selection) ? state.preview : null;
  const sortedEntries = useMemo(
    () =>
      preview ? [...preview.entries].sort((a, b) => b.probability_bps - a.probability_bps) : [],
    [preview],
  );
  const cardCount = useMemo(
    () => new Set(preview?.entries.map((entry) => entry.card_id) ?? []).size,
    [preview],
  );
  const operation = operationOf(state.phase);
  const receipt = receiptOf(state.phase);
  const locked = isLockedPhase(state.phase);
  const empty = preview ? preview.eligible_count === 0 : false;
  const selectedPool = pools.find((pool) => pool.slug === state.selection.pool) ?? null;
  const showRecoveryOption =
    Boolean(state.selection.pool) && !pools.some((pool) => pool.slug === state.selection.pool);
  const visible = state.phase.status === "revealed" && state.phase.visible;
  const waitingForReveal =
    state.phase.status === "committed" ||
    (state.phase.status === "revealed" && state.phase.replaying);
  const previewError =
    state.phase.status === "blocked" &&
    (state.phase.reason === "preview_error" ||
      state.phase.reason === "no_preview" ||
      state.phase.reason === "signed_out" ||
      state.phase.reason === "request_rejected" ||
      state.phase.reason === "stale_preview");
  const previewBlocked =
    state.phase.status === "blocked" && state.phase.reason === "insufficient_funds";
  const receiptPhase =
    state.phase.status === "committed" || state.phase.status === "revealed" ? state.phase : null;
  const receiptPanel =
    receipt && receiptPhase ? (
      <DrawReceiptPanel
        receipt={receipt}
        phase={receiptPhase}
        visible={visible}
        waitingForReveal={waitingForReveal}
        revealRef={revealRef}
        onShowNow={() => showNow(state)}
        onReplay={() => replayReveal(state)}
        onToggleVisible={() => setVisible(state, !visible)}
        onOpenAnother={() => openAnother(state)}
      />
    ) : null;

  if (!pools.length && !operation) {
    return (
      <div className="empty">
        <p>
          No capsule is available for your account right now. A Bot Admin may have disabled the
          relevant collection, or your collection preferences may hide every eligible card. Check
          Preferences, then reload. Nothing can be charged while no capsule is available.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
      <aside className="grid gap-4">
        <div className="surface-flat p-5">
          <label className="field">
            <span className="label">Choose a capsule</span>
            <select
              className="select"
              value={state.selection.pool}
              onChange={(event) => choosePool(state, event.target.value)}
              aria-label="Choose a capsule"
              disabled={locked}
            >
              <optgroup label="Everyday">
                {pools
                  .filter((pool) => pool.slug === "cabinet-draw")
                  .map((pool) => (
                    <option key={pool.id} value={pool.slug}>
                      {pool.name} · ✦ {pool.price}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Collections">
                {pools
                  .filter((pool) => pool.slug !== "cabinet-draw")
                  .map((pool) => (
                    <option key={pool.id} value={pool.slug}>
                      {pool.name} · ✦ {pool.price}
                    </option>
                  ))}
              </optgroup>
              {showRecoveryOption ? (
                <optgroup label={operation ? "Recovering" : "Unavailable"}>
                  <option value={state.selection.pool}>
                    {state.selection.pool} · {operation ? "saved opening" : "unavailable"}
                  </option>
                </optgroup>
              ) : null}
            </select>
          </label>
          {(() => {
            if (!selectedPool) {
              return operation ? (
                <div className="mt-4 border-t border-[var(--line)] pt-3">
                  <p className="font-semibold">Recovering {operation.payload.pool}</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                    This capsule is no longer in the live list. Your saved request is still checked
                    against its original receipt. Nothing new is charged.
                  </p>
                </div>
              ) : null;
            }
            return (
              <div className="mt-4 border-t border-[var(--line)] pt-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">{selectedPool.name}</p>
                  {selectedPool.eligibleCount !== undefined ? (
                    <p className="text-xs text-[var(--muted)]">
                      {selectedPool.eligibleCount} eligible card
                      {selectedPool.eligibleCount === 1 ? "" : "s"} for you
                    </p>
                  ) : null}
                  <span className="font-mono text-sm text-[var(--brass)]">
                    ✦ {selectedPool.price}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                  {selectedPool.description}
                </p>
              </div>
            );
          })()}
        </div>

        <div className="surface-flat p-5">
          <p className="eyebrow">Where you are opening</p>
          <label className="field mt-3">
            <span className="label">Community filter</span>
            <select
              value={state.selection.channel}
              onChange={(event) => chooseChannel(state, event.target.value)}
              className="select"
              disabled={locked}
            >
              <option value="">Public cabinet</option>
              <option value="family-table">Family table · hides horror-tagged cards</option>
            </select>
          </label>
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
            A community filter can only hide cards. Your own preferences can hide more. Neither
            makes the remaining cards more likely than the odds shown.
          </p>
        </div>

        <div className="border border-[var(--line)] p-5">
          <p className="eyebrow">Balance</p>
          <p className="display-sm mt-1 text-4xl text-[var(--brass)]">✦ {state.balance}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {preview ? `${preview.currency.name} · price ✦ ${preview.price}` : "Select a pool"}
          </p>
          <div className="mt-4">
            <Button
              ref={drawButtonRef}
              className="w-full"
              onClick={() => void draw(state, scopeKey)}
              disabled={!canDraw(state)}
              aria-busy={
                state.phase.status === "submitting" || state.phase.status === "reconciling"
              }
            >
              {drawLabel(state)}
            </Button>
          </div>
          <p className="mt-2 text-center font-mono text-[0.55rem] tracking-[0.1em] text-[var(--muted)] uppercase">
            Odds shown before you open · no purchase
          </p>
        </div>
      </aside>

      <div>
        {storageWarning ? (
          <div className="notice mb-5 text-sm" role="status">
            {storageWarning}
          </div>
        ) : null}

        {state.phase.status === "blocked" && previewError ? (
          <div className="error-box mb-5" role="alert" tabIndex={-1} ref={statusRef}>
            <p>{state.phase.message}</p>
            {state.notice ? <p className="mt-1 text-sm">{state.notice}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {state.phase.reason === "signed_out" ? (
                <a className="btn btn-secondary" href={SIGN_IN_HREF}>
                  Sign in to continue
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => retryPreview(state.selection)}
                >
                  Retry this capsule preview
                </button>
              )}
            </div>
          </div>
        ) : null}

        {state.phase.status === "blocked" && previewBlocked ? (
          <div className="notice mb-5 text-sm" role="status">
            {state.phase.message}
          </div>
        ) : null}

        {state.phase.status === "unknown" ? (
          <div className="error-box mb-5" role="alert" tabIndex={-1} ref={statusRef}>
            <p className="font-semibold">
              {state.phase.reason === "signed_out"
                ? "Sign in again to confirm this opening."
                : state.phase.reason === "conflict"
                  ? "This saved request needs support."
                  : "Your opening is not confirmed yet."}
            </p>
            <p className="mt-1">{state.phase.message}</p>
            <p className="mt-2 text-sm">
              {state.phase.reason === "conflict"
                ? "Do not start another opening. The same key and payload cannot be safely reconciled from this session."
                : "We kept the exact request key, capsule revision, distribution and price. Checking again cannot reroll the card or charge twice."}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {state.phase.reason === "signed_out" ? (
                <a className="btn btn-secondary" href={SIGN_IN_HREF}>
                  Sign in to recover
                </a>
              ) : null}
              {state.phase.retryable ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => checkAgain(state, scopeKey)}
                >
                  Check again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {state.phase.status === "reconciling" ? (
          <div
            className="notice mb-5 text-sm"
            role="status"
            aria-live="polite"
            tabIndex={-1}
            ref={statusRef}
          >
            <p className="font-semibold">Checking whether this opening completed…</p>
            <p className="mt-1 text-sm">
              We are replaying the original request with its saved operation key. If the receipt
              exists, it is returned unchanged; if the request never arrived, that same approved
              opening completes once. It cannot reroll the card, change the price or debit twice.
            </p>
          </div>
        ) : null}

        {state.phase.status === "submitting" ? (
          <div className="notice mb-5 text-sm" role="status" aria-live="polite">
            Committing your opening. The receipt is saved before the reveal; keep this page open if
            the connection drops.
          </div>
        ) : null}

        {state.notice &&
        state.phase.status !== "blocked" &&
        state.phase.status !== "unknown" &&
        state.phase.status !== "reconciling" ? (
          <div className="notice mb-5 text-sm" role="status">
            {state.notice}
          </div>
        ) : null}

        {state.phase.status === "loading" && !preview ? (
          <div className="skeleton h-56 w-full" aria-label="Loading pool"></div>
        ) : null}

        {!preview ? receiptPanel : null}

        {preview ? (
          <>
            <div
              className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--line)] pb-5"
              aria-busy={state.phase.status === "loading"}
            >
              <div>
                <p className="eyebrow">
                  {preview.pool.name} · revision {preview.revision}
                </p>
                <h2 className="display-sm mt-1 text-4xl">Know the odds.</h2>
                <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
                  {preview.pool.description}
                </p>
                {state.phase.status === "loading" ? (
                  <p className="mt-2 text-xs text-[var(--muted)]" role="status">
                    Refreshing the live odds…
                  </p>
                ) : null}
              </div>
              <div className="text-right">
                <p className="eyebrow">Eligible</p>
                <p className="display-sm mt-1 text-3xl">{preview.eligible_count}</p>
                <p className="text-xs text-[var(--muted)]">{cardCount} identities</p>
              </div>
            </div>

            {preview.filters.player_hidden_collection_ids.length ? (
              <div className="notice mt-4 text-sm">
                You turned off {preview.filters.player_hidden_collection_ids.length} collection
                {preview.filters.player_hidden_collection_ids.length === 1 ? "" : "s"} for your
                draws. Their cards are removed from this distribution.{" "}
                <a className="underline underline-offset-4" href="/play/preferences">
                  Change collection preferences
                </a>
                .
              </div>
            ) : null}
            {preview.filters.excluded_tags.length ? (
              <div className="notice mt-4 text-sm">
                Excluded by the active policy or your preferences:{" "}
                {preview.filters.excluded_tags.join(", ")}. The probabilities below are recalculated
                from the remaining pool.
              </div>
            ) : null}
            {preview.filters.unfiled_count > 0 ? (
              <p className="mt-3 text-xs text-[var(--muted)]">
                {preview.filters.unfiled_count} eligible card
                {preview.filters.unfiled_count === 1 ? " is" : "s are"} not filed in a collection
                and remain in the capsule. They are never silently removed by collection
                preferences.
              </p>
            ) : null}

            {state.previewChange ? (
              <div className="notice mt-4 text-sm" role="status">
                <p className="font-semibold">The odds changed while this request was saved.</p>
                <p className="mt-1">
                  {changedOddsCopy(
                    state.previewChange,
                    state.phase.status === "committed" || state.phase.status === "revealed",
                  )}
                </p>
                {state.previewChange.priceChanged ? (
                  <p className="mt-1 font-mono text-xs">
                    Price: ✦ {state.previewChange.previousPrice} → ✦{" "}
                    {state.previewChange.currentPrice}
                  </p>
                ) : null}
              </div>
            ) : null}

            {empty && !operation && !receipt ? (
              <div className="empty mt-5">
                <div>
                  <p className="display-sm text-2xl">This pool is empty for this context.</p>
                  <p className="mt-2 text-sm">
                    {preview.filters.empty_reason ?? "No eligible cards."} Nothing will be charged.
                  </p>
                </div>
              </div>
            ) : null}

            {receiptPanel}

            <div className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <p className="eyebrow">Actual chance before you open</p>
              </div>
              <div
                className="mt-3 max-h-[30rem] overflow-auto border border-[var(--line)]"
                role="region"
                aria-label="Full odds table"
                tabIndex={0}
              >
                <table className="table">
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th>Finish</th>
                      <th className="text-right">Chance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedEntries.map((entry) => (
                      <tr key={entry.variant_id}>
                        <td className="font-medium">
                          {entry.card_name}
                          {editionPrintTitle(entry.edition_name) ? (
                            <span className="block text-[0.62rem] font-normal text-[var(--brass)]">
                              {editionPrintTitle(entry.edition_name)}
                            </span>
                          ) : null}
                          {entry.collections.length ? (
                            <span className="block text-[0.62rem] font-normal text-[var(--muted)]">
                              {entry.collections.map((collection) => collection.name).join(" · ")}
                            </span>
                          ) : (
                            <span className="block text-[0.62rem] font-normal text-[var(--muted)]">
                              Unfiled
                            </span>
                          )}
                        </td>
                        <td className="text-[var(--muted)]">
                          {entry.material_key === "diamond" ? "Holographic" : entry.variant_name}
                        </td>
                        <td className="text-right font-mono text-xs">
                          {pct(entry.probability_bps)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                This is the live capsule. If it changes before you open, you will be asked to review
                the new odds. Empty pools never charge.
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--line)] pt-4 font-mono text-[0.58rem] tracking-[0.1em] text-[var(--muted)] uppercase">
              <span>
                <Sparkles
                  size={12}
                  className="mr-1 inline text-[var(--brass)]"
                  aria-hidden="true"
                />
                One capsule, one card
              </span>
              <span>Your result is saved if the connection drops</span>
              <span>No purchase or cash-out</span>
              <span>A retry never charges twice</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
