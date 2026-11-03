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

## Required checks

- `pnpm test:workers --run tests/workers/discord.test.ts`
- `pnpm test:workers --run tests/workers/discord-redaction.test.ts`
- `pnpm test:production-path`
- `pnpm test:ui`
- `pnpm test:product`
