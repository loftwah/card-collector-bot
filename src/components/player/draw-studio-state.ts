/**
 * The draw room's explicit client state contract.
 *
 * The server receipt is the authority. This module only decides what the
 * player is looking at, which request is still uncertain, and which exact
 * request payload an operation key belongs to. It deliberately has no React,
 * DOM or fetch dependency so the adversarial flows can be unit-tested.
 *
 * States:
 *
 *   loading ──ready──▶ submitting ──receipt──▶ committed ──reveal──▶ revealed
 *      │                  │                                      ▲
 *      │                  ├──response lost──▶ unknown ──reconcile─┘
 *      │                  └──definitive 4xx──▶ blocked
 *      └──preview failed/empty/funds───────▶ blocked
 *
 * `reconciling` is a visible check of the original request. It is not a
 * redraw: the same operation key and the same canonical payload are replayed.
 * If a receipt exists it is returned without a second debit; if the request
 * never arrived, that same approved opening completes once.
 */

export const DRAW_STATE_VERSION = 1;
export const DRAW_OPERATION_PREFIX = "foilbury.draw.operation.v1:";

export interface DrawScope {
  environment: string;
  accountId: string;
  botId: string;
}

export interface PreviewTarget {
  pool: string;
  channel: string;
}

export interface DrawPool {
  id: string;
  slug: string;
  name: string;
  description: string;
  revision: number;
  price: number;
  status: string;
  eligibleCount?: number;
}

export interface DrawEntry {
  variant_id: string;
  card_id: string;
  card_name: string;
  edition_name: string | null;
  variant_name: string;
  material_key: string;
  effect_key: string | null;
  render_url: string | null;
  weight: number;
  probability_bps: number;
  tags: string[];
  collections: Array<{ id: string; name: string }>;
}

export interface DrawFilters {
  channel_key: string | null;
  excluded_tags: string[];
  tenant_excluded_tags: string[];
  player_excluded_tags: string[];
  player_hidden_collection_ids: string[];
  unfiled_count: number;
  empty_reason: string | null;
}

export interface DrawPreview {
  pool: DrawPool;
  revision: number;
  price: number;
  eligible_count: number;
  total_weight: number;
  entries: DrawEntry[];
  filters: DrawFilters;
  pity: string;
  currency: { name: string; symbol: string };
  expected_revision: number;
  distribution_fingerprint: string;
}

export interface DrawReceipt {
  draw_id: string;
  instance_id: string;
  card_name: string;
  edition_name: string | null;
  variant_name: string;
  render_url: string | null;
  serial: string;
  new_subject: boolean;
  new_finish: boolean;
  owned_copies: number;
  price: number;
  balance_after?: number;
  balance_after_debit?: number;
  current_balance?: number;
  credits_total?: number;
  settlement_status?: "settled" | "pending";
  settlement_pending?: boolean;
  achievement_credits?: Array<{ id: string; name: string; amount: number }>;
  probability_bps: number;
  pool_revision: number;
  random_commitment: string;
  filters?: DrawFilters;
  odds?: Array<{
    variant_id?: string;
    card_name: string;
    variant_name: string;
    probability_bps: number;
    weight: number;
  }>;
  achievements?: Array<{
    id: string;
    name: string;
    reward_amount: number;
    reward_state?: string | null;
  }>;
  replayed: boolean;
}

export interface DrawPayload {
  pool: string;
  expectedRevision: number;
  expectedDistribution: string;
  price: number;
  channelKey: string;
}

export type OperationStatus = "submitting" | "unknown" | "committed";

export interface DrawOperation {
  version: typeof DRAW_STATE_VERSION;
  key: string;
  scope: DrawScope;
  payload: DrawPayload;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
}

export type PreviewChange = {
  previousPrice: number;
  currentPrice: number;
  previousRevision: number;
  currentRevision: number;
  previousDistribution: string;
  currentDistribution: string;
  priceChanged: boolean;
  revisionChanged: boolean;
  distributionChanged: boolean;
};

export type BlockedReason =
  | "no_preview"
  | "preview_error"
  | "empty_pool"
  | "insufficient_funds"
  | "stale_preview"
  | "request_rejected"
  | "signed_out";

export type UnknownReason = "lost" | "signed_out" | "conflict";

export type DrawSource = "submit" | "reconcile";

export type DrawPhase =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "blocked"; reason: BlockedReason; message: string }
  | { status: "submitting"; operation: DrawOperation }
  | {
      status: "unknown";
      operation: DrawOperation;
      reason: UnknownReason;
      message: string;
      retryable: boolean;
    }
  | { status: "reconciling"; operation: DrawOperation }
  | {
      status: "committed";
      operation: DrawOperation;
      receipt: DrawReceipt;
      source: DrawSource;
    }
  | {
      status: "revealed";
      operation: DrawOperation;
      receipt: DrawReceipt;
      source: DrawSource;
      visible: boolean;
      replaying: boolean;
    };

export interface DrawStudioState {
  scope: DrawScope;
  selection: PreviewTarget;
  preview: DrawPreview | null;
  previewRequestId: number;
  phase: DrawPhase;
  balance: number;
  /** Non-blocking explanation that must survive a preview refresh. */
  notice: string | null;
  /** Set when the live odds no longer match the bound operation payload. */
  previewChange: PreviewChange | null;
}

export type DrawStudioEvent =
  | {
      type: "scope/changed";
      scopeKey: string;
      scope: DrawScope;
      selection: PreviewTarget;
      balance: number;
    }
  | {
      type: "selection/changed";
      scopeKey: string;
      selection: PreviewTarget;
    }
  | {
      type: "preview/requested";
      scopeKey: string;
      requestId: number;
      target: PreviewTarget;
    }
  | {
      type: "preview/succeeded";
      scopeKey: string;
      requestId: number;
      target: PreviewTarget;
      preview: DrawPreview;
    }
  | {
      type: "preview/failed";
      scopeKey: string;
      requestId: number;
      target: PreviewTarget;
      message: string;
      authRequired?: boolean;
    }
  | {
      type: "preview/cleared";
      scopeKey: string;
      message: string;
    }
  | { type: "balance/updated"; scopeKey: string; balance: number }
  | { type: "draw/started"; scopeKey: string; operation: DrawOperation }
  | {
      type: "draw/unknown";
      scopeKey: string;
      operation: DrawOperation;
      reason: UnknownReason;
      message: string;
      retryable: boolean;
    }
  | {
      type: "draw/rejected";
      scopeKey: string;
      operationKey: string;
      reason: BlockedReason;
      message: string;
    }
  | {
      type: "recovery/found";
      scopeKey: string;
      operation: DrawOperation;
    }
  | {
      type: "reconcile/started";
      scopeKey: string;
      operation: DrawOperation;
    }
  | {
      type: "reconcile/unknown";
      scopeKey: string;
      operation: DrawOperation;
      reason: UnknownReason;
      message: string;
      retryable: boolean;
    }
  | {
      type: "reconcile/rejected";
      scopeKey: string;
      operationKey: string;
      reason: BlockedReason;
      message: string;
    }
  | {
      type: "draw/committed";
      scopeKey: string;
      operation: DrawOperation;
      receipt: DrawReceipt;
      source: DrawSource;
      balance?: number;
    }
  | { type: "reveal/show"; scopeKey: string; operationKey: string }
  | { type: "reveal/hide"; scopeKey: string; operationKey: string }
  | { type: "reveal/replay"; scopeKey: string; operationKey: string }
  | { type: "operation/reset"; scopeKey: string; balance?: number; notice?: string };

export interface OperationStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type DrawFailure =
  | { kind: "aborted" }
  | { kind: "unknown"; message: string; retryable: boolean }
  | { kind: "conflict"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "rejected"; reason: BlockedReason; message: string };

export function drawScopeKey(scope: DrawScope): string {
  return JSON.stringify([scope.environment, scope.accountId, scope.botId]);
}

export function sameTarget(left: PreviewTarget, right: PreviewTarget): boolean {
  return (
    left.pool === right.pool && normaliseChannel(left.channel) === normaliseChannel(right.channel)
  );
}

export function normaliseChannel(channel: string | null | undefined): string {
  return channel ?? "";
}

export function targetFor(preview: Pick<DrawPreview, "pool" | "filters">): PreviewTarget {
  return { pool: preview.pool.slug, channel: normaliseChannel(preview.filters.channel_key) };
}

export function operationStorageKey(scope: DrawScope, pool: string): string {
  return `${DRAW_OPERATION_PREFIX}${encodeURIComponent(scope.environment)}:${encodeURIComponent(
    scope.accountId,
  )}:${encodeURIComponent(scope.botId)}:${encodeURIComponent(pool)}`;
}

export function operationPayload(preview: DrawPreview, channel: string): DrawPayload {
  return {
    pool: preview.pool.slug,
    expectedRevision: preview.expected_revision,
    expectedDistribution: preview.distribution_fingerprint,
    price: preview.price,
    channelKey: normaliseChannel(channel),
  };
}

/** The exact body used for the first request and every reconciliation replay. */
export function operationBody(operation: DrawOperation): {
  pool: string;
  expectedRevision: number;
  expectedDistribution: string;
  channelKey?: string;
} {
  return {
    pool: operation.payload.pool,
    expectedRevision: operation.payload.expectedRevision,
    expectedDistribution: operation.payload.expectedDistribution,
    ...(operation.payload.channelKey ? { channelKey: operation.payload.channelKey } : {}),
  };
}

export function createDrawOperation(input: {
  scope: DrawScope;
  key: string;
  payload: DrawPayload;
  status?: OperationStatus;
  now?: string;
}): DrawOperation {
  const now = input.now ?? new Date().toISOString();
  return {
    version: DRAW_STATE_VERSION,
    key: input.key,
    scope: input.scope,
    payload: { ...input.payload },
    status: input.status ?? "submitting",
    createdAt: now,
    updatedAt: now,
  };
}

export function withOperationStatus(
  operation: DrawOperation,
  status: OperationStatus,
  now = new Date().toISOString(),
): DrawOperation {
  return { ...operation, status, updatedAt: now };
}

export function initialDrawStudioState(input: {
  scope: DrawScope;
  selection: PreviewTarget;
  balance: number;
}): DrawStudioState {
  return {
    scope: { ...input.scope },
    selection: { ...input.selection },
    preview: null,
    previewRequestId: 0,
    phase: { status: "loading" },
    balance: input.balance,
    notice: null,
    previewChange: null,
  };
}

export function operationOf(phase: DrawPhase): DrawOperation | null {
  switch (phase.status) {
    case "submitting":
    case "unknown":
    case "reconciling":
    case "committed":
    case "revealed":
      return phase.operation;
    default:
      return null;
  }
}

export function receiptOf(phase: DrawPhase): DrawReceipt | null {
  return phase.status === "committed" || phase.status === "revealed" ? phase.receipt : null;
}

/** A draw is only startable from a fully-loaded, affordable, non-empty preview. */
export function canDraw(state: DrawStudioState): boolean {
  return state.phase.status === "ready" && state.preview !== null;
}

export function isLockedPhase(phase: DrawPhase): boolean {
  return (
    phase.status === "submitting" ||
    phase.status === "unknown" ||
    phase.status === "reconciling" ||
    phase.status === "committed"
  );
}

export function isOperationPhase(phase: DrawPhase): boolean {
  return operationOf(phase) !== null;
}

export function previewChangeFor(
  operation: DrawOperation,
  preview: DrawPreview,
): PreviewChange | null {
  const priceChanged = operation.payload.price !== preview.price;
  const revisionChanged = operation.payload.expectedRevision !== preview.expected_revision;
  const distributionChanged =
    operation.payload.expectedDistribution !== preview.distribution_fingerprint;
  if (!priceChanged && !revisionChanged && !distributionChanged) return null;
  return {
    previousPrice: operation.payload.price,
    currentPrice: preview.price,
    previousRevision: operation.payload.expectedRevision,
    currentRevision: preview.expected_revision,
    previousDistribution: operation.payload.expectedDistribution,
    currentDistribution: preview.distribution_fingerprint,
    priceChanged,
    revisionChanged,
    distributionChanged,
  };
}

export function blockedMessage(
  preview: DrawPreview,
  balance: number,
): { reason: BlockedReason; message: string } | null {
  if (preview.eligible_count === 0) {
    return {
      reason: "empty_pool",
      message:
        preview.filters.empty_reason ??
        "No eligible cards. Nothing can be charged while this capsule is empty.",
    };
  }
  if (balance < preview.price) {
    return {
      reason: "insufficient_funds",
      message: `This opening costs ${preview.currency.symbol} ${preview.price}. Your balance is ${preview.currency.symbol} ${balance}. Nothing has been charged.`,
    };
  }
  return null;
}

export function phaseForPreview(preview: DrawPreview, balance: number): DrawPhase {
  const blocked = blockedMessage(preview, balance);
  return blocked ? { status: "blocked", ...blocked } : { status: "ready" };
}

/** Null waits for an intentional reveal; reduced motion reveals immediately. */
export function revealDelayMs(reducedMotion: boolean, _replay = false): number | null {
  if (reducedMotion) return 0;
  return null;
}

export function classifyDrawFailure(input: {
  status?: number;
  code?: string;
  message: string;
  aborted?: boolean;
}): DrawFailure {
  if (input.aborted) return { kind: "aborted" };

  const status = input.status;
  const code = input.code;

  if (code === "idempotency_conflict") {
    return { kind: "conflict", message: input.message };
  }
  if (code === "draw_conflict") {
    return { kind: "unknown", message: input.message, retryable: true };
  }
  if (status === 401 || status === 403 || code === "authentication_required") {
    return { kind: "auth", message: input.message };
  }
  if (code === "stale_pool_revision" || code === "stale_distribution" || code === "pool_changed") {
    return { kind: "rejected", reason: "stale_preview", message: input.message };
  }
  if (code === "empty_pool") {
    return { kind: "rejected", reason: "empty_pool", message: input.message };
  }
  if (code === "insufficient_funds") {
    return { kind: "rejected", reason: "insufficient_funds", message: input.message };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return { kind: "unknown", message: input.message, retryable: true };
  }
  if (status === 408 || status === 429) {
    return { kind: "unknown", message: input.message, retryable: true };
  }
  if (status === undefined) {
    return { kind: "unknown", message: input.message, retryable: true };
  }
  return { kind: "rejected", reason: "request_rejected", message: input.message };
}

function scopeMatches(state: DrawStudioState, scopeKey: string): boolean {
  return drawScopeKey(state.scope) === scopeKey;
}

function operationMatches(phase: DrawPhase, operation: DrawOperation): boolean {
  const current = operationOf(phase);
  return current !== null && current.key === operation.key;
}

function withPreviewPhase(
  next: DrawStudioState,
  operation: DrawOperation,
  preview: DrawPreview,
): DrawStudioState {
  const change = previewChangeFor(operation, preview);
  return {
    ...next,
    preview,
    previewChange: change,
  };
}

export function reduceDrawStudio(state: DrawStudioState, event: DrawStudioEvent): DrawStudioState {
  if (event.type === "scope/changed") {
    if (event.scopeKey !== drawScopeKey(event.scope)) return state;
    return {
      scope: { ...event.scope },
      selection: { ...event.selection },
      preview: null,
      previewRequestId: state.previewRequestId,
      phase: { status: "loading" },
      balance: event.balance,
      notice: null,
      previewChange: null,
    };
  }

  if (!scopeMatches(state, event.scopeKey)) return state;

  switch (event.type) {
    case "selection/changed": {
      if (isLockedPhase(state.phase) || sameTarget(state.selection, event.selection)) {
        return state;
      }
      return {
        ...state,
        selection: { ...event.selection },
        preview: null,
        previewRequestId: state.previewRequestId,
        phase: { status: "loading" },
        notice: null,
        previewChange: null,
      };
    }

    case "preview/requested": {
      if (!sameTarget(event.target, state.selection)) return state;
      if (event.requestId < state.previewRequestId) return state;
      return {
        ...state,
        previewRequestId: event.requestId,
        phase: isOperationPhase(state.phase) ? state.phase : { status: "loading" },
      };
    }

    case "preview/succeeded": {
      if (event.requestId !== state.previewRequestId) return state;
      if (!sameTarget(event.target, state.selection)) return state;
      const operation = operationOf(state.phase);
      if (operation) {
        return withPreviewPhase({ ...state, preview: event.preview }, operation, event.preview);
      }
      if (state.phase.status === "blocked" && state.phase.reason === "signed_out") {
        return { ...state, preview: event.preview };
      }
      return {
        ...state,
        preview: event.preview,
        phase: phaseForPreview(event.preview, state.balance),
      };
    }

    case "preview/failed": {
      if (event.requestId !== state.previewRequestId) return state;
      if (!sameTarget(event.target, state.selection)) return state;
      if (isOperationPhase(state.phase)) {
        // The operation is the priority and its payload is unchanged. The
        // previous odds stay visible until a later refresh succeeds.
        return state;
      }
      return {
        ...state,
        phase: {
          status: "blocked",
          reason: event.authRequired
            ? "signed_out"
            : state.preview
              ? "preview_error"
              : "no_preview",
          message: event.message,
        },
      };
    }

    case "preview/cleared": {
      if (isOperationPhase(state.phase)) return state;
      return {
        ...state,
        preview: null,
        phase: { status: "blocked", reason: "no_preview", message: event.message },
      };
    }

    case "balance/updated": {
      if (isOperationPhase(state.phase) || state.phase.status === "loading") {
        return { ...state, balance: event.balance };
      }
      if (
        state.preview &&
        (state.phase.status === "ready" ||
          (state.phase.status === "blocked" &&
            state.phase.reason !== "signed_out" &&
            state.phase.reason !== "preview_error" &&
            state.phase.reason !== "no_preview"))
      ) {
        return {
          ...state,
          balance: event.balance,
          phase: phaseForPreview(state.preview, event.balance),
        };
      }
      return { ...state, balance: event.balance };
    }

    case "draw/started": {
      if (state.phase.status !== "ready") return state;
      if (drawScopeKey(event.operation.scope) !== event.scopeKey) return state;
      if (event.operation.payload.pool !== state.selection.pool) return state;
      if (state.preview) {
        if (
          event.operation.payload.expectedRevision !== state.preview.expected_revision ||
          event.operation.payload.expectedDistribution !== state.preview.distribution_fingerprint ||
          event.operation.payload.price !== state.preview.price
        ) {
          return state;
        }
      }
      return {
        ...state,
        phase: { status: "submitting", operation: event.operation },
        notice: null,
        previewChange: null,
      };
    }

    case "draw/unknown": {
      if (!operationMatches(state.phase, event.operation)) return state;
      if (state.phase.status !== "submitting") return state;
      return {
        ...state,
        phase: {
          status: "unknown",
          operation: event.operation,
          reason: event.reason,
          message: event.message,
          retryable: event.retryable,
        },
      };
    }

    case "draw/rejected": {
      const current = operationOf(state.phase);
      if (!current || current.key !== event.operationKey) return state;
      if (state.phase.status !== "submitting") return state;
      return {
        ...state,
        phase: { status: "blocked", reason: event.reason, message: event.message },
        notice: event.reason === "stale_preview" ? event.message : state.notice,
        previewChange: null,
      };
    }

    case "recovery/found": {
      if (drawScopeKey(event.operation.scope) !== event.scopeKey) return state;
      return {
        ...state,
        selection: {
          pool: event.operation.payload.pool,
          channel: event.operation.payload.channelKey,
        },
        preview: null,
        previewRequestId: state.previewRequestId,
        phase: { status: "reconciling", operation: event.operation },
        notice: null,
        previewChange: null,
      };
    }

    case "reconcile/started": {
      if (!operationMatches(state.phase, event.operation)) return state;
      if (state.phase.status !== "unknown") return state;
      return {
        ...state,
        phase: { status: "reconciling", operation: event.operation },
      };
    }

    case "reconcile/unknown": {
      if (!operationMatches(state.phase, event.operation)) return state;
      if (state.phase.status !== "reconciling") return state;
      return {
        ...state,
        phase: {
          status: "unknown",
          operation: event.operation,
          reason: event.reason,
          message: event.message,
          retryable: event.retryable,
        },
      };
    }

    case "reconcile/rejected": {
      const current = operationOf(state.phase);
      if (!current || current.key !== event.operationKey) return state;
      if (state.phase.status !== "reconciling") return state;
      return {
        ...state,
        phase: { status: "blocked", reason: event.reason, message: event.message },
        notice: event.reason === "stale_preview" ? event.message : state.notice,
        previewChange: null,
      };
    }

    case "draw/committed": {
      if (!operationMatches(state.phase, event.operation)) return state;
      if (
        state.phase.status !== "submitting" &&
        state.phase.status !== "unknown" &&
        state.phase.status !== "reconciling"
      ) {
        return state;
      }
      return {
        ...state,
        balance: event.balance ?? state.balance,
        phase: {
          status: "committed",
          operation: event.operation,
          receipt: event.receipt,
          source: event.source,
        },
      };
    }

    case "reveal/show": {
      if (state.phase.status === "revealed") {
        const current = state.phase;
        if (current.operation.key !== event.operationKey) return state;
        return {
          ...state,
          phase: { ...current, visible: true, replaying: false },
        };
      }
      if (state.phase.status !== "committed") return state;
      if (state.phase.operation.key !== event.operationKey) return state;
      return {
        ...state,
        phase: {
          status: "revealed",
          operation: state.phase.operation,
          receipt: state.phase.receipt,
          source: state.phase.source,
          visible: true,
          replaying: false,
        },
      };
    }

    case "reveal/hide": {
      if (state.phase.status !== "revealed") return state;
      if (state.phase.operation.key !== event.operationKey) return state;
      return {
        ...state,
        phase: { ...state.phase, visible: false, replaying: false },
      };
    }

    case "reveal/replay": {
      if (state.phase.status !== "revealed") return state;
      if (state.phase.operation.key !== event.operationKey) return state;
      return {
        ...state,
        phase: { ...state.phase, visible: false, replaying: true },
      };
    }

    case "operation/reset": {
      if (state.phase.status !== "revealed") return state;
      const balance = event.balance ?? state.balance;
      return {
        ...state,
        balance,
        phase: state.preview
          ? phaseForPreview(state.preview, balance)
          : {
              status: "blocked",
              reason: "no_preview",
              message: "Review the live odds before opening another capsule.",
            },
        notice: event.notice ?? null,
        previewChange: null,
      };
    }

    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Durable operation persistence                                       */
/* ------------------------------------------------------------------ */

interface ParsedStorageKey {
  scope: DrawScope;
  pool: string;
  scopeKey: string;
}

function parseStorageKey(key: string): ParsedStorageKey | null {
  if (!key.startsWith(DRAW_OPERATION_PREFIX)) return null;
  const parts = key.slice(DRAW_OPERATION_PREFIX.length).split(":");
  if (parts.length !== 4) return null;
  try {
    const [environment, accountId, botId, pool] = parts.map(decodeURIComponent);
    if (!environment || !accountId || !botId || !pool) return null;
    const scope = { environment, accountId, botId };
    return { scope, pool, scopeKey: drawScopeKey(scope) };
  } catch {
    return null;
  }
}

function isValidOperation(value: unknown, expected?: ParsedStorageKey): value is DrawOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<DrawOperation>;
  if (operation.version !== DRAW_STATE_VERSION) return false;
  if (typeof operation.key !== "string" || operation.key.length < 8) return false;
  if (!operation.scope || typeof operation.scope !== "object") return false;
  if (typeof operation.scope.environment !== "string" || !operation.scope.environment) {
    return false;
  }
  if (typeof operation.scope.accountId !== "string" || !operation.scope.accountId) {
    return false;
  }
  if (typeof operation.scope.botId !== "string" || !operation.scope.botId) {
    return false;
  }
  if (!operation.payload || typeof operation.payload !== "object") return false;
  if (typeof operation.payload.pool !== "string" || !operation.payload.pool) return false;
  if (
    !Number.isInteger(operation.payload.expectedRevision) ||
    (operation.payload.expectedRevision ?? 0) <= 0
  ) {
    return false;
  }
  if (
    typeof operation.payload.expectedDistribution !== "string" ||
    operation.payload.expectedDistribution.length < 16
  ) {
    return false;
  }
  if (!Number.isInteger(operation.payload.price) || (operation.payload.price ?? -1) < 0) {
    return false;
  }
  if (typeof operation.payload.channelKey !== "string") return false;
  if (
    operation.status !== "submitting" &&
    operation.status !== "unknown" &&
    operation.status !== "committed"
  ) {
    return false;
  }
  if (typeof operation.createdAt !== "string" || typeof operation.updatedAt !== "string") {
    return false;
  }
  if (expected) {
    if (drawScopeKey(operation.scope) !== expected.scopeKey) return false;
    if (operation.payload.pool !== expected.pool) return false;
  }
  return true;
}

function safeRemove(storage: OperationStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be disabled in private mode; the in-memory contract still holds.
  }
}

export function saveOperation(storage: OperationStorage | null, operation: DrawOperation): boolean {
  if (!storage) return false;
  if (!isValidOperation(operation)) return false;
  try {
    storage.setItem(
      operationStorageKey(operation.scope, operation.payload.pool),
      JSON.stringify(operation),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadOperation(
  storage: OperationStorage | null,
  scope: DrawScope,
  pool: string,
): DrawOperation | null {
  if (!storage) return null;
  const key = operationStorageKey(scope, pool);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const expected = parseStorageKey(key);
    if (!expected) {
      safeRemove(storage, key);
      return null;
    }
    if (!isValidOperation(parsed, expected)) {
      safeRemove(storage, key);
      return null;
    }
    return parsed;
  } catch {
    safeRemove(storage, key);
    return null;
  }
}

export function removeOperation(
  storage: OperationStorage | null,
  scope: DrawScope,
  pool: string,
): void {
  if (!storage) return;
  safeRemove(storage, operationStorageKey(scope, pool));
}

/**
 * Remove operations that belong to another environment, account or Bot.
 * Same-scope operations for other pools are kept: an uncertain opening must
 * survive navigation to a different capsule.
 */
export function clearForeignOperations(
  storage: OperationStorage | null,
  scope: DrawScope,
): string[] {
  if (!storage) return [];
  const current = drawScopeKey(scope);
  const removed: string[] = [];
  let keys: string[] = [];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => typeof key === "string",
    );
  } catch {
    return removed;
  }
  for (const key of keys) {
    if (!key.startsWith(DRAW_OPERATION_PREFIX)) continue;
    const parsed = parseStorageKey(key);
    if (!parsed || parsed.scopeKey !== current) {
      safeRemove(storage, key);
      removed.push(key);
    }
  }
  return removed;
}

/** The newest uncertain operation for this environment, account and Bot. */
export function findRecoverableOperation(
  storage: OperationStorage | null,
  scope: DrawScope,
): DrawOperation | null {
  if (!storage) return null;
  const found: DrawOperation[] = [];
  let keys: string[] = [];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => typeof key === "string",
    );
  } catch {
    return null;
  }
  for (const key of keys) {
    if (!key.startsWith(DRAW_OPERATION_PREFIX)) continue;
    const parsed = parseStorageKey(key);
    if (!parsed || parsed.scopeKey !== drawScopeKey(scope)) continue;
    const operation = loadOperation(storage, scope, parsed.pool);
    if (operation) found.push(operation);
  }
  found.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return found[0] ?? null;
}

/** Deliberate reset for every pool in one account/Bot scope. */
export function clearOperationsForScope(
  storage: OperationStorage | null,
  scope: DrawScope,
): string[] {
  if (!storage) return [];
  const current = drawScopeKey(scope);
  const removed: string[] = [];
  let keys: string[] = [];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => typeof key === "string",
    );
  } catch {
    return removed;
  }
  for (const key of keys) {
    if (!key.startsWith(DRAW_OPERATION_PREFIX)) continue;
    const parsed = parseStorageKey(key);
    if (parsed?.scopeKey === current) {
      safeRemove(storage, key);
      removed.push(key);
    }
  }
  return removed;
}
