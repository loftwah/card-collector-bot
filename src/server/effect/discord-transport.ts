/**
 * Effect-owned Discord HTTP execution.
 *
 * The transport, clock and logger are injected services. Expected failures are
 * typed; retries are bounded and only apply to idempotent requests. POST is
 * deliberately single-attempt because an ambiguous create cannot be safely
 * repeated.
 */
import { Cause, Clock, Context, Data, Duration, Effect, Exit, Option, Schedule } from "effect";

export class DiscordTransportError extends Data.TaggedError("DiscordTransportError")<{
  readonly message: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly timedOut: boolean;
  /** Parsed provider `Retry-After`, in milliseconds. Null when absent. */
  readonly retryAfterMs: number | null;
}> {}

export class DiscordHttp extends Context.Service<
  DiscordHttp,
  {
    request: (url: string, init: RequestInit, signal: AbortSignal) => Promise<Response>;
  }
>()("DiscordHttp") {}

export class DiscordLogger extends Context.Service<
  DiscordLogger,
  { error: (event: Record<string, unknown>) => void }
>()("DiscordLogger") {}

export interface DiscordRequestInput {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  idempotent: boolean;
  maxAttempts?: number;
}

export interface DiscordRequestResult {
  response: Response | null;
  error: DiscordTransportError | null;
  attempts: number;
}

const attempt = (input: DiscordRequestInput) =>
  Effect.gen(function* () {
    const http = yield* DiscordHttp;
    const response = yield* Effect.tryPromise({
      try: (signal) => http.request(input.url, input.init, signal),
      catch: () =>
        new DiscordTransportError({
          message: "Discord transport request failed",
          status: null,
          retryable: true,
          timedOut: false,
          retryAfterMs: null,
        }),
    });
    if (input.idempotent && (response.status === 429 || response.status >= 500)) {
      const retryAfterMs = parseRetryAfter(response);
      return yield* Effect.fail(
        new DiscordTransportError({
          message: `Discord returned ${response.status}`,
          status: response.status,
          retryable: response.status !== 429 || retryAfterMs !== null,
          timedOut: false,
          retryAfterMs,
        }),
      );
    }
    return response;
  }).pipe(
    Effect.timeout(Duration.millis(input.timeoutMs)),
    Effect.mapError((cause) =>
      cause instanceof DiscordTransportError
        ? cause
        : new DiscordTransportError({
            message: "Discord request timed out",
            status: null,
            retryable: true,
            timedOut: true,
            retryAfterMs: null,
          }),
    ),
  );

/**
 * Discord's numeric `Retry-After` is seconds. An absent or malformed value
 * cannot establish when a rate-limited request may safely be repeated.
 */
function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(seconds * 1_000));
}

export async function runDiscordRequest(
  input: DiscordRequestInput,
  services: { http: DiscordHttp["Service"]; logger: DiscordLogger["Service"] },
): Promise<DiscordRequestResult> {
  const maxAttempts = input.idempotent ? Math.max(1, Math.min(3, input.maxAttempts ?? 3)) : 1;
  let attempts = 0;
  const retrySchedule = Schedule.recurs(maxAttempts - 1).pipe(
    Schedule.setInputType<DiscordTransportError>(),
    Schedule.modifyDelay(({ input: failure }) =>
      Effect.succeed(Duration.millis(failure.retryAfterMs ?? 0)),
    ),
  );
  // One deadline covers attempts and waits. If the provider's delay cannot fit,
  // return the typed rate-limit failure instead of retrying early.
  const program = Effect.gen(function* () {
    const deadline = (yield* Clock.monotonicTimeNanos) + BigInt(Math.max(0, Math.floor(input.timeoutMs * 1_000_000)));
    return yield* attempt(input).pipe(Effect.retry({
      schedule: retrySchedule,
      while: (failure) => Clock.monotonicTimeNanos.pipe(Effect.map((now) =>
        failure.retryable && BigInt(failure.retryAfterMs ?? 0) * 1_000_000n < deadline - now)),
    }));
  }).pipe(
    Effect.timeout(Duration.millis(input.timeoutMs)),
    Effect.mapError((cause) => cause instanceof DiscordTransportError ? cause : new DiscordTransportError({
      message: "Discord request timed out", status: null, retryable: true, timedOut: true, retryAfterMs: null,
    })),
  );
  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.provideService(DiscordHttp, {
        request: (url, init, signal) => {
          attempts += 1;
          return services.http.request(url, init, signal);
        },
      }),
      Effect.provideService(DiscordLogger, services.logger),
    ),
  );
  if (Exit.isSuccess(exit)) return { response: exit.value, error: null, attempts };
  const maybe = Cause.findErrorOption(exit.cause);
  const error =
    Option.isSome(maybe) && maybe.value instanceof DiscordTransportError
      ? maybe.value
      : new DiscordTransportError({
          message: "Discord request failed",
          status: null,
          retryable: false,
          timedOut: false,
          retryAfterMs: null,
        });
  return { response: null, error, attempts };
}
