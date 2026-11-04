import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { Ctx, CurrentUser, Tenant } from "../../src/server/context";
import {
  DiscordDrawClock,
  DiscordDrawDelivery,
  DiscordDrawDeliveryPermanent,
  DiscordDrawDomain,
  DiscordDrawEmptyPool,
  DiscordDrawIdentity,
  DiscordDrawInsufficientFoil,
  DiscordDrawInteractions,
  DiscordDrawPolicy,
  DiscordDrawProviderPermanent,
  DiscordDrawProviderTransient,
  DiscordDrawRandom,
  DiscordDrawReceipts,
  DiscordDrawReplies,
  DiscordDrawStaleConsent,
  DiscordDrawUnauthenticated,
  DiscordDrawUnknownCommitOutcome,
  defaultDiscordDrawPolicy,
  discordDrawErrorShape,
  failureFromApiError,
  runDiscordDrawWorkflow,
  type DiscordDrawCommitted,
  type DiscordDrawDeliveryOutcome,
  type DiscordDrawFailure,
  type DiscordDrawOutcome,
  type DiscordDrawPlan,
  type DiscordDrawPolicyShape,
  type DiscordDrawPreparation,
  type DiscordDrawPrincipal,
  type DiscordDrawRequest,
  type DiscordDrawSession,
} from "../../src/server/effect/discord-draw-workflow";
import type { DrawReceipt } from "../../src/server/discord/draw-types";
import { drawReceiptFromResult } from "../../src/server/discord/receipts";
import type {
  DiscordCallback,
  DiscordInstallation,
  DiscordInteraction,
} from "../../src/server/discord/types";

interface HarnessState {
  prepares: number;
  commits: number;
  debits: number;
  reconciles: number;
  presents: number;
  begins: number;
  abandons: number;
  receipts: Array<{ interactionId: string; receipt: ReturnType<typeof drawReceiptFromResult> }>;
  deliveries: Array<{ interactionId: string; callback: DiscordCallback }>;
  finishes: Array<{
    status: "completed" | "failed";
    errorCode?: string;
    visibility?: string;
  }>;
  sleeps: number[];
  failures: string[];
  recoveries: string[];
  principals: string[];
  original: DiscordDrawCommitted | null;
}

interface Harness {
  state: HarnessState;
  identity: DiscordDrawIdentity["Service"];
  domain: DiscordDrawDomain["Service"];
  receipts: DiscordDrawReceipts["Service"];
  delivery: DiscordDrawDelivery["Service"];
  interactions: DiscordDrawInteractions["Service"];
  replies: DiscordDrawReplies["Service"];
  clock: DiscordDrawClock["Service"];
  random: DiscordDrawRandom["Service"];
  policy: DiscordDrawPolicyShape;
}

interface HarnessOptions {
  principal?: (request: DiscordDrawRequest) => DiscordDrawPrincipal;
  prepare?: (
    input: {
      principal: DiscordDrawPrincipal;
      interaction: DiscordInteraction;
      requestedPool?: string;
      idempotencyKey: string;
    },
    state: HarnessState,
  ) => Effect.Effect<DiscordDrawPreparation, DiscordDrawFailure>;
  commit?: (
    input: { principal: DiscordDrawPrincipal; plan: DiscordDrawPlan },
    state: HarnessState,
  ) => Effect.Effect<DiscordDrawCommitted, DiscordDrawFailure>;
  reconcile?: (
    input: { principal: DiscordDrawPrincipal; plan: DiscordDrawPlan },
    state: HarnessState,
  ) => Effect.Effect<DiscordDrawCommitted | null, DiscordDrawFailure>;
  present?: (
    input: {
      principal: DiscordDrawPrincipal;
      interaction: DiscordInteraction;
      plan: DiscordDrawPlan;
      committed: DiscordDrawCommitted;
    },
    state: HarnessState,
  ) => Effect.Effect<DiscordCallback, DiscordDrawFailure>;
  deliver?: (
    interaction: DiscordInteraction,
    callback: DiscordCallback,
    state: HarnessState,
  ) => Effect.Effect<DiscordDrawDeliveryOutcome, DiscordDrawDeliveryPermanent>;
  recordReceipt?: (
    input: { interactionId: string; receipt: ReturnType<typeof drawReceiptFromResult> },
    state: HarnessState,
  ) => Effect.Effect<void, DiscordDrawFailure>;
  policy?: Partial<DiscordDrawPolicyShape>;
  randomValues?: number[];
}

const TENANT_A = "ten_alpha";
const TENANT_B = "ten_beta";

function interactionFor(id: string): DiscordInteraction {
  return {
    id,
    application_id: "app-test",
    type: 2,
    token: "interaction-token",
    version: 1,
    guild_id: "guild-test",
    channel_id: "channel-test",
    data: {
      name: "foilbury",
      options: [{ name: "open", type: 1, options: [] }],
    },
  } as DiscordInteraction;
}

function requestFor(id = "interaction-1"): DiscordDrawRequest {
  return {
    interaction: interactionFor(id),
    applicationId: "app-test",
    requestedPool: "test-pool",
    idempotencyKey: `discord:${id}:open`,
  };
}

function planFor(tenantId: string): DiscordDrawPlan {
  return {
    poolSlug: "test-pool",
    expectedRevision: 1,
    expectedDistribution: `fingerprint-${tenantId}`,
    channelKey: "channel-key",
    idempotency: {
      key: `discord:interaction-1:open`,
      digest: `digest-${tenantId}`,
    },
  };
}

function drawResultFor(tenantId: string): DrawReceipt {
  return {
    draw_id: `drw_${tenantId}`,
    instance_id: `ins_${tenantId}`,
    card_id: `card_${tenantId}`,
    variant_id: `variant_${tenantId}`,
    card_name: `Test Card ${tenantId}`,
    edition_name: "Test edition",
    variant_name: "Plain",
    material_key: "plain",
    effect_key: null,
    render_url: null,
    serial: `FB-1-${tenantId}`,
    pool_name: "Test pool",
    price: 80,
    currency: { name: "Foil", symbol: "✦" },
    balance_after: 20,
    balance_after_debit: 20,
    probability_bps: 10_000,
    drawn_at: "2026-11-04T00:00:00.000Z",
    replayed: false,
  };
}

function committedFor(tenantId: string): DiscordDrawCommitted {
  const result = drawResultFor(tenantId);
  return {
    result,
    receipt: drawReceiptFromResult(result),
    replayed: false,
  };
}

function principalFor(tenantId: string): DiscordDrawPrincipal {
  const tenant: Tenant = { id: tenantId, slug: tenantId, name: `Tenant ${tenantId}` };
  const user: CurrentUser = {
    id: `usr_${tenantId}`,
    email: `${tenantId}@example.test`,
    displayName: `Player ${tenantId}`,
    role: "player",
    platformAdmin: false,
  };
  const ctx = { tenant, user } as unknown as Ctx;
  const installation = {
    id: `installation_${tenantId}`,
    tenant_id: tenantId,
    application_id: "app-test",
    guild_id: "guild-test",
    guild_name: "Test guild",
    channel_allowlist_json: "[]",
    channel_key: "channel-key",
    channel_audience_json: "{}",
    game_enabled: 1,
    website_enabled: 1,
    api_enabled: 1,
    public_catalogue_enabled: 1,
    admin_gui_enabled: 1,
    active: 1,
    installed_by_discord_id: null,
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    revoked_at: null,
  } as DiscordInstallation;
  return { ctx, tenant, user, installation };
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const state: HarnessState = {
    prepares: 0,
    commits: 0,
    debits: 0,
    reconciles: 0,
    presents: 0,
    begins: 0,
    abandons: 0,
    receipts: [],
    deliveries: [],
    finishes: [],
    sleeps: [],
    failures: [],
    recoveries: [],
    principals: [],
    original: null,
  };
  const randomValues = options.randomValues ?? [];
  let randomIndex = 0;
  const policy: DiscordDrawPolicyShape = {
    ...defaultDiscordDrawPolicy,
    attemptTimeoutMs: 100,
    maxAttempts: 3,
    commitAttempts: 2,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
    jitterRatio: 0,
    ...options.policy,
  };

  const identity: DiscordDrawIdentity["Service"] = {
    resolve: (request) =>
      Effect.sync(() => {
        const principal = options.principal?.(request) ?? principalFor(TENANT_A);
        state.principals.push(principal.tenant.id);
        return principal;
      }),
  };

  const domain: DiscordDrawDomain["Service"] = {
    prepare: (input) =>
      options.prepare?.(input, state) ??
      Effect.sync(() => {
        state.prepares += 1;
        return { kind: "draw" as const, plan: planFor(input.principal.tenant.id) };
      }),
    commit: (input) =>
      options.commit?.(input, state) ??
      Effect.sync(() => {
        state.commits += 1;
        state.debits += 1;
        return committedFor(input.principal.tenant.id);
      }),
    reconcile: (input) => options.reconcile?.(input, state) ?? Effect.succeed(state.original),
    present: (input) =>
      options.present?.(input, state) ??
      Effect.sync(() => {
        state.presents += 1;
        return {
          type: 4,
          data: {
            content: `reveal:${input.committed.receipt.draw_id}`,
            flags: 64,
          },
        } satisfies DiscordCallback;
      }),
  };

  const receipts: DiscordDrawReceipts["Service"] = {
    record: (input) =>
      options.recordReceipt?.(input, state) ??
      Effect.sync(() => {
        state.receipts.push(input);
      }),
    read: () => Effect.sync(() => state.receipts.at(-1)?.receipt ?? null),
  };

  const delivery: DiscordDrawDelivery["Service"] = {
    deliver: (interaction, callback) =>
      options.deliver?.(interaction, callback, state) ??
      Effect.sync(() => {
        state.deliveries.push({ interactionId: interaction.id, callback });
        return {
          delivered: true,
          visibility: "private" as const,
        };
      }),
  };

  const interactions: DiscordDrawInteractions["Service"] = {
    begin: (interaction) =>
      Effect.sync(() => {
        state.begins += 1;
        return { interactionId: interaction.id } satisfies DiscordDrawSession;
      }),
    finish: (session, outcome) =>
      Effect.sync(() => {
        state.finishes.push({
          status: outcome.status,
          errorCode: outcome.errorCode,
          visibility: outcome.visibility,
        });
        void session;
      }),
    abandon: () =>
      Effect.sync(() => {
        state.abandons += 1;
      }),
  };

  const replies: DiscordDrawReplies["Service"] = {
    failure: (failure) => {
      state.failures.push(failure._tag);
      return {
        type: 4,
        data: { content: `failure:${failure._tag}`, flags: 64 },
      } satisfies DiscordCallback;
    },
    recovery: (input) => {
      state.recoveries.push(input.receipt.draw_id);
      return {
        type: 4,
        data: { content: `recovery:${input.receipt.draw_id}`, flags: 64 },
      } satisfies DiscordCallback;
    },
  };

  const clock: DiscordDrawClock["Service"] = {
    sleep: (milliseconds) =>
      Effect.sync(() => {
        state.sleeps.push(milliseconds);
      }),
  };

  const random: DiscordDrawRandom["Service"] = {
    next: () =>
      Effect.sync(() => {
        const value = randomValues[randomIndex] ?? 0;
        randomIndex += 1;
        return value;
      }),
  };

  return {
    state,
    identity,
    domain,
    receipts,
    delivery,
    interactions,
    replies,
    clock,
    random,
    policy,
  };
}

function provide(
  program: ReturnType<typeof runDiscordDrawWorkflow>,
  harness: Harness,
): ReturnType<typeof runDiscordDrawWorkflow> {
  return program.pipe(
    Effect.provideService(DiscordDrawIdentity, harness.identity),
    Effect.provideService(DiscordDrawDomain, harness.domain),
    Effect.provideService(DiscordDrawReceipts, harness.receipts),
    Effect.provideService(DiscordDrawDelivery, harness.delivery),
    Effect.provideService(DiscordDrawInteractions, harness.interactions),
    Effect.provideService(DiscordDrawReplies, harness.replies),
    Effect.provideService(DiscordDrawClock, harness.clock),
    Effect.provideService(DiscordDrawRandom, harness.random),
    Effect.provideService(DiscordDrawPolicy, harness.policy),
  );
}

async function runWorkflow(harness: Harness, request = requestFor()): Promise<DiscordDrawOutcome> {
  const exit = await Effect.runPromiseExit(provide(runDiscordDrawWorkflow(request), harness));
  if (Exit.isFailure(exit)) {
    throw new Error(Cause.pretty(exit.cause));
  }
  return exit.value;
}

function transientFailure(operation = "prepare", retryAfterMs: number | null = null) {
  return new DiscordDrawProviderTransient({
    operation,
    message: "provider is temporarily unavailable",
    retryAfterMs,
  });
}

const neverPreparation: Effect.Effect<DiscordDrawPreparation, DiscordDrawFailure> =
  Effect.never as Effect.Effect<DiscordDrawPreparation, DiscordDrawFailure>;

describe("Effect-owned Discord draw workflow", () => {
  it("commits once, persists the receipt and delivers the reveal", async () => {
    const harness = makeHarness();
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "completed",
      delivered: true,
      committed: true,
    });
    expect(outcome.errorCode).toBeUndefined();
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(1);
    expect(harness.state.reconciles).toBe(0);
    expect(harness.state.receipts).toHaveLength(1);
    expect(harness.state.receipts[0]!.receipt.draw_id).toBe(`drw_${TENANT_A}`);
    expect(harness.state.deliveries).toHaveLength(1);
    expect(harness.state.deliveries[0]!.callback.data?.content).toContain(`reveal:drw_${TENANT_A}`);
    expect(harness.state.finishes).toEqual([
      { status: "completed", errorCode: undefined, visibility: "private" },
    ]);
    // The scope finalizer always runs and the production implementation makes
    // it a conditional no-op after a terminal finish.
    expect(harness.state.abandons).toBe(1);
  });

  it("recovers from the persisted receipt when commit reconciliation is unavailable", async () => {
    const harness = makeHarness({
      commit: (_input, state) => {
        state.commits += 1;
        return Effect.fail(
          new DiscordDrawUnknownCommitOutcome({
            message: "the provider lost the acknowledgement",
          }),
        );
      },
      reconcile: (_input, state) => {
        state.reconciles += 1;
        return Effect.succeed(null);
      },
      policy: { commitAttempts: 1 },
    });
    harness.state.receipts.push({
      interactionId: "interaction-1",
      receipt: committedFor(TENANT_A).receipt,
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "completed",
      delivered: true,
      committed: true,
      errorCode: "delivery_recovered",
    });
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(0);
    expect(harness.state.reconciles).toBe(1);
    expect(harness.state.recoveries).toEqual([`drw_${TENANT_A}`]);
    expect(harness.state.deliveries[0]!.callback.data?.content).toContain(
      `recovery:drw_${TENANT_A}`,
    );
  });

  it("runs cancellation finalisers without finishing or delivering", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const harness = makeHarness({
          commit: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.asVoid,
              Effect.andThen(
                Effect.never as Effect.Effect<DiscordDrawCommitted, DiscordDrawFailure>,
              ),
            ),
        });
        const fiber = yield* Effect.forkChild(
          provide(runDiscordDrawWorkflow(requestFor()), harness),
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        return harness.state;
      }),
    );

    expect(state.begins).toBe(1);
    expect(state.abandons).toBe(1);
    expect(state.finishes).toHaveLength(0);
    expect(state.deliveries).toHaveLength(0);
    expect(state.commits).toBe(0);
  });

  it("bounds each attempt with a deadline and reports a typed timeout", async () => {
    const harness = makeHarness({
      prepare: () => neverPreparation,
      policy: { attemptTimeoutMs: 10, maxAttempts: 2 },
    });
    const outcome = await runWorkflow(harness);

    expect(outcome.status).toBe("completed");
    expect(outcome.errorCode).toBe("draw_timeout");
    expect(harness.state.prepares).toBe(0);
    expect(harness.state.failures).toEqual(["DiscordDrawTimeout"]);
    expect(harness.state.commits).toBe(0);
  });

  it("retries a transient provider failure and stops at the bounded attempt count", async () => {
    const harness = makeHarness({
      prepare: () => Effect.fail(transientFailure("prepare", 40)),
      policy: { maxAttempts: 3, baseBackoffMs: 10, maxBackoffMs: 100 },
    });
    const outcome = await runWorkflow(harness);

    expect(outcome.errorCode).toBe("draw_provider_unavailable");
    expect(harness.state.sleeps).toEqual([40, 40]);
    expect(harness.state.failures).toEqual(["DiscordDrawProviderTransient"]);
    expect(harness.state.commits).toBe(0);
  });

  it("retries a transient provider failure and then commits once", async () => {
    let attempts = 0;
    const harness = makeHarness({
      prepare: ({ principal }) =>
        Effect.suspend(() => {
          attempts += 1;
          if (attempts === 1) return Effect.fail(transientFailure("prepare"));
          return Effect.succeed({ kind: "draw" as const, plan: planFor(principal.tenant.id) });
        }),
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({ status: "completed", committed: true });
    expect(attempts).toBe(2);
    expect(harness.state.sleeps).toHaveLength(1);
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(1);
  });

  it("keeps concurrent tenants isolated through the service context", async () => {
    const mismatches: string[] = [];
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareFor =
      (expected: string) =>
      ({ principal }: { principal: DiscordDrawPrincipal }) =>
        Effect.promise(async () => {
          if (principal.tenant.id !== expected) {
            mismatches.push(`${expected}->${principal.tenant.id}`);
          }
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
          return { kind: "draw" as const, plan: planFor(principal.tenant.id) };
        });

    const alpha = makeHarness({
      principal: () => principalFor(TENANT_A),
      prepare: prepareFor(TENANT_A),
    });
    const beta = makeHarness({
      principal: () => principalFor(TENANT_B),
      prepare: prepareFor(TENANT_B),
    });

    const [alphaOutcome, betaOutcome] = await Promise.all([
      runWorkflow(alpha, requestFor("interaction-alpha")),
      runWorkflow(beta, requestFor("interaction-beta")),
    ]);

    expect(alphaOutcome.committed).toBe(true);
    expect(betaOutcome.committed).toBe(true);
    expect(mismatches).toEqual([]);
    expect(alpha.state.principals).toEqual([TENANT_A]);
    expect(beta.state.principals).toEqual([TENANT_B]);
    expect(alpha.state.deliveries[0]!.callback.data?.content).toContain(`drw_${TENANT_A}`);
    expect(beta.state.deliveries[0]!.callback.data?.content).toContain(`drw_${TENANT_B}`);
  });

  it("reconciles an ambiguous commit to the original receipt with one debit", async () => {
    let harness!: Harness;
    harness = makeHarness({
      commit: (_input, state) => {
        state.commits += 1;
        state.debits += 1;
        state.original = committedFor(TENANT_A);
        return Effect.fail(
          new DiscordDrawUnknownCommitOutcome({
            message: "the provider lost the acknowledgement",
          }),
        );
      },
      reconcile: (_input, state) => {
        state.reconciles += 1;
        return Effect.succeed(state.original);
      },
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "completed",
      delivered: true,
      committed: true,
    });
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(1);
    expect(harness.state.reconciles).toBe(1);
    expect(harness.state.receipts).toHaveLength(1);
    expect(harness.state.receipts[0]!.receipt.draw_id).toBe(`drw_${TENANT_A}`);
    expect(harness.state.deliveries[0]!.callback.data?.content).toContain(`reveal:drw_${TENANT_A}`);
  });

  it("does not blindly redraw when an ambiguous commit cannot be reconciled", async () => {
    const harness = makeHarness({
      commit: (_input, state) => {
        state.commits += 1;
        return Effect.fail(
          new DiscordDrawUnknownCommitOutcome({
            message: "the provider lost the acknowledgement",
          }),
        );
      },
      reconcile: (_input, state) => {
        state.reconciles += 1;
        return Effect.succeed(null);
      },
      policy: { commitAttempts: 1 },
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "failed",
      delivered: true,
      committed: false,
      errorCode: "unknown_commit_outcome",
    });
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(0);
    expect(harness.state.reconciles).toBe(1);
    expect(harness.state.receipts).toHaveLength(0);
    expect(harness.state.failures).toEqual(["DiscordDrawUnknownCommitOutcome"]);
  });

  it("recovers a committed draw when presentation fails after the commit", async () => {
    const harness = makeHarness({
      present: () =>
        Effect.fail(
          new DiscordDrawProviderPermanent({
            operation: "presentation",
            message: "render lookup failed",
            status: 500,
          }),
        ),
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "completed",
      delivered: true,
      committed: true,
      errorCode: "delivery_recovered",
    });
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(1);
    expect(harness.state.receipts).toHaveLength(1);
    expect(harness.state.recoveries).toEqual([`drw_${TENANT_A}`]);
    expect(harness.state.deliveries[0]!.callback.data?.content).toContain(
      `recovery:drw_${TENANT_A}`,
    );
  });

  it("records a committed draw as completed when delivery fails", async () => {
    const harness = makeHarness({
      deliver: () =>
        Effect.fail(
          new DiscordDrawDeliveryPermanent({
            operation: "delivery",
            message: "Discord timed out",
            status: null,
          }),
        ),
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "completed",
      delivered: false,
      committed: true,
      errorCode: "delivery_failed",
    });
    expect(harness.state.commits).toBe(1);
    expect(harness.state.debits).toBe(1);
    expect(harness.state.receipts).toHaveLength(1);
    expect(harness.state.finishes[0]!.status).toBe("completed");
  });

  it("delivers a typed empty-pool failure without committing", async () => {
    const harness = makeHarness({
      prepare: () =>
        Effect.fail(
          new DiscordDrawEmptyPool({
            message: "This pool has no eligible cards.",
            emptyReason: "no entries",
          }),
        ),
    });
    const outcome = await runWorkflow(harness);

    expect(outcome).toMatchObject({
      status: "completed",
      errorCode: "empty_pool",
      committed: false,
    });
    expect(harness.state.commits).toBe(0);
    expect(harness.state.failures).toEqual(["DiscordDrawEmptyPool"]);
    expect(harness.state.deliveries[0]!.callback.data?.content).toContain(
      "failure:DiscordDrawEmptyPool",
    );
  });

  it("maps typed failures to the existing API/Discord error shape once", () => {
    expect(discordDrawErrorShape(new DiscordDrawUnauthenticated({ message: "sign in" }))).toEqual({
      status: 401,
      code: "authentication_required",
      message: "sign in",
    });
    expect(
      discordDrawErrorShape(
        new DiscordDrawStaleConsent({
          reason: "distribution",
          message: "consent changed",
          expectedRevision: 4,
          expectedDistribution: "fingerprint",
        }),
      ),
    ).toMatchObject({
      status: 409,
      code: "stale_distribution",
      details: { expected_revision: 4, expected_distribution: "fingerprint" },
    });
    expect(
      discordDrawErrorShape(
        new DiscordDrawInsufficientFoil({
          message: "not enough",
          balance: 10,
          price: 80,
          currencySymbol: "✦",
        }),
      ),
    ).toMatchObject({ status: 409, code: "insufficient_funds" });
    expect(
      failureFromApiError({
        status: 409,
        code: "stale_pool_revision",
        message: "pool changed",
        details: { expected_revision: 5, expected_distribution: "next" },
      }),
    ).toBeInstanceOf(DiscordDrawStaleConsent);
    expect(
      failureFromApiError({
        status: 401,
        code: "authentication_required",
        message: "sign in",
      }),
    ).toBeInstanceOf(DiscordDrawUnauthenticated);
    expect(
      failureFromApiError({
        status: 409,
        code: "idempotency_conflict",
        message: "different request",
      })._tag,
    ).toBe("DiscordDrawIdempotencyConflict");
  });
});
