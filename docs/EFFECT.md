# Effect adoption

## Decision

- Version: `effect@4.1.2`, pinned exactly in `package.json` (no range), matching
  the installed stable major. API decisions were checked against the official v4
  documentation on 2026-11-04:
  - <https://effect.website/docs/v4/error-management/retrying>
  - <https://effect.website/docs/v4/error-management/timing-out>
  - <https://effect.website/docs/v4/resource-management/scope>
  - <https://effect.website/docs/v4/scheduling/cookbook>
  - <https://effect.website/docs/v4/requirements-management/services>
- First workflow: Discord interaction HTTP delivery (the production path that
  sends/edits the acknowledged message).
- Second workflow: the complete authorised Discord draw lifecycle
  (`src/server/effect/discord-draw-workflow.ts`): request-scoped identity and
  tenant, consent preview, the shared `executeDraw` commit, durable receipt,
  presentation, delivery and reconciliation/recovery.
- Boundary: the domain draw, ledger and receipt remain the existing D1 services.
  Effect owns execution, typed failure, timeout, bounded retry, cancellation and
  recovery; it does not create a second economy. Web, REST, CLI and MCP continue
  to call the same shared services and keep their existing contracts.

## Transport pattern

`src/server/effect/discord-transport.ts` defines:

- `DiscordHttp` — injected `request(url, init, signal)` service;
- `DiscordLogger` — injected structured error sink;
- `DiscordTransportError` — tagged typed failure with status/timeout/retryable
  and a parsed `Retry-After`;
- `runDiscordRequest` — one runtime entry, finite timeout (`8s`), at most three
  attempts for idempotent requests, exactly one attempt for POST, and a delay of
  the provider's `Retry-After` (capped at `5s`) between idempotent retries.

The handler provides the real `fetch` and a no-op logger at the process
boundary, then emits one redacted operational event. Tests inject deterministic
HTTP implementations and assert success-after-retry, no POST retry, timeout,
provider `Retry-After` parsing and thrown-provider failure.

## Draw workflow

`src/server/effect/discord-draw-workflow.ts` is pure: it has no Worker-only
imports and is exercised directly by deterministic tests. Production adapters in
`src/server/discord/draw-runtime.ts` wire the existing services:

| Service                   | Production adapter                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `DiscordDrawIdentity`     | `resolveInstallation`, `ensureDiscordPlayer`, `buildDiscordContext`                |
| `DiscordDrawDomain`       | `prepareDiscordDraw`, shared `executeDraw`, `findIdempotent`, `presentDiscordDraw` |
| `DiscordDrawReceipts`     | `fb_discord_interactions.receipt_json`                                             |
| `DiscordDrawDelivery`     | existing `deliverDeferred` transport rules                                         |
| `DiscordDrawInteractions` | best-effort start/finish plus conditional cancellation abandon                     |
| `DiscordDrawReplies`      | existing `errorCallback` and `drawRecoveryMessage`                                 |

The workflow's finalizer uses `Effect.addFinalizer` to call
`abandonInteraction`, which only updates a row still in `processing`. A
completed delivery can therefore never be relabelled by cancellation. The
deferred handler entry remains `ctx.waitUntil`; Effect does not create detached
fibres or a queue.

### Typed failures

All expected failures are tagged and translated once by
`discordDrawErrorShape` into the existing API/Discord error shape:

| Failure                           | Existing code/status                                |
| --------------------------------- | --------------------------------------------------- |
| `DiscordDrawUnauthenticated`      | `authentication_required` / 401                     |
| `DiscordDrawForbidden`            | original 403 code                                   |
| `DiscordDrawStaleConsent`         | `stale_pool_revision` or `stale_distribution` / 409 |
| `DiscordDrawEmptyPool`            | `empty_pool` / 409                                  |
| `DiscordDrawInsufficientFoil`     | `insufficient_funds` / 409                          |
| `DiscordDrawInvalidTransition`    | original 409 code                                   |
| `DiscordDrawIdempotencyConflict`  | `idempotency_conflict` / 409                        |
| `DiscordDrawProviderTransient`    | `draw_provider_unavailable` / 503                   |
| `DiscordDrawProviderPermanent`    | `draw_provider_error` / 502                         |
| `DiscordDrawDeliveryTransient`    | `discord_delivery_unavailable` / 503                |
| `DiscordDrawDeliveryPermanent`    | `delivery_failed` / 502                             |
| `DiscordDrawUnknownCommitOutcome` | `unknown_commit_outcome` / 500                      |
| `DiscordDrawTimeout`              | `draw_timeout` / 503                                |

`failureFromApiError` is the only inbound translation. An unknown server error
during commit is deliberately not treated as proof that nothing committed.

### Retry and reconciliation

- Idempotent or read-only work (preview, presentation and receipt persistence)
  may retry only explicitly transient failures. Attempts, per-attempt deadlines,
  exponential backoff and jitter are bounded by `DiscordDrawPolicy`.
- A provider `Retry-After` longer than `maxBackoffMs` stops the workflow rather
  than retrying early.
- A draw commit is never retried before reconciliation. After an ambiguous
  result the workflow first reads the interaction receipt and then the original
  `draw.execute` idempotency row. It retries only after that reconciliation
  confirms the absence of the original commit, and it reuses the same
  idempotency key.
- Once a commit is known or suspected, the workflow never presents a second
  draw and never offers a paid retry. It recovers the original serial and debit
  from the receipt.
- Delivery keeps the existing rules: idempotent `PATCH` may be retried by the
  transport, while an ambiguous follow-up `POST` is single-attempt. A failed
  public post falls back to the private receipt.

### Test evidence

`tests/workers/effect-draw-workflow.test.ts` uses deterministic identity,
domain, receipt, delivery, clock and random fakes. It covers:

- happy path with one commit, one debit, one receipt and one delivery;
- persisted-receipt fallback when commit reconciliation is unavailable;
- cancellation during commit, finalizer cleanup, no finish and no delivery;
- per-attempt timeout and typed timeout delivery;
- transient retry and exhaustion with `Retry-After` larger than backoff;
- successful retry followed by a single commit;
- concurrent tenant isolation with a barrier;
- ambiguous post-commit reconciliation to the original receipt with one debit;
- ambiguous commit with no reconciliation and no blind redraw;
- presentation failure recovering from the committed receipt;
- delivery failure recorded against a committed draw;
- empty-pool typed delivery without a commit;
- the error-shape mapping table.

The full Workers suite also exercises the production deferred draw path through
`tests/workers/discord.test.ts`: private deferred acknowledgement, receipt
persistence, delivery failure recovery, rate-limited original edit and missing
render fallback. The same suite separately covers the explicit receipt re-send,
which remains on the generic handler path.

## Production bundle impact

Baseline (`d675685`, clean detached worktree at HEAD) and after (this working
tree) were built with the same `pnpm build`, Astro and dependency versions.

| Artifact                | Baseline     | After        | Delta               |
| ----------------------- | ------------ | ------------ | ------------------- |
| `dist/server/entry.mjs` | 68,861 B\*   | 69,221 B     | +360 B (+0.52%)     |
| Discord handler chunk   | 323,135 B    | 391,324 B    | +68,189 B (+21.1%)  |
| Total emitted server JS | 13,826,563 B | 13,999,331 B | +172,768 B (+1.25%) |

\* The pre-change build in this working tree also emitted a 69,221 B entry; the
clean detached build emitted 68,861 B. The entry only re-exports chunks, so the
handler chunk and total emitted JavaScript are the meaningful measurements.

The total also includes shared Effect imports pulled into other entrypoints. The
build completed with the existing non-blocking Vite chunk-size and sourcemap
warnings. No deployment was performed.

## Worker lifetime

`ctx.waitUntil` owns the deferred interaction. The Effect run starts the
operational row, records a terminal state before returning, and its scope
finalizer conditionally abandons an interrupted run. Work that cannot finish is
recorded as a delivery failure or an unknown commit outcome and recovered from
the persisted receipt; it is not silently retried as a new draw.

## Remaining migration

The pattern is suitable for the next high-value asynchronous boundaries (render
claim/complete and scheduled maintenance). The draw workflow covers only the
`/foilbury open` command and `foilbury:open:*` component in the deferred
production path; other Discord commands and the explicit receipt re-send still
use the generic handler path. Pure helpers and UI state are not being rewritten
for fashion. Any future migration must keep request-scoped identity/Bot context
out of mutable globals and must preserve existing HTTP, Discord, CLI and MCP
contracts.
