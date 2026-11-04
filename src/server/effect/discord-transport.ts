/**
 * Effect-owned Discord HTTP execution.
 *
 * The transport, clock and logger are injected services. Expected failures are
 * typed; retries are bounded and only apply to idempotent requests. POST is
 * deliberately single-attempt because an ambiguous create cannot be safely
 * repeated.
 */
import { Cause, Context, Data, Duration, Effect, Exit, Option, Schedule } from "effect";

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
      catch: (cause) =>
        new DiscordTransportError({
          message: cause instanceof Error ? cause.message : String(cause),
          status: null,
          retryable: true,
          timedOut: false,
          retryAfterMs: null,
        }),
    });
    if (input.idempotent && (response.status === 429 || response.status >= 500)) {
      return yield* Effect.fail(
        new DiscordTransportError({
          message: `Discord returned ${response.status}`,
          status: response.status,
          retryable: true,
          timedOut: false,
          retryAfterMs: parseRetryAfter(response),
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
            message: cause instanceof Error ? cause.message : String(cause),
            status: null,
            retryable: false,
            timedOut: true,
            retryAfterMs: null,
          }),
    ),
  );

/**
 * Discord sends `Retry-After` for rate limits. It may be seconds or an HTTP
 * date; the numeric form is the one used by the API. A missing or malformed
 * header leaves the existing bounded retry with no extra delay.
 */
function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  // Keep the deferred interaction lifetime bounded. A provider that asks for a
  // longer pause is capped here rather than sleeping for the full duration.
  return Math.min(5_000, Math.round(seconds * 1_000));
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
  const program = attempt(input).pipe(Effect.retry(retrySchedule));
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
