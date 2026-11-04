# Observability and delivery health

This page records the event contract used by the current implementation. It is
not a claim that every provider is ingested or retained; those deployment checks
are recorded separately under the release evidence.

## Three outcomes, recorded separately

1. **Domain commit** — the D1 transaction that created or changed a draw,
   instance, ledger entry, claim, render job or share.
2. **Reward fulfilment** — an achievement or mission credit attached to that
   commit. The receipt shows the debit, each settled credit and the settled
   balance. A failed fulfilment is `reward_state=failed`, not a silent zero.
3. **Delivery** — the Discord original response, follow-up or private fallback.
   `fb_discord_interactions` keeps `status`, `error_code`, `receipt_kind`,
   `receipt_json` and `delivery_visibility`.

A committed draw with failed delivery is recorded as `status=completed` with
`error_code=delivery_failed` when the receipt was persisted, and it never becomes
“nothing changed”. A truly pre-commit failure has no receipt and may say nothing
was charged.

## Discord diagnostic fields

Every failed Discord request logs an allowlisted route template, not a raw URL:

- `request_id` — `discord:<interaction id>` (safe correlation);
- `route` — e.g. `PATCH /api/v10/webhooks/<application>/:interaction_token/messages/@original`;
- `status` — provider status or `null` for a timeout;
- `detail` — scrubbed, bounded provider/exception text.

Interaction tokens are replaced with `[redacted]`, Bearer/Bot tokens and common
secret-shaped values are removed, and query strings are reduced to allowlisted
`wait`/`with_response` values. The channel, application and message IDs are not
secrets; the interaction token always is.

## Health semantics

`operationsStatus` and the public status route distinguish:

- `configured_unverified` — credentials exist but no verified interaction in the
  recent window;
- `healthy` — recent interactions reached a terminal delivery state with no
  newer delivery failure;
- `degraded` — recent delivery failures, public-copy fallbacks or stuck
  processing rows;
- `unavailable` — not configured, or only failures recorded.

A key being present is never reported as green health.

## Recovery

A persisted draw receipt can be re-sent with `Re-send receipt`. That path reads
`fb_discord_interactions.receipt_json` and never calls `executeDraw`, so it
cannot charge again or roll a new card. If no receipt exists, the action is
recorded as pre-commit and no paid retry is offered.

## Scheduled work and alerts

The Worker scheduled entry now runs each maintenance step in isolation:
`rate_limits`, `magic_links`, `stale_interactions` and `npc_progression`. A
failure in one step is recorded and the remaining steps still run. The EmDash
editorial/publication handler is invoked separately and runs even if maintenance
cannot start. Success and failure are logged as one bounded JSON receipt with
`ok` and per-step results.

A failed maintenance run calls the admin alert integration. The payload is
mention-free, bounded, carries a correlation id and is scrubbed of caller-supplied
secrets. Delivery is one POST attempt (an ambiguous non-idempotent send is not
retried automatically) with a five-second abort. If
`ADMIN_DISCORD_WEBHOOK_URL` is absent, the integration reports
`configured: false` and sends nothing.

**Production dependency:** the deployed Worker has no
`ADMIN_DISCORD_WEBHOOK_URL` secret. The integration is tested with a stub
(`tests/workers/scheduled.test.ts`) and the destination remains an explicit
owner-supplied secret. Do not claim working production alert delivery until it
is configured and a real alert is read back.

**Deployed scheduled-run receipt:** `wrangler tail` captured a real cron
invocation on 2026-11-04 at 03:25 UTC (14:25 AEDT) against Worker
`91e5c2bf-3451-42e2-887e-d0e5a72d1437`; it proved the scheduled entry ran but the
deployed build did not emit the per-step log.

A second real invocation at **03:40 UTC (14:40 AEDT)** on the corrective Worker
`36b8705a-8413-4e79-a31f-1a14c6ee89f5` recorded:

```json
{"level":"info","message":"scheduled maintenance","ok":true,"steps":[{"name":"rate_limits","ok":true},{"name":"magic_links","ok":true},{"name":"stale_interactions","ok":true,"detail":"0"},{"name":"npc_progression","ok":true}]}
```

The retained private copies are
`.foilbury/evidence/deployed-scheduled-run-2026-11-04.json` and
`deployed-scheduled-run-2026-11-04b.json`. This proves the deployed scheduled
entry and all four bounded steps returned success on that run. It is one
sampled run, not a retention or alert-delivery proof.

## Required checks


- `pnpm test:workers --run tests/workers/discord.test.ts`
- `pnpm test:workers --run tests/workers/discord-redaction.test.ts`
- `pnpm test:workers --run tests/workers/scheduled.test.ts`
- `pnpm test:production-path`
- `pnpm test:ui`
- `pnpm test:product`
