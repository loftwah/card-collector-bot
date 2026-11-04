/**
 * Production adapters for the Effect-owned Discord draw lifecycle.
 *
 * The pure workflow owns orchestration and policy. This module wires it to the
 * existing shared services: Discord identity/installation resolution, the
 * shared `executeDraw` economy commit, the durable receipt store, the existing
 * Discord delivery transport and the interaction log.
 */
import { Cause, Duration, Effect, Exit, Option } from "effect";
import { ApiError } from "../context";
import {
  defaultDiscordDrawPolicy,
  DiscordDrawClock,
  DiscordDrawDelivery,
  DiscordDrawDomain,
  DiscordDrawIdentity,
  DiscordDrawInteractions,
  DiscordDrawPolicy,
  DiscordDrawRandom,
  DiscordDrawReceipts,
  DiscordDrawReplies,
  DiscordDrawUnknownCommitOutcome,
  DiscordDrawDeliveryPermanent,
  DiscordDrawDeliveryTransient,
  DiscordDrawProviderPermanent,
  DiscordDrawProviderTransient,
  discordDrawErrorShape,
  failureFromApiError,
  isDiscordDrawFailure,
  runDiscordDrawWorkflow,
  type DiscordDrawCommitted,
  type DiscordDrawFailure,
  type DiscordDrawOutcome,
  type DiscordDrawPrincipal,
  type DiscordDrawRequest,
} from "../effect/discord-draw-workflow";
import { findIdempotent } from "../http";
import { executeDraw } from "../modules/pools";
import { errorCallback, prepareDiscordDraw, presentDiscordDraw } from "./commands";
import {
  buildDiscordContext,
  ensureDiscordPlayer,
  interactionUser,
  resolveInstallation,
} from "./context";
import type { DrawReceipt } from "./draw-types";
import { deliverDeferred, EPHEMERAL_FLAG } from "./delivery";
import {
  abandonInteraction,
  recordInteractionFinish,
  recordInteractionStart,
} from "./interactions";
import {
  drawReceiptFromResult,
  drawRecoveryMessage,
  markDeliveryVisibility,
  persistInteractionReceipt,
  readInteractionReceipt,
} from "./receipts";
import { redactDiscordText } from "./redaction";
import type { DiscordCallback, DiscordEnv, DiscordInteraction } from "./types";

const KNOWN_COMMIT_FAILURES = new Set([
  "authentication_required",
  "discord_user_missing",
  "stale_pool_revision",
  "stale_distribution",
  "empty_pool",
  "insufficient_funds",
  "idempotency_conflict",
  "draw_conflict",
  "pool_changed",
  "collection_disabled",
  "serial_collision",
  "discord_guild_required",
  "discord_installation_missing",
  "discord_game_disabled",
  "discord_channel_not_enabled",
  "discord_identity_revoked",
  "account_disabled",
  "membership_revoked",
]);

function safeMessage(error: unknown): string {
  if (error instanceof Error) return redactDiscordText(error.message);
  return "The Discord draw workflow stopped unexpectedly.";
}

function asApiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}

function commitFailure(error: unknown): DiscordDrawFailure {
  const api = asApiError(error);
  if (api && KNOWN_COMMIT_FAILURES.has(api.code)) return failureFromApiError(api);
  if (api) {
    return new DiscordDrawUnknownCommitOutcome({
      message:
        "The draw may have committed, but the result could not be confirmed. Check your cabinet before trying again.",
      cause: `${api.code}: ${api.message}`,
    });
  }
  return new DiscordDrawUnknownCommitOutcome({
    message:
      "The draw may have committed, but the result could not be confirmed. Check your cabinet before trying again.",
    cause: safeMessage(error),
  });
}

function readFailure(error: unknown, operation: string): DiscordDrawFailure {
  const api = asApiError(error);
  if (api) return failureFromApiError(api);
  return new DiscordDrawProviderTransient({
    operation,
    message: safeMessage(error),
    retryAfterMs: null,
  });
}

function committedFromResult(result: DrawReceipt): DiscordDrawCommitted {
  return {
    result,
    receipt: drawReceiptFromResult(result),
    replayed: Boolean(result.replayed),
  };
}

function requestFrom(
  interaction: DiscordInteraction,
  applicationId: string,
  requestedPool: string | undefined,
): DiscordDrawRequest {
  return {
    interaction,
    applicationId,
    requestedPool,
    idempotencyKey: `discord:${interaction.id}:open`,
    allowDisabledGame: false,
  };
}

function isDrawInteraction(interaction: DiscordInteraction): boolean {
  if (interaction.type === 2) {
    if (interaction.data?.name !== "foilbury") return false;
    const top = interaction.data.options?.find((option) => option.type === 1 || option.type === 2);
    return top?.name === "open";
  }
  if (interaction.type === 3) {
    return Boolean(interaction.data?.custom_id?.startsWith("foilbury:open:"));
  }
  return false;
}

export function isDiscordDrawInteraction(interaction: DiscordInteraction): boolean {
  return isDrawInteraction(interaction);
}

function requestedPoolFor(interaction: DiscordInteraction): string | undefined {
  if (interaction.type === 3) {
    return interaction.data?.custom_id?.slice("foilbury:open:".length) || undefined;
  }
  const top = interaction.data?.options?.find((option) => option.type === 1 || option.type === 2);
  const value = top?.options?.find((option) => option.name === "pool")?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function provideServices(
  program: ReturnType<typeof runDiscordDrawWorkflow>,
  env: DiscordEnv,
  interaction: DiscordInteraction,
  publicOrigin: string,
) {
  const identity: DiscordDrawIdentity["Service"] = {
    resolve: (request) =>
      Effect.tryPromise({
        try: async (): Promise<DiscordDrawPrincipal> => {
          const resolved = await resolveInstallation(
            env,
            request.interaction,
            request.applicationId,
            {
              allowDisabledGame: Boolean(request.allowDisabledGame),
            },
          );
          const discordUser = interactionUser(request.interaction);
          const player = await ensureDiscordPlayer(env, resolved.tenant, discordUser);
          const ctx = buildDiscordContext(env, resolved.tenant, player.user, request.interaction);
          return {
            ctx,
            tenant: resolved.tenant,
            user: player.user,
            installation: resolved.installation,
          };
        },
        catch: (error) => {
          const api = asApiError(error);
          if (api) return failureFromApiError(api);
          return new DiscordDrawProviderPermanent({
            operation: "identity",
            message: safeMessage(error),
            status: null,
          });
        },
      }),
  };

  const domain: DiscordDrawDomain["Service"] = {
    prepare: ({ principal, interaction: current, requestedPool, idempotencyKey }) =>
      Effect.tryPromise({
        try: async () => {
          const prepared = await prepareDiscordDraw(
            principal.ctx,
            current,
            principal.installation,
            requestedPool,
            idempotencyKey,
          );
          if (prepared.kind === "respond") {
            return { kind: "respond" as const, callback: prepared.callback };
          }
          return { kind: "draw" as const, plan: prepared };
        },
        catch: (error) => readFailure(error, "prepare"),
      }),
    commit: ({ principal, plan }) =>
      Effect.tryPromise({
        try: async () => {
          const result = (await executeDraw(principal.ctx, {
            pool: plan.poolSlug,
            expectedRevision: plan.expectedRevision,
            expectedDistribution: plan.expectedDistribution,
            channelKey: plan.channelKey,
            idempotency: plan.idempotency,
          })) as unknown as DrawReceipt;
          return committedFromResult(result);
        },
        catch: (error) => commitFailure(error),
      }),
    reconcile: ({ principal, plan }) =>
      Effect.tryPromise({
        try: async () => {
          const replay = await findIdempotent(principal.ctx, "draw.execute", plan.idempotency);
          if (!replay) return null;
          return committedFromResult(replay.response as DrawReceipt);
        },
        catch: (error) => readFailure(error, "reconcile"),
      }),
    present: ({ principal, interaction: current, plan, committed }) =>
      Effect.tryPromise({
        try: () =>
          presentDiscordDraw(
            principal.ctx,
            current,
            principal.installation,
            committed.result,
            plan.poolSlug,
          ),
        catch: (error) => readFailure(error, "presentation"),
      }),
  };

  const receipts: DiscordDrawReceipts["Service"] = {
    record: ({ interactionId, receipt }) =>
      Effect.tryPromise({
        try: () => persistInteractionReceipt(env.DB, interactionId, receipt),
        catch: (error) =>
          new DiscordDrawProviderTransient({
            operation: "receipt",
            message: safeMessage(error),
            retryAfterMs: null,
          }),
      }),
    read: ({ interactionId }) =>
      Effect.promise(() => readInteractionReceipt(env.DB, interactionId)),
  };

  const delivery: DiscordDrawDelivery["Service"] = {
    deliver: (current, callback) =>
      Effect.tryPromise({
        try: () => deliverDeferred(env, current, callback),
        catch: (error) =>
          new DiscordDrawDeliveryPermanent({
            operation: "delivery",
            message: safeMessage(error),
            status: null,
          }),
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome.delivered
            ? Effect.succeed(outcome)
            : Effect.fail(
                new DiscordDrawDeliveryTransient({
                  operation: "delivery",
                  message:
                    "Discord did not confirm the delivery after the bounded transport retry.",
                  retryAfterMs: null,
                  // A deferred interaction may already have posted a public
                  // follow-up. The workflow must not replay an ambiguous POST.
                  safeToRetry: false,
                }),
              ),
        ),
      ),
  };

  const interactions: DiscordDrawInteractions["Service"] = {
    begin: (current) =>
      Effect.promise(() => recordInteractionStart(env, current)).pipe(
        Effect.as({ interactionId: current.id }),
      ),
    finish: (session, outcome) =>
      Effect.promise(async () => {
        await recordInteractionFinish(
          env,
          session.interactionId,
          outcome.status,
          outcome.errorCode,
        );
        if (outcome.visibility) {
          await markDeliveryVisibility(env.DB, session.interactionId, outcome.visibility);
        }
      }),
    abandon: (session) => Effect.promise(() => abandonInteraction(env, session.interactionId)),
  };

  const replies: DiscordDrawReplies["Service"] = {
    failure: (failure) => {
      const shape = discordDrawErrorShape(failure);
      return errorCallback(new ApiError(shape.status, shape.code, shape.message, shape.details));
    },
    recovery: ({ receipt, interactionId, reason }) =>
      privateRecoveryCallback(
        drawRecoveryMessage({
          receipt,
          origin: publicOrigin,
          interactionId,
          reason,
        }),
      ),
  };

  return program.pipe(
    Effect.provideService(DiscordDrawIdentity, identity),
    Effect.provideService(DiscordDrawDomain, domain),
    Effect.provideService(DiscordDrawReceipts, receipts),
    Effect.provideService(DiscordDrawDelivery, delivery),
    Effect.provideService(DiscordDrawInteractions, interactions),
    Effect.provideService(DiscordDrawReplies, replies),
    Effect.provideService(DiscordDrawClock, {
      sleep: (milliseconds) => Effect.sleep(Duration.millis(milliseconds)),
    }),
    Effect.provideService(DiscordDrawRandom, {
      next: () => Effect.sync(() => Math.random()),
    }),
    Effect.provideService(DiscordDrawPolicy, defaultDiscordDrawPolicy),
  );
}

function privateRecoveryCallback(message: ReturnType<typeof drawRecoveryMessage>): DiscordCallback {
  return {
    type: 4,
    data: {
      ...message,
      flags: EPHEMERAL_FLAG,
    },
  };
}

function typedFailureFromCause(cause: Cause.Cause<unknown>): DiscordDrawFailure | null {
  const found = Cause.findErrorOption(cause);
  if (Option.isSome(found) && isDiscordDrawFailure(found.value)) return found.value;
  return null;
}

/**
 * Async boundary used by `ctx.waitUntil`. It never rejects: every expected
 * failure has already been delivered by the workflow, and an unexpected defect
 * is logged redacted, recorded and answered with the existing error shape.
 */
export async function runDiscordDrawForInteraction(input: {
  env: DiscordEnv;
  interaction: DiscordInteraction;
  applicationId: string;
  publicOrigin?: string;
}): Promise<DiscordDrawOutcome> {
  const { env, interaction, applicationId } = input;
  const publicOrigin =
    input.publicOrigin ?? env.FOILBURY_PUBLIC_ORIGIN ?? "https://foilbury.loftwah.com";
  const program = provideServices(
    runDiscordDrawWorkflow(requestFrom(interaction, applicationId, requestedPoolFor(interaction))),
    env,
    interaction,
    publicOrigin,
  );
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = typedFailureFromCause(exit.cause);
  console.error(
    JSON.stringify({
      level: "error",
      request_id: `discord:${interaction.id}`,
      message: safeMessage(failure instanceof Error ? failure : Cause.pretty(exit.cause)),
    }),
  );
  const fallback = errorCallback(
    new ApiError(
      500,
      "internal_error",
      "Foilbury could not confirm the outcome of that draw. Check your cabinet and wallet before trying again; a committed draw remains recorded.",
    ),
  );
  const outcome = await deliverDeferred(env, interaction, fallback).catch(() => ({
    delivered: false,
    visibility: "private" as const,
  }));
  await recordInteractionStart(env, interaction);
  await recordInteractionFinish(env, interaction.id, "failed", "internal_error");
  return {
    status: "failed",
    delivered: outcome.delivered,
    committed: false,
    errorCode: "internal_error",
    visibility: outcome.visibility,
  };
}
