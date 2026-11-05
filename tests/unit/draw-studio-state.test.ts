import { describe, expect, it } from "vitest";
import {
  DRAW_OPERATION_PREFIX,
  canDraw,
  classifyDrawFailure,
  clearForeignOperations,
  clearOperationsForScope,
  createDrawOperation,
  drawScopeKey,
  findRecoverableOperation,
  initialDrawStudioState,
  loadOperation,
  operationBody,
  operationPayload,
  operationStorageKey,
  reduceDrawStudio,
  removeOperation,
  revealDelayMs,
  saveOperation,
  withOperationStatus,
  type DrawOperation,
  type DrawPreview,
  type DrawReceipt,
  type DrawScope,
  type DrawStudioEvent,
  type DrawStudioState,
  type OperationStorage,
  type PreviewTarget,
} from "../../src/components/player/draw-studio-state";

const scope: DrawScope = {
  environment: "test",
  accountId: "usr_player",
  botId: "bot_cabinet",
};
const otherScope: DrawScope = {
  environment: "test",
  accountId: "usr_other",
  botId: "bot_cabinet",
};
const scopeKey = drawScopeKey(scope);
const otherScopeKey = drawScopeKey(otherScope);
const selection: PreviewTarget = { pool: "cabinet-draw", channel: "" };

class MemoryStorage implements OperationStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.values);
  }
}

function preview(overrides: Partial<DrawPreview> = {}): DrawPreview {
  return {
    pool: {
      id: "pool_cabinet",
      slug: "cabinet-draw",
      name: "Cabinet draw",
      description: "One card from the cabinet.",
      revision: 1,
      price: 80,
      status: "active",
    },
    revision: 1,
    price: 80,
    eligible_count: 2,
    total_weight: 10,
    entries: [],
    filters: {
      channel_key: null,
      excluded_tags: [],
      tenant_excluded_tags: [],
      player_excluded_tags: [],
      player_hidden_collection_ids: [],
      unfiled_count: 0,
      empty_reason: null,
    },
    pity: "disabled",
    currency: { name: "Foil", symbol: "✦" },
    expected_revision: 1,
    distribution_fingerprint: "fingerprint-000000000001",
    ...overrides,
  };
}

function receipt(overrides: Partial<DrawReceipt> = {}): DrawReceipt {
  return {
    draw_id: "drw_1",
    instance_id: "ins_1",
    card_name: "Test One",
    edition_name: "First edition",
    variant_name: "Plain",
    render_url: "/card.png",
    serial: "FB-1-TE-ABC123",
    new_subject: true,
    new_finish: true,
    owned_copies: 1,
    price: 80,
    balance_after_debit: 420,
    balance_after: 420,
    current_balance: 420,
    credits_total: 0,
    probability_bps: 5000,
    pool_revision: 1,
    random_commitment: "commitment-0000000000000000000000000000",
    replayed: false,
    ...overrides,
  };
}

function freshState(balance = 500): DrawStudioState {
  return initialDrawStudioState({ scope, selection, balance });
}

function readyState(nextPreview = preview()): DrawStudioState {
  let state = freshState();
  state = reduceDrawStudio(state, {
    type: "preview/requested",
    scopeKey,
    requestId: 1,
    target: selection,
  });
  state = reduceDrawStudio(state, {
    type: "preview/succeeded",
    scopeKey,
    requestId: 1,
    target: selection,
    preview: nextPreview,
  });
  return state;
}

function operation(
  state: DrawStudioState,
  key = "draw-key-00000001",
  now = "2026-11-04T10:00:00.000Z",
): DrawOperation {
  const current = state.preview ?? preview();
  return createDrawOperation({
    scope,
    key,
    payload: operationPayload(current, state.selection.channel),
    now,
  });
}

function startDraw(state: DrawStudioState, key = "draw-key-00000001"): DrawStudioState {
  const op = operation(state, key);
  return reduceDrawStudio(state, {
    type: "draw/started",
    scopeKey,
    operation: op,
  });
}

function dispatch(state: DrawStudioState, event: DrawStudioEvent): DrawStudioState {
  return reduceDrawStudio(state, event);
}

describe("draw studio explicit state machine", () => {
  it("moves loading → ready → submitting → committed → revealed", () => {
    let state = freshState();
    expect(state.phase.status).toBe("loading");
    expect(canDraw(state)).toBe(false);

    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 1,
      target: selection,
    });
    expect(state.phase.status).toBe("loading");

    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 1,
      target: selection,
      preview: preview(),
    });
    expect(state.phase.status).toBe("ready");
    expect(canDraw(state)).toBe(true);

    const firstOperation = operation(state);
    state = dispatch(state, {
      type: "draw/started",
      scopeKey,
      operation: firstOperation,
    });
    expect(state.phase.status).toBe("submitting");
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    expect(state.phase.operation.key).toBe(firstOperation.key);
    expect(canDraw(state)).toBe(false);

    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: withOperationStatus(firstOperation, "committed"),
      receipt: receipt(),
      source: "submit",
      balance: 420,
    });
    expect(state.phase.status).toBe("committed");
    expect(state.balance).toBe(420);

    state = dispatch(state, {
      type: "reveal/show",
      scopeKey,
      operationKey: firstOperation.key,
    });
    expect(state.phase.status).toBe("revealed");
    if (state.phase.status !== "revealed") throw new Error("not revealed");
    expect(state.phase.visible).toBe(true);
    expect(state.phase.receipt.instance_id).toBe("ins_1");
  });

  it("refuses to bind a new operation to a payload other than the ready preview", () => {
    const state = readyState();
    const tampered = operation(state);
    tampered.payload = { ...tampered.payload, price: 120 };
    const next = dispatch(state, {
      type: "draw/started",
      scopeKey,
      operation: tampered,
    });
    expect(next.phase.status).toBe("ready");
    expect(next.preview?.price).toBe(80);
  });

  it("uses the freshly read wallet when opening another after an uncertain settlement", () => {
    let state = readyState();
    const draw = operation(state);
    state = dispatch(state, { type: "draw/started", scopeKey, operation: draw });
    state = dispatch(state, { type: "draw/committed", scopeKey, operation: withOperationStatus(draw, "committed"), receipt: receipt(), source: "submit" });
    state = dispatch(state, { type: "reveal/show", scopeKey, operationKey: draw.key });
    state = dispatch(state, { type: "operation/reset", scopeKey, balance: 10, notice: "Earlier reward pending" });
    expect(state.balance).toBe(10);
    expect(state.notice).toBe("Earlier reward pending");
    expect(state.phase.status).toBe("blocked");
    if (state.phase.status === "blocked") expect(state.phase.reason).toBe("insufficient_funds");
  });

  it("ignores a second draw start while the first is in flight", () => {
    let state = startDraw(readyState());
    const firstKey = state.phase.status === "submitting" ? state.phase.operation.key : "";
    const second = operation(readyState(), "draw-key-00000002");
    state = dispatch(state, {
      type: "draw/started",
      scopeKey,
      operation: second,
    });
    expect(state.phase.status).toBe("submitting");
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    expect(state.phase.operation.key).toBe(firstKey);
    expect(state.phase.operation.key).not.toBe(second.key);
  });

  it("blocks empty and unaffordable capsules without pretending to be ready", () => {
    let state = readyState(preview({ eligible_count: 0 }));
    expect(state.phase.status).toBe("blocked");
    if (state.phase.status !== "blocked") throw new Error("not blocked");
    expect(state.phase.reason).toBe("empty_pool");
    expect(canDraw(state)).toBe(false);

    state = freshState(20);
    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 1,
      target: selection,
    });
    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 1,
      target: selection,
      preview: preview({ price: 80 }),
    });
    expect(state.phase.status).toBe("blocked");
    if (state.phase.status !== "blocked") throw new Error("not blocked");
    expect(state.phase.reason).toBe("insufficient_funds");

    state = dispatch(state, {
      type: "balance/updated",
      scopeKey,
      balance: 100,
    });
    expect(state.phase.status).toBe("ready");
  });

  it("refuses to draw from loading or blocked states", () => {
    const loading = freshState();
    const op = operation(loading);
    expect(
      reduceDrawStudio(loading, {
        type: "draw/started",
        scopeKey,
        operation: op,
      }).phase.status,
    ).toBe("loading");

    const blocked = readyState(preview({ eligible_count: 0 }));
    expect(
      reduceDrawStudio(blocked, {
        type: "draw/started",
        scopeKey,
        operation: op,
      }).phase.status,
    ).toBe("blocked");
  });
});

describe("durable recovery and payload binding", () => {
  it("keeps the original operation and payload when the preview changes", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const original = state.phase.operation;
    const originalPayload = { ...original.payload };

    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: selection,
    });
    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 2,
      target: selection,
      preview: preview({
        revision: 2,
        expected_revision: 2,
        price: 120,
        distribution_fingerprint: "fingerprint-000000000002",
      }),
    });

    expect(state.phase.status).toBe("submitting");
    expect(state.previewChange).toMatchObject({
      previousPrice: 80,
      currentPrice: 120,
      previousRevision: 1,
      currentRevision: 2,
      priceChanged: true,
      revisionChanged: true,
      distributionChanged: true,
    });
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    expect(state.phase.operation.key).toBe(original.key);
    expect(state.phase.operation.payload).toEqual(originalPayload);

    state = dispatch(state, {
      type: "draw/unknown",
      scopeKey,
      operation: withOperationStatus(original, "unknown"),
      reason: "lost",
      message: "The response was lost.",
      retryable: true,
    });
    expect(state.phase.status).toBe("unknown");
    if (state.phase.status !== "unknown") throw new Error("not unknown");
    expect(state.phase.operation.payload).toEqual(originalPayload);
    expect(state.previewChange?.priceChanged).toBe(true);

    state = dispatch(state, {
      type: "reconcile/started",
      scopeKey,
      operation: state.phase.operation,
    });
    expect(state.phase.status).toBe("reconciling");

    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: state.phase.operation,
      receipt: receipt({ replayed: true }),
      source: "reconcile",
      balance: 420,
    });
    expect(state.phase.status).toBe("committed");
    if (state.phase.status !== "committed") throw new Error("not committed");
    expect(state.phase.operation.key).toBe(original.key);
    expect(state.phase.operation.payload).toEqual(originalPayload);
    expect(state.phase.source).toBe("reconcile");
    expect(state.phase.receipt.replayed).toBe(true);
  });

  it("requires an explicit reset before binding a new operation to new odds", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const originalKey = state.phase.operation.key;
    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: withOperationStatus(state.phase.operation, "committed"),
      receipt: receipt(),
      source: "submit",
    });
    state = dispatch(state, {
      type: "reveal/show",
      scopeKey,
      operationKey: originalKey,
    });
    expect(state.phase.status).toBe("revealed");

    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: selection,
    });
    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 2,
      target: selection,
      preview: preview({
        revision: 2,
        expected_revision: 2,
        price: 120,
        distribution_fingerprint: "fingerprint-000000000002",
      }),
    });
    expect(state.previewChange).not.toBeNull();

    state = dispatch(state, { type: "operation/reset", scopeKey });
    expect(state.phase.status).toBe("ready");
    expect(state.previewChange).toBeNull();
    expect(state.preview?.price).toBe(120);

    const next = operation(state, "draw-key-00000002");
    state = dispatch(state, {
      type: "draw/started",
      scopeKey,
      operation: next,
    });
    expect(state.phase.status).toBe("submitting");
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    expect(state.phase.operation.key).toBe("draw-key-00000002");
    expect(state.phase.operation.key).not.toBe(originalKey);
    expect(state.phase.operation.payload.expectedRevision).toBe(2);
    expect(state.phase.operation.payload.price).toBe(120);
  });

  it("recovers a saved operation into reconciling with the original selection", () => {
    const op = operation(readyState(), "draw-key-recover-1");
    let state = freshState();
    state = dispatch(state, {
      type: "recovery/found",
      scopeKey,
      operation: withOperationStatus(op, "unknown"),
    });
    expect(state.phase.status).toBe("reconciling");
    expect(state.selection).toEqual({
      pool: "cabinet-draw",
      channel: "",
    });
    if (state.phase.status !== "reconciling") throw new Error("not reconciling");
    expect(state.phase.operation.key).toBe("draw-key-recover-1");
    expect(operationBody(state.phase.operation)).toEqual({
      pool: "cabinet-draw",
      expectedRevision: 1,
      expectedDistribution: "fingerprint-000000000001",
    });
  });

  it("keeps an unknown state when the replacement preview fails", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const op = withOperationStatus(state.phase.operation, "unknown");
    state = dispatch(state, {
      type: "draw/unknown",
      scopeKey,
      operation: op,
      reason: "lost",
      message: "Response lost.",
      retryable: true,
    });
    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: selection,
    });
    state = dispatch(state, {
      type: "preview/failed",
      scopeKey,
      requestId: 2,
      target: selection,
      message: "Preview unavailable.",
    });
    expect(state.phase.status).toBe("unknown");
    if (state.phase.status !== "unknown") throw new Error("not unknown");
    expect(state.phase.message).toBe("Response lost.");
    expect(state.notice).toBeNull();
  });

  it("does not replace an unknown operation on a conflicting reconcile", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const pending = withOperationStatus(state.phase.operation, "unknown");
    state = dispatch(state, {
      type: "draw/unknown",
      scopeKey,
      operation: pending,
      reason: "lost",
      message: "Response lost.",
      retryable: true,
    });
    state = dispatch(state, {
      type: "reconcile/started",
      scopeKey,
      operation: pending,
    });
    state = dispatch(state, {
      type: "reconcile/unknown",
      scopeKey,
      operation: pending,
      reason: "conflict",
      message: "This idempotency key was already used with a different request.",
      retryable: false,
    });
    expect(state.phase.status).toBe("unknown");
    if (state.phase.status !== "unknown") throw new Error("not unknown");
    expect(state.phase.reason).toBe("conflict");
    expect(state.phase.retryable).toBe(false);
    expect(state.phase.operation.key).toBe(pending.key);
  });

  it("releases a saved operation only when reconciliation is definitively rejected", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const op = state.phase.operation;
    state = dispatch(state, {
      type: "draw/unknown",
      scopeKey,
      operation: withOperationStatus(op, "unknown"),
      reason: "lost",
      message: "Response lost.",
      retryable: true,
    });
    state = dispatch(state, {
      type: "reconcile/started",
      scopeKey,
      operation: withOperationStatus(op, "unknown"),
    });
    state = dispatch(state, {
      type: "reconcile/rejected",
      scopeKey,
      operationKey: op.key,
      reason: "stale_preview",
      message: "The pool changed. Nothing was charged.",
    });
    expect(state.phase.status).toBe("blocked");
    if (state.phase.status !== "blocked") throw new Error("not blocked");
    expect(state.phase.reason).toBe("stale_preview");
    expect(state.notice).toBe("The pool changed. Nothing was charged.");
  });
});

describe("ordering and identity boundaries", () => {
  it("accepts the next preview request after a selection change", () => {
    let state = readyState();
    const nextSelection: PreviewTarget = { pool: "second-pool", channel: "" };
    state = dispatch(state, {
      type: "selection/changed",
      scopeKey,
      selection: nextSelection,
    });
    expect(state.phase.status).toBe("loading");
    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: nextSelection,
    });
    expect(state.phase.status).toBe("loading");
    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 2,
      target: nextSelection,
      preview: preview({
        pool: {
          id: "pool_second",
          slug: "second-pool",
          name: "Second pool",
          description: "Another capsule.",
          revision: 1,
          price: 50,
          status: "active",
        },
        price: 50,
      }),
    });
    expect(state.phase.status).toBe("ready");
    expect(state.preview?.pool.slug).toBe("second-pool");
  });

  it("ignores a preview request with an older request id", () => {
    let state = readyState();
    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 3,
      target: selection,
    });
    const before = state.phase.status;
    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: selection,
    });
    expect(state.previewRequestId).toBe(3);
    expect(state.phase.status).toBe(before);
  });

  it("ignores an earlier preview response that arrives after a later request", () => {
    let state = readyState();
    const first = state.preview;
    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: selection,
    });
    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 1,
      target: selection,
      preview: preview({ price: 999 }),
    });
    expect(state.preview).toBe(first);
    expect(state.phase.status).toBe("loading");

    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 2,
      target: selection,
      preview: preview({ price: 90, expected_revision: 2, revision: 2 }),
    });
    expect(state.preview?.price).toBe(90);
    expect(state.phase.status).toBe("ready");
  });

  it("ignores a late receipt from an earlier operation", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const first = state.phase.operation;
    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: withOperationStatus(first, "committed"),
      receipt: receipt({ instance_id: "ins_first" }),
      source: "submit",
    });
    state = dispatch(state, {
      type: "reveal/show",
      scopeKey,
      operationKey: first.key,
    });
    state = dispatch(state, { type: "operation/reset", scopeKey });
    state = startDraw(state, "draw-key-00000002");
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: withOperationStatus(first, "committed"),
      receipt: receipt({ instance_id: "ins_late" }),
      source: "submit",
    });
    expect(state.phase.status).toBe("submitting");
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    expect(state.phase.operation.key).toBe("draw-key-00000002");
  });

  it("resets the operation and rejects late events after an account/Bot switch", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const old = state.phase.operation;
    state = dispatch(state, {
      type: "scope/changed",
      scopeKey: otherScopeKey,
      scope: otherScope,
      selection: { pool: "other-pool", channel: "family-table" },
      balance: 900,
    });
    expect(state.phase.status).toBe("loading");
    expect(state.scope).toEqual(otherScope);
    expect(state.selection).toEqual({
      pool: "other-pool",
      channel: "family-table",
    });
    expect(state.balance).toBe(900);

    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: withOperationStatus(old, "committed"),
      receipt: receipt({ instance_id: "ins_other" }),
      source: "reconcile",
    });
    expect(state.phase.status).toBe("loading");
    expect(state.balance).toBe(900);

    state = dispatch(state, {
      type: "reveal/replay",
      scopeKey,
      operationKey: old.key,
    });
    expect(state.phase.status).toBe("loading");
  });

  it("does not let a selection change replace an unconfirmed operation", () => {
    const state = startDraw(readyState());
    const next = dispatch(state, {
      type: "selection/changed",
      scopeKey,
      selection: { pool: "other-pool", channel: "" },
    });
    expect(next.selection).toEqual(selection);
    expect(next.phase.status).toBe("submitting");
  });

  it("shows a signed-out reconcile as unknown rather than releasing the key", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    const pending = withOperationStatus(state.phase.operation, "unknown");
    state = dispatch(state, {
      type: "draw/unknown",
      scopeKey,
      operation: pending,
      reason: "lost",
      message: "Response lost.",
      retryable: true,
    });
    state = dispatch(state, {
      type: "reconcile/started",
      scopeKey,
      operation: pending,
    });
    state = dispatch(state, {
      type: "reconcile/unknown",
      scopeKey,
      operation: pending,
      reason: "signed_out",
      message: "Sign in again.",
      retryable: true,
    });
    expect(state.phase.status).toBe("unknown");
    if (state.phase.status !== "unknown") throw new Error("not unknown");
    expect(state.phase.reason).toBe("signed_out");
    expect(state.phase.operation.key).toBe(pending.key);
  });
});

describe("operation persistence", () => {
  it("stores only the minimum protected operation fields", () => {
    const storage = new MemoryStorage();
    const op = operation(readyState());
    expect(saveOperation(storage, op)).toBe(true);

    const key = operationStorageKey(scope, "cabinet-draw");
    expect(key.startsWith(DRAW_OPERATION_PREFIX)).toBe(true);
    expect(key).toContain("test");
    expect(key).toContain("usr_player");
    expect(key).toContain("bot_cabinet");
    expect(key).toContain("cabinet-draw");

    const raw = storage.snapshot()[key];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "createdAt",
      "key",
      "payload",
      "scope",
      "status",
      "updatedAt",
      "version",
    ]);
    expect(raw).not.toContain("ins_1");
    expect(raw).not.toContain("FB-1");
    expect(raw).not.toContain("balance_after");
    expect(raw).not.toContain("receipt");

    const loaded = loadOperation(storage, scope, "cabinet-draw");
    expect(loaded).toEqual(op);
  });

  it("removes malformed records instead of trusting them", () => {
    const storage = new MemoryStorage();
    const key = operationStorageKey(scope, "cabinet-draw");
    storage.setItem(key, "{not-json");
    expect(loadOperation(storage, scope, "cabinet-draw")).toBeNull();
    expect(storage.getItem(key)).toBeNull();

    storage.setItem(key, JSON.stringify({ version: 1, key: "short" }));
    expect(loadOperation(storage, scope, "cabinet-draw")).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it("finds the newest recoverable operation across pools", () => {
    const storage = new MemoryStorage();
    const first = operation(readyState(), "draw-key-00000001", "2026-11-04T10:00:00.000Z");
    const second = operation(readyState(), "draw-key-00000002", "2026-11-04T10:05:00.000Z");
    saveOperation(storage, first);
    saveOperation(storage, {
      ...second,
      payload: { ...second.payload, pool: "second-pool" },
    });

    const found = findRecoverableOperation(storage, scope);
    expect(found?.key).toBe("draw-key-00000002");
    expect(found?.payload.pool).toBe("second-pool");
  });

  it("clears a different account or Bot but keeps same-scope pools", () => {
    const storage = new MemoryStorage();
    const mine = operation(readyState(), "draw-key-00000001");
    const myOtherPool = {
      ...operation(readyState(), "draw-key-00000002"),
      payload: { ...mine.payload, pool: "second-pool" },
    };
    const foreign = {
      ...operation(readyState(), "draw-key-00000003"),
      scope: otherScope,
    };
    saveOperation(storage, mine);
    saveOperation(storage, myOtherPool);
    saveOperation(storage, foreign);

    const removed = clearForeignOperations(storage, scope);
    expect(removed).toEqual([operationStorageKey(otherScope, "cabinet-draw")]);
    expect(loadOperation(storage, scope, "cabinet-draw")).not.toBeNull();
    expect(loadOperation(storage, scope, "second-pool")).not.toBeNull();
    expect(loadOperation(storage, otherScope, "cabinet-draw")).toBeNull();

    const all = clearOperationsForScope(storage, scope);
    expect(all).toHaveLength(2);
    expect(findRecoverableOperation(storage, scope)).toBeNull();
  });

  it("removes exactly one deliberate reset", () => {
    const storage = new MemoryStorage();
    const mine = operation(readyState(), "draw-key-00000001");
    const other = {
      ...operation(readyState(), "draw-key-00000002"),
      payload: { ...mine.payload, pool: "second-pool" },
    };
    saveOperation(storage, mine);
    saveOperation(storage, other);
    removeOperation(storage, scope, "cabinet-draw");
    expect(loadOperation(storage, scope, "cabinet-draw")).toBeNull();
    expect(loadOperation(storage, scope, "second-pool")).not.toBeNull();
  });

  it("keeps a persisted request byte-identical for replay", () => {
    const storage = new MemoryStorage();
    const op = operation(readyState());
    saveOperation(storage, op);
    const loaded = loadOperation(storage, scope, "cabinet-draw");
    expect(loaded).not.toBeNull();
    expect(operationBody(loaded!)).toEqual(operationBody(op));
    const first = JSON.stringify(operationBody(op));
    const second = JSON.stringify(operationBody(loaded!));
    expect(second).toBe(first);
  });
});

describe("failure classification and reduced motion", () => {
  it("separates lost outcomes from definitive rejections", () => {
    expect(classifyDrawFailure({ status: 500, message: "Server error" })).toMatchObject({
      kind: "unknown",
      retryable: true,
    });
    expect(classifyDrawFailure({ message: "Network down" })).toMatchObject({
      kind: "unknown",
      retryable: true,
    });
    expect(classifyDrawFailure({ status: 401, message: "Sign in" })).toMatchObject({
      kind: "auth",
    });
    expect(
      classifyDrawFailure({
        status: 409,
        code: "stale_distribution",
        message: "Odds changed",
      }),
    ).toMatchObject({ kind: "rejected", reason: "stale_preview" });
    expect(
      classifyDrawFailure({
        status: 409,
        code: "idempotency_conflict",
        message: "Different body",
      }),
    ).toMatchObject({ kind: "conflict" });
    expect(
      classifyDrawFailure({
        status: 409,
        code: "draw_conflict",
        message: "Collided with another request",
      }),
    ).toMatchObject({ kind: "unknown", retryable: true });
    expect(classifyDrawFailure({ status: 422, message: "Invalid" })).toMatchObject({
      kind: "rejected",
      reason: "request_rejected",
    });
    expect(classifyDrawFailure({ message: "Aborted", aborted: true })).toEqual({
      kind: "aborted",
    });
  });

  it("reveals immediately when reduced motion is requested", () => {
    expect(revealDelayMs(true)).toBe(0);
    expect(revealDelayMs(false)).toBeNull();
    expect(revealDelayMs(false, true)).toBeNull();
    expect(revealDelayMs(true, true)).toBe(0);
  });

  it("keeps committed receipts when a later balance changes", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    state = dispatch(state, {
      type: "draw/committed",
      scopeKey,
      operation: withOperationStatus(state.phase.operation, "committed"),
      receipt: receipt(),
      source: "submit",
      balance: 420,
    });
    state = dispatch(state, {
      type: "balance/updated",
      scopeKey,
      balance: 1200,
    });
    expect(state.phase.status).toBe("committed");
    expect(state.balance).toBe(1200);
  });

  it("retains a stale-odds notice after the refreshed preview becomes ready", () => {
    let state = startDraw(readyState());
    if (state.phase.status !== "submitting") throw new Error("not submitting");
    state = dispatch(state, {
      type: "draw/rejected",
      scopeKey,
      operationKey: state.phase.operation.key,
      reason: "stale_preview",
      message: "The capsule changed.",
    });
    expect(state.phase.status).toBe("blocked");
    expect(state.notice).toBe("The capsule changed.");

    state = dispatch(state, {
      type: "preview/requested",
      scopeKey,
      requestId: 2,
      target: selection,
    });
    state = dispatch(state, {
      type: "preview/succeeded",
      scopeKey,
      requestId: 2,
      target: selection,
      preview: preview({ revision: 2, expected_revision: 2, price: 90 }),
    });
    expect(state.phase.status).toBe("ready");
    expect(state.notice).toBe("The capsule changed.");
    expect(state.preview?.price).toBe(90);
  });
});
