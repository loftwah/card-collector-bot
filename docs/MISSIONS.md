# Daily missions

Daily missions are an optional extra Foil loop, separate from the once-a-day
allowance. They use the same D1 wallet, ledger, idempotency and reward-claim
trigger as every other earned reward. There is no Discord-only currency, no
purchase and no punitive streak.

## Assignment and period

- Canonical period: one UTC day (`YYYY-MM-DD`), reset at `00:00Z`.
- The UI also shows the equivalent **Australia/Melbourne** time and the exact
  UTC boundary. This is the same UTC period the database uses; there is no
  second local-midnight system.
- Up to three missions per member per Bot per day. The set is deterministic from
  eligibility, not a generative prompt:
  - `explore` — visit any authorised collection.
  - `inspect` — open one owned card (only if the member owns a card).
  - `open` — complete one ordinary eligible opening (only if the member can
    afford the cheapest active capsule).
  - `favourite` — mark one card as a favourite (fallback for low-balance members
    with cards).
- A member with no cards and no affordable capsule receives only `explore`,
  rather than an impossible task.

## Progress and trust

Progress comes from committed, server-side events:

- `collection.explored` — recorded once per collection by the human GET path.
- `card.drawn` — the existing committed draw event.
- `card.inspected` / `card.favourited` — deliberate once-per-UTC-day
  `fb_domain_events` rows; repeated reloads or toggles do not add progress.
- Agents, synthetic NPCs and raw page-load counters cannot earn missions.

Read-only calls never credit currency. A mission is claimable only when its
target is met.

## Claims and economy

- Catalogue version is recorded in the reward claim; the period is snapshotted.
- Claim inserts one `fb_reward_claims` row. The existing
  `rewards_apply_credit` trigger atomically credits the wallet and writes the
  ledger row, so concurrent Web/Discord/API claims produce one reward.
- Mission rewards: 60 Foil each for explore/inspect/open, 40 for favourite.
  Daily cap: **180 Foil** (three missions). These are local defaults; this is not
  an approved production economy change.
- Ledger description for mission claims is “Daily mission reward” (migration
  `0021`); the daily allowance keeps its own description.
- Replays return the original claim and never credit twice.

## Surfaces

- `/play/missions` — member view with progress, reward, claim, next reset,
  Melbourne/UTC wording and keyboard/touch states.
- `GET /api/v1/missions/daily` (`missions:read`).
- `POST /api/v1/missions/daily/claim` (`missions:claim`), body `{ "key": "..." }`.
- `/foilbury missions` — ephemeral status and claim buttons.
- MCP: `foilbury_missions_daily`, `foilbury_mission_claim`.
- The website and Discord read and write the same D1 rows.

## Tests

`tests/workers/missions.test.ts` covers zero-progress, incomplete claims with no
credit, one completed claim, replay, concurrent claims, deliberate event
dedupe, low-balance/no-card assignment, UTC-boundary exclusion, synthetic-actor
denial and named agent scopes. `tests/workers/discord.test.ts` covers the
ephemeral mission view, claim button, replay and one ledger credit.

## Not claimed

This is a local implementation. Production economy changes, owner review of the
reward sizing, live Discord verification and deployment remain separate gates.
