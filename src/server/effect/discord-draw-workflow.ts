/**
 * Effect-owned Discord draw lifecycle.
 *
 * This module is deliberately free of Worker-only imports. It describes the
 * workflow, its request-scoped services, typed failures and bounded retry
 * policy. Production adapters live in `src/server/discord/draw-runtime.ts`.
 *
 * The workflow owns:
 *
 * 1. request-scoped identity, tenant and Bot installation resolution;
 * 2. consent preparation through the existing pool preview;
 * 3. one domain commit through the shared `executeDraw` service;
 * 4. durable receipt persistence;
 * 5. presentation through the existing Discord builders;
 * 6. delivery through the existing bounded transport;
 * 7. reconciliation and recovery from the original receipt after a failure.
 *
 * It never creates a second economy and never calls the draw service again
 * after a commit is known or suspected.
 */
import { Cause, Context, Data, Duration, Effect, Exit, Option } from "effect";
import type { Ctx, CurrentUser, Tenant } from "../context";
import type { DrawReceipt } from "../discord/draw-types";
import type { DiscordDrawReceipt } from "../discord/receipts";
import type { DiscordCallback, DiscordInstallation, DiscordInteraction } from "../discord/types";

export type DiscordDeliveryVisibility = "private" | "public" | "private_fallback";

export interface DiscordDrawPrincipal {
  readonly ctx: Ctx;
  readonly tenant: Tenant;
  readonly user: CurrentUser;
  readonly installation: DiscordInstallation;
}

export interface DiscordDrawRequest {
  readonly interaction: DiscordInteraction;
  readonly applicationId: string;
  readonly requestedPool?: string;
  readonly idempotencyKey: string;
  readonly allowDisabledGame?: boolean;
}

export interface DiscordDrawPlan {
  readonly poolSlug: string;
  readonly expectedRevision: number;
  readonly expectedDistribution: string;
  readonly channelKey?: string;
  readonly idempotency: { readonly key: string; readonly digest: string };
}

export type DiscordDrawPreparation =
  | { readonly kind: "draw"; readonly plan: DiscordDrawPlan }
  | { readonly kind: "respond"; readonly callback: DiscordCallback };

export interface DiscordDrawCommitted {
  readonly result: DrawReceipt;
  readonly receipt: DiscordDrawReceipt;
  readonly replayed: boolean;
}

export interface DiscordDrawSession {
  readonly interactionId: string;
}

export interface DiscordDrawDeliveryOutcome {
  readonly delivered: boolean;
  readonly visibility: DiscordDeliveryVisibility;
}

export interface DiscordDrawOutcome {
  readonly status: "completed" | "failed";
  readonly delivered: boolean;
  readonly committed: boolean;
  readonly errorCode?: string;
  readonly visibility?: DiscordDeliveryVisibility;
}

export interface DiscordDrawPolicyShape {
  /** Deadline for one provider/presentation attempt, including its own work. */
  readonly attemptTimeoutMs: number;
  /** Total attempts for read-only transient provider work. */
  readonly maxAttempts: number;
  /** Total commit attempts after reconciliation. */
  readonly commitAttempts: number;
  /** A draw commit plus achievement settlement can exceed the short provider deadline. */
  readonly commitTimeoutMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Fraction of jitter applied either side of the exponential delay. */
  readonly jitterRatio: number;
}

export class DiscordDrawIdentity extends Context.Service<
  DiscordDrawIdentity,
  {
    readonly resolve: (
      request: DiscordDrawRequest,
    ) => Effect.Effect<DiscordDrawPrincipal, DiscordDrawFailure>;
  }
>()("DiscordDrawIdentity") {}

export class DiscordDrawDomain extends Context.Service<
  DiscordDrawDomain,
  {
    readonly prepare: (input: {
      readonly principal: DiscordDrawPrincipal;
      readonly interaction: DiscordInteraction;
      readonly requestedPool?: string;
      readonly idempotencyKey: string;
    }) => Effect.Effect<DiscordDrawPreparation, DiscordDrawFailure>;
    readonly commit: (input: {
      readonly principal: DiscordDrawPrincipal;
      readonly plan: DiscordDrawPlan;
    }) => Effect.Effect<DiscordDrawCommitted, DiscordDrawFailure>;
    /**
     * Read the original commit by idempotency key. This must never create,
     * debit or roll another card.
     */
    readonly reconcile: (input: {
      readonly principal: DiscordDrawPrincipal;
      readonly plan: DiscordDrawPlan;
      readonly interaction: DiscordInteraction;
    }) => Effect.Effect<DiscordDrawCommitted | null, DiscordDrawFailure>;
    readonly present: (input: {
      readonly principal: DiscordDrawPrincipal;
      readonly interaction: DiscordInteraction;
      readonly plan: DiscordDrawPlan;
      readonly committed: DiscordDrawCommitted;
    }) => Effect.Effect<DiscordCallback, DiscordDrawFailure>;
  }
>()("DiscordDrawDomain") {}

export class DiscordDrawReceipts extends Context.Service<
  DiscordDrawReceipts,
  {
    readonly record: (input: {
      readonly interactionId: string;
      readonly receipt: DiscordDrawReceipt;
    }) => Effect.Effect<void, DiscordDrawFailure>;
    readonly read: (input: {
      readonly interactionId: string;
    }) => Effect.Effect<DiscordDrawReceipt | null, DiscordDrawFailure>;
  }
>()("DiscordDrawReceipts") {}

export class DiscordDrawDelivery extends Context.Service<
  DiscordDrawDelivery,
  {
    readonly deliver: (
      interaction: DiscordInteraction,
      callback: DiscordCallback,
    ) => Effect.Effect<
      DiscordDrawDeliveryOutcome,
      DiscordDrawDeliveryTransient | DiscordDrawDeliveryPermanent
    >;
  }
>()("DiscordDrawDelivery") {}

export class DiscordDrawInteractions extends Context.Service<
  DiscordDrawInteractions,
  {
    readonly begin: (interaction: DiscordInteraction) => Effect.Effect<DiscordDrawSession>;
    readonly finish: (
      session: DiscordDrawSession,
      outcome: DiscordDrawOutcome,
    ) => Effect.Effect<void>;
    /**
     * Conditional terminal update for cancellation. It must only touch a row
     * that is still `processing`, so it can never overwrite a completed result.
     */
    readonly abandon: (session: DiscordDrawSession) => Effect.Effect<void>;
  }
>()("DiscordDrawInteractions") {}

export class DiscordDrawReplies extends Context.Service<
  DiscordDrawReplies,
  {
    readonly failure: (failure: DiscordDrawFailure) => DiscordCallback;
    readonly recovery: (input: {
      readonly receipt: DiscordDrawReceipt;
      readonly interactionId: string;
      readonly reason: string;
    }) => DiscordCallback;
  }
>()("DiscordDrawReplies") {}

export class DiscordDrawClock extends Context.Service<
  DiscordDrawClock,
  { readonly sleep: (milliseconds: number) => Effect.Effect<void> }
>()("DiscordDrawClock") {}

export class DiscordDrawRandom extends Context.Service<
  DiscordDrawRandom,
  { readonly next: () => Effect.Effect<number> }
>()("DiscordDrawRandom") {}

export class DiscordDrawPolicy extends Context.Service<DiscordDrawPolicy, DiscordDrawPolicyShape>()(
  "DiscordDrawPolicy",
) {}

export class DiscordDrawUnauthenticated extends Data.TaggedError("DiscordDrawUnauthenticated")<{
  readonly message: string;
}> {}

export class DiscordDrawForbidden extends Data.TaggedError("DiscordDrawForbidden")<{
  readonly code: string;
  readonly message: string;
}> {}

export class DiscordDrawStaleConsent extends Data.TaggedError("DiscordDrawStaleConsent")<{
  readonly reason: "revision" | "distribution";
  readonly message: string;
  readonly expectedRevision: number;
  readonly expectedDistribution: string;
}> {}

export class DiscordDrawEmptyPool extends Data.TaggedError("DiscordDrawEmptyPool")<{
  readonly message: string;
  readonly emptyReason?: string;
}> {}

export class DiscordDrawInsufficientFoil extends Data.TaggedError("DiscordDrawInsufficientFoil")<{
  readonly message: string;
  readonly balance: number;
  readonly price: number;
  readonly currencySymbol: string;
}> {}

export class DiscordDrawInvalidTransition extends Data.TaggedError("DiscordDrawInvalidTransition")<{
  readonly code: string;
  readonly message: string;
}> {}

export class DiscordDrawIdempotencyConflict extends Data.TaggedError(
  "DiscordDrawIdempotencyConflict",
)<{
  readonly message: string;
  readonly key: string;
}> {}

export class DiscordDrawProviderTransient extends Data.TaggedError("DiscordDrawProviderTransient")<{
  readonly operation: string;
  readonly message: string;
  readonly retryAfterMs: number | null;
}> {}

export class DiscordDrawProviderPermanent extends Data.TaggedError("DiscordDrawProviderPermanent")<{
  readonly operation: string;
  readonly message: string;
  readonly status: number | null;
}> {}

export class DiscordDrawDeliveryTransient extends Data.TaggedError("DiscordDrawDeliveryTransient")<{
  readonly operation: string;
  readonly message: string;
  readonly retryAfterMs: number | null;
  /** Only an explicitly idempotent delivery may be repeated by the workflow. */
  readonly safeToRetry: boolean;
}> {}

export class DiscordDrawDeliveryPermanent extends Data.TaggedError("DiscordDrawDeliveryPermanent")<{
  readonly operation: string;
  readonly message: string;
  readonly status: number | null;
}> {}

export class DiscordDrawUnknownCommitOutcome extends Data.TaggedError(
  "DiscordDrawUnknownCommitOutcome",
)<{
  readonly message: string;
  readonly cause?: string;
}> {}

export class DiscordDrawTimeout extends Data.TaggedError("DiscordDrawTimeout")<{
  readonly operation: string;
  readonly timeoutMs: number;
  readonly retryable: boolean;
}> {}

export type DiscordDrawFailure =
  | DiscordDrawUnauthenticated
  | DiscordDrawForbidden
  | DiscordDrawStaleConsent
  | DiscordDrawEmptyPool
  | DiscordDrawInsufficientFoil
  | DiscordDrawInvalidTransition
  | DiscordDrawIdempotencyConflict
  | DiscordDrawProviderTransient
  | DiscordDrawProviderPermanent
  | DiscordDrawDeliveryTransient
  | DiscordDrawDeliveryPermanent
  | DiscordDrawUnknownCommitOutcome
  | DiscordDrawTimeout;

export interface DiscordDrawErrorShape {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

const FAILURE_TAGS = new Set<string>([
  "DiscordDrawUnauthenticated",
  "DiscordDrawForbidden",
  "DiscordDrawStaleConsent",
  "DiscordDrawEmptyPool",
  "DiscordDrawInsufficientFoil",
  "DiscordDrawInvalidTransition",
  "DiscordDrawIdempotencyConflict",
  "DiscordDrawProviderTransient",
  "DiscordDrawProviderPermanent",
  "DiscordDrawDeliveryTransient",
  "DiscordDrawDeliveryPermanent",
  "DiscordDrawUnknownCommitOutcome",
  "DiscordDrawTimeout",
]);

export function isDiscordDrawFailure(value: unknown): value is DiscordDrawFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    FAILURE_TAGS.has(String((value as { _tag: unknown })._tag))
  );
}

/**
 * The single translation from workflow failures to the existing API/Discord
 * error shape. Handlers must not re-map individual failures elsewhere.
 */
export function discordDrawErrorShape(failure: DiscordDrawFailure): DiscordDrawErrorShape {
  switch (failure._tag) {
    case "DiscordDrawUnauthenticated":
      return { status: 401, code: "authentication_required", message: failure.message };
    case "DiscordDrawForbidden":
      return { status: 403, code: failure.code, message: failure.message };
    case "DiscordDrawStaleConsent":
      return {
        status: 409,
        code: failure.reason === "revision" ? "stale_pool_revision" : "stale_distribution",
        message: failure.message,
        details: {
          expected_revision: failure.expectedRevision,
          expected_distribution: failure.expectedDistribution,
        },
      };
    case "DiscordDrawEmptyPool":
      return {
        status: 409,
        code: "empty_pool",
        message: failure.message,
        ...(failure.emptyReason ? { details: { empty_reason: failure.emptyReason } } : {}),
      };
    case "DiscordDrawInsufficientFoil":
      return {
        status: 409,
        code: "insufficient_funds",
        message: failure.message,
        details: { balance: failure.balance, price: failure.price },
      };
    case "DiscordDrawInvalidTransition":
      return { status: 409, code: failure.code, message: failure.message };
    case "DiscordDrawIdempotencyConflict":
      return {
        status: 409,
        code: "idempotency_conflict",
        message: failure.message,
        details: { idempotency_key: failure.key },
      };
    case "DiscordDrawProviderTransient":
      return {
        status: 503,
        code: "draw_provider_unavailable",
        message: failure.message,
        details: { operation: failure.operation },
      };
    case "DiscordDrawProviderPermanent":
      return {
        status: 502,
        code: "draw_provider_error",
        message: failure.message,
        details: { operation: failure.operation },
      };
    case "DiscordDrawDeliveryTransient":
      return {
        status: 503,
        code: "discord_delivery_unavailable",
        message: failure.message,
        details: { operation: failure.operation },
      };
    case "DiscordDrawDeliveryPermanent":
      return {
        status: 502,
        code: "delivery_failed",
        message: failure.message,
        details: { operation: failure.operation },
      };
    case "DiscordDrawUnknownCommitOutcome":
      return {
        status: 500,
        code: "unknown_commit_outcome",
        message: failure.message,
      };
    case "DiscordDrawTimeout":
      return {
        status: 503,
        code: "draw_timeout",
        message: `The ${failure.operation} step did not finish in time.`,
        details: { operation: failure.operation, timeout_ms: failure.timeoutMs },
      };
  }
}

export interface ApiErrorLike {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

function numberDetail(
  details: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Map an existing `ApiError` from the shared services into the workflow's
 * typed failures. Unknown or server errors are deliberately not treated as
 * proof that nothing committed.
 */
export function failureFromApiError(error: ApiErrorLike): DiscordDrawFailure {
  switch (error.code) {
    case "authentication_required":
    case "discord_user_missing":
      return new DiscordDrawUnauthenticated({ message: error.message });
    case "stale_pool_revision":
      return new DiscordDrawStaleConsent({
        reason: "revision",
        message: error.message,
        expectedRevision: numberDetail(error.details, "expected_revision", 0),
        expectedDistribution: stringDetail(error.details, "expected_distribution") ?? "",
      });
    case "stale_distribution":
      return new DiscordDrawStaleConsent({
        reason: "distribution",
        message: error.message,
        expectedRevision: numberDetail(error.details, "expected_revision", 0),
        expectedDistribution: stringDetail(error.details, "expected_distribution") ?? "",
      });
    case "empty_pool":
      return new DiscordDrawEmptyPool({
        message: error.message,
        emptyReason: stringDetail(error.details, "empty_reason"),
      });
    case "insufficient_funds":
      return new DiscordDrawInsufficientFoil({
        message: error.message,
        balance: numberDetail(error.details, "balance", 0),
        price: numberDetail(error.details, "price", 0),
        currencySymbol: stringDetail(error.details, "currency_symbol") ?? "✦",
      });
    case "idempotency_conflict":
      return new DiscordDrawIdempotencyConflict({
        message: error.message,
        key: stringDetail(error.details, "idempotency_key") ?? "",
      });
    case "draw_conflict":
    case "pool_changed":
    case "collection_disabled":
    case "serial_collision":
      return new DiscordDrawInvalidTransition({ code: error.code, message: error.message });
    default:
      if (error.status === 401) {
        return new DiscordDrawUnauthenticated({ message: error.message });
      }
      if (error.status === 403) {
        return new DiscordDrawForbidden({ code: error.code, message: error.message });
      }
      if (error.status >= 500) {
        return new DiscordDrawProviderPermanent({
          operation: "domain",
          message: error.message,
          status: error.status,
        });
      }
      if (error.status === 409) {
        return new DiscordDrawInvalidTransition({ code: error.code, message: error.message });
      }
      return new DiscordDrawProviderPermanent({
        operation: "domain",
        message: error.message,
        status: error.status,
      });
  }
}

function retryAfterOf(failure: DiscordDrawFailure): number | null {
  if (
    failure._tag === "DiscordDrawProviderTransient" ||
    failure._tag === "DiscordDrawDeliveryTransient"
  ) {
    return failure.retryAfterMs;
  }
  return null;
}

export function isRetryableFailure(failure: DiscordDrawFailure): boolean {
  if (failure._tag === "DiscordDrawProviderTransient") return true;
  if (failure._tag === "DiscordDrawTimeout") return failure.retryable;
  if (failure._tag === "DiscordDrawDeliveryTransient") return failure.safeToRetry;
  return false;
}

function withDeadline<A>(
  operation: string,
  effect: Effect.Effect<A, DiscordDrawFailure>,
  policy: DiscordDrawPolicyShape,
  retryable: boolean,
  timeoutMs = policy.attemptTimeoutMs,
): Effect.Effect<A, DiscordDrawFailure> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(Math.max(1, timeoutMs)),
      orElse: () =>
        Effect.fail(
          new DiscordDrawTimeout({
            operation,
            timeoutMs,
            retryable,
          }),
        ),
    }),
  );
}

function retryDelay(
  attempt: number,
  failure: DiscordDrawFailure,
  policy: DiscordDrawPolicyShape,
  random: DiscordDrawRandom["Service"],
  clock: DiscordDrawClock["Service"],
): Effect.Effect<void, DiscordDrawFailure> {
  const exponential = Math.min(
    policy.maxBackoffMs,
    policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
  );
  return random.next().pipe(
    Effect.flatMap((unit) => {
      const boundedUnit = Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0.5;
      const jitter = 1 - policy.jitterRatio + boundedUnit * policy.jitterRatio * 2;
      const backoff = Math.max(0, Math.round(exponential * jitter));
      const retryAfter = retryAfterOf(failure);
      if (retryAfter !== null && retryAfter > policy.maxBackoffMs) {
        // The provider asked us to wait longer than this workflow may hold a
        // request open. Fail honouring the deadline rather than retrying early.
        return Effect.fail(failure);
      }
      const delay = retryAfter === null ? backoff : Math.max(backoff, retryAfter);
      return clock.sleep(delay);
    }),
  );
}

/**
 * Retry only explicitly retryable work. The first attempt is immediate; the
 * total attempts, exponential backoff, jitter and Retry-After are bounded.
 */
export function retryTransient<A>(
  operation: string,
  effect: Effect.Effect<A, DiscordDrawFailure>,
  policy: DiscordDrawPolicyShape,
  clock: DiscordDrawClock["Service"],
  random: DiscordDrawRandom["Service"],
): Effect.Effect<A, DiscordDrawFailure> {
  const loop = (attempt: number): Effect.Effect<A, DiscordDrawFailure> =>
    withDeadline(operation, effect, policy, true).pipe(
      Effect.catch((failure) => {
        if (!isRetryableFailure(failure) || attempt >= policy.maxAttempts) {
          return Effect.fail(failure);
        }
        return retryDelay(attempt, failure, policy, random, clock).pipe(
          Effect.andThen(loop(attempt + 1)),
        );
      }),
    );
  return loop(1);
}

function typedFailureFromCause(cause: Cause.Cause<DiscordDrawFailure>): DiscordDrawFailure | null {
  const found = Cause.findErrorOption(cause);
  if (Option.isSome(found) && isDiscordDrawFailure(found.value)) return found.value;
  return null;
}

interface DeliveryAttempt {
  readonly delivered: boolean;
  readonly visibility?: DiscordDeliveryVisibility;
  readonly error?: DiscordDrawDeliveryTransient | DiscordDrawDeliveryPermanent;
}

export function runDiscordDrawWorkflow(
  request: DiscordDrawRequest,
): Effect.Effect<
  DiscordDrawOutcome,
  DiscordDrawFailure,
  | DiscordDrawIdentity
  | DiscordDrawDomain
  | DiscordDrawReceipts
  | DiscordDrawDelivery
  | DiscordDrawInteractions
  | DiscordDrawReplies
  | DiscordDrawClock
  | DiscordDrawRandom
  | DiscordDrawPolicy
> {
  return Effect.gen(function* () {
    const identity = yield* DiscordDrawIdentity;
    const domain = yield* DiscordDrawDomain;
    const receipts = yield* DiscordDrawReceipts;
    const delivery = yield* DiscordDrawDelivery;
    const interactions = yield* DiscordDrawInteractions;
    const replies = yield* DiscordDrawReplies;
    const clock = yield* DiscordDrawClock;
    const random = yield* DiscordDrawRandom;
    const policy = yield* DiscordDrawPolicy;

    const session = yield* interactions.begin(request.interaction);
    // Durable cancellation cleanup: the finalizer only closes a row that is
    // still processing, so it cannot overwrite a completed delivery.
    yield* Effect.addFinalizer(() => interactions.abandon(session));

    const complete = (outcome: DiscordDrawOutcome): Effect.Effect<DiscordDrawOutcome> =>
      interactions.finish(session, outcome).pipe(Effect.as(outcome));

    const deliver = (callback: DiscordCallback): Effect.Effect<DeliveryAttempt> => {
      const attemptedVisibility: DiscordDeliveryVisibility =
        (callback.data?.flags ?? 0) & 64 ? "private" : "private_fallback";
      return delivery.deliver(request.interaction, callback).pipe(
        Effect.map((outcome) => ({
          delivered: outcome.delivered,
          visibility: outcome.visibility,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            delivered: false,
            visibility: attemptedVisibility,
            error,
          }),
        ),
      );
    };

    const failureOutcome = (
      failure: DiscordDrawFailure,
      attempt: DeliveryAttempt,
      committed: boolean,
    ): DiscordDrawOutcome => {
      const shape = discordDrawErrorShape(failure);
      const uncertain = failure._tag === "DiscordDrawUnknownCommitOutcome";
      if (attempt.delivered && !uncertain) {
        return {
          status: "completed",
          delivered: true,
          committed,
          errorCode: shape.code,
          visibility: attempt.visibility,
        };
      }
      return {
        status: attempt.delivered ? "failed" : committed ? "completed" : "failed",
        delivered: attempt.delivered,
        committed,
        errorCode: attempt.delivered ? shape.code : "delivery_failed",
        visibility: attempt.visibility,
      };
    };

    const respondToFailure = (failure: DiscordDrawFailure): Effect.Effect<DiscordDrawOutcome> =>
      deliver(replies.failure(failure)).pipe(
        Effect.flatMap((attempt) => complete(failureOutcome(failure, attempt, false))),
      );

    const recoverReceipt = (
      receipt: DiscordDrawReceipt,
      failure: DiscordDrawFailure,
      receiptPersisted: boolean,
    ): Effect.Effect<DiscordDrawOutcome> =>
      deliver(
        replies.recovery({
          receipt,
          interactionId: request.interaction.id,
          reason: discordDrawErrorShape(failure).message,
        }),
      ).pipe(
        Effect.flatMap((attempt) =>
          complete({
            status: "completed",
            delivered: attempt.delivered,
            committed: true,
            errorCode: attempt.delivered
              ? receiptPersisted
                ? "delivery_recovered"
                : "receipt_persist_failed"
              : "delivery_failed",
            visibility: attempt.visibility,
          }),
        ),
      );

    const recoverCommitted = (
      committed: DiscordDrawCommitted,
      failure: DiscordDrawFailure,
      receiptPersisted: boolean,
    ): Effect.Effect<DiscordDrawOutcome> =>
      recoverReceipt(committed.receipt, failure, receiptPersisted);

    const readPersistedReceipt = withDeadline(
      "receipt-read",
      receipts.read({ interactionId: request.interaction.id }),
      policy,
      false,
    ).pipe(Effect.catch(() => Effect.succeed(null)));

    const resolvePrincipal = Effect.exit(
      withDeadline("identity", identity.resolve(request), policy, false),
    );
    const principalExit = yield* resolvePrincipal;
    if (Exit.isFailure(principalExit)) {
      const failure = typedFailureFromCause(principalExit.cause);
      if (!failure) return yield* Effect.failCause(principalExit.cause);
      return yield* respondToFailure(failure);
    }
    const principal = principalExit.value;

    const prepareExit = yield* Effect.exit(
      retryTransient(
        "prepare",
        domain.prepare({
          principal,
          interaction: request.interaction,
          requestedPool: request.requestedPool,
          idempotencyKey: request.idempotencyKey,
        }),
        policy,
        clock,
        random,
      ),
    );
    if (Exit.isFailure(prepareExit)) {
      const failure = typedFailureFromCause(prepareExit.cause);
      if (!failure) return yield* Effect.failCause(prepareExit.cause);
      return yield* respondToFailure(failure);
    }
    const prepared = prepareExit.value;
    if (prepared.kind === "respond") {
      const attempt = yield* deliver(prepared.callback);
      return yield* complete({
        status: attempt.delivered ? "completed" : "failed",
        delivered: attempt.delivered,
        committed: false,
        ...(attempt.delivered ? {} : { errorCode: "delivery_failed" }),
        visibility: attempt.visibility,
      });
    }
    const plan = prepared.plan;

    const commitAttempt = (
      attempt: number,
    ): Effect.Effect<DiscordDrawCommitted, DiscordDrawFailure> =>
      withDeadline("commit", domain.commit({ principal, plan }), policy, false, policy.commitTimeoutMs).pipe(
        Effect.catch((failure): Effect.Effect<DiscordDrawCommitted, DiscordDrawFailure> => {
          const ambiguous =
            failure._tag === "DiscordDrawUnknownCommitOutcome" ||
            failure._tag === "DiscordDrawProviderTransient" ||
            failure._tag === "DiscordDrawTimeout";
          if (!ambiguous) return Effect.fail(failure);
          return domain.reconcile({ principal, plan, interaction: request.interaction }).pipe(
            Effect.catch((reconcileFailure): Effect.Effect<never, DiscordDrawFailure> => {
              if (
                reconcileFailure._tag === "DiscordDrawIdempotencyConflict" ||
                reconcileFailure._tag === "DiscordDrawInvalidTransition"
              ) {
                return Effect.fail(reconcileFailure);
              }
              return Effect.fail(
                new DiscordDrawUnknownCommitOutcome({
                  message:
                    "The draw may have committed, but the receipt could not be reconciled. Do not start another draw.",
                  cause: reconcileFailure.message,
                }),
              );
            }),
            Effect.flatMap((reconciled) => {
              if (reconciled) return Effect.succeed(reconciled);
              if (attempt >= policy.commitAttempts) return Effect.fail(failure);
              return retryDelay(attempt, failure, policy, random, clock).pipe(
                Effect.andThen(commitAttempt(attempt + 1)),
              );
            }),
          );
        }),
      );

    const commitExit = yield* Effect.exit(commitAttempt(1));
    if (Exit.isFailure(commitExit)) {
      const failure = typedFailureFromCause(commitExit.cause);
      if (!failure) return yield* Effect.failCause(commitExit.cause);
      // A commit failure is never a reason to call the draw service again
      // without a confirmed absence of the original receipt.
      const recorded = yield* readPersistedReceipt;
      if (recorded) return yield* recoverReceipt(recorded, failure, true);
      const uncertain =
        failure._tag === "DiscordDrawUnknownCommitOutcome" ||
        failure._tag === "DiscordDrawProviderTransient" ||
        failure._tag === "DiscordDrawTimeout";
      const reported = uncertain
        ? new DiscordDrawUnknownCommitOutcome({
            message:
              "The draw may have committed, but the result could not be confirmed. Check your cabinet before trying again.",
            cause: failure.message,
          })
        : failure;
      const attempt = yield* deliver(replies.failure(reported));
      return yield* complete(failureOutcome(reported, attempt, false));
    }
    const committed = commitExit.value;

    const receiptPersisted = yield* retryTransient(
      "receipt",
      receipts.record({
        interactionId: request.interaction.id,
        receipt: committed.receipt,
      }),
      policy,
      clock,
      random,
    ).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );

    const presentExit = yield* Effect.exit(
      retryTransient(
        "presentation",
        domain.present({
          principal,
          interaction: request.interaction,
          plan,
          committed,
        }),
        policy,
        clock,
        random,
      ),
    );
    if (Exit.isFailure(presentExit)) {
      const failure = typedFailureFromCause(presentExit.cause);
      if (!failure) return yield* Effect.failCause(presentExit.cause);
      return yield* recoverCommitted(committed, failure, receiptPersisted);
    }

    const attempt = yield* deliver(presentExit.value);
    if (!attempt.delivered) {
      return yield* complete({
        status: "completed",
        delivered: false,
        committed: true,
        errorCode: "delivery_failed",
        visibility: attempt.visibility,
      });
    }
    return yield* complete({
      status: "completed",
      delivered: true,
      committed: true,
      ...(attempt.visibility === "private_fallback"
        ? { errorCode: "public_delivery_failed" }
        : receiptPersisted
          ? {}
          : { errorCode: "receipt_persist_failed" }),
      visibility: attempt.visibility,
    });
  }).pipe(Effect.scoped);
}

export const defaultDiscordDrawPolicy: DiscordDrawPolicyShape = {
  attemptTimeoutMs: 4_000,
  maxAttempts: 3,
  commitAttempts: 2,
  commitTimeoutMs: 20_000,
  baseBackoffMs: 120,
  maxBackoffMs: 1_500,
  jitterRatio: 0.25,
};
