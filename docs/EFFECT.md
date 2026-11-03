# Effect adoption

## Decision

- Version: `effect@4.1.2`, matching the installed stable major.
- First workflow: Discord interaction HTTP delivery (the production path that
  sends/edits the acknowledged message).
- Boundary: the domain draw, ledger and receipt remain the existing D1 services.
  Effect owns execution, typed transport failure, timeout and bounded retry; it
  does not create a second economy.

## Pattern

`src/server/effect/discord-transport.ts` defines:

- `DiscordHttp` — injected `request(url, init, signal)` service;
- `DiscordLogger` — injected structured error sink;
- `DiscordTransportError` — tagged typed failure with status/timeout/retryable;
- `runDiscordRequest` — one runtime entry, finite timeout (`8s`), at most three
  attempts for idempotent requests, and exactly one attempt for POST.

The handler provides the real `fetch` and a no-op logger at the process
boundary, then emits one redacted operational event. Tests inject deterministic
HTTP implementations and assert success-after-retry, no POST retry, timeout and
thrown-provider failure.

## Worker lifetime

`ctx.waitUntil` owns the deferred interaction. Effect never creates detached
fibres or a queue. Work that cannot finish is recorded as a delivery failure and
recovered from the persisted receipt; it is not silently retried as a new draw.

## Remaining migration

The pattern is suitable for the next high-value asynchronous boundaries (render
claim/complete and scheduled maintenance). Pure helpers and UI state are not
being rewritten for fashion. Any future migration must keep request-scoped
identity/Bot context out of mutable globals and must preserve existing HTTP,
Discord, CLI and MCP contracts.
