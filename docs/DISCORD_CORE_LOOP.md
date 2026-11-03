# Discord core loop — `/foilbury open`

## Current contract

- Invocation: `/foilbury open` (nested subcommand). `pool` is optional and
  defaults to `cabinet-draw`.
- No website registration is required. A first Discord interaction creates the
  Bot member, wallet and starter allowance through the existing domain services.
- One intentional opening produces one committed draw, one serial, one ledger
  debit at the quoted price and a retrievable receipt. Retries and repeated
  button presses reuse the interaction/domain idempotency key.
- Every deferred acknowledgement is private (`flags: 64`). Discord fixes the
  visibility of the original response; a later flag cannot make it public.
- A public result is only delivered through a deliberate follow-up after the
  original is settled with the private receipt. The `/foilbury open` reveal is
  private by default; a permitted card gets an explicit **Share to channel**
  button instead of an automatic public post.
- Restricted art never creates a channel-visible follow-up. The test channel
  currently has no verified member audience, so only explicit public-original
  shares are eligible.

## First-run and recovery behaviour

- If `cabinet-draw` has no eligible cards for this member, the bot presents a
  **Choose your capsule** picker with real eligible pools, prices and an explicit
  open button. Viewing the picker charges nothing.
- If the member has insufficient Foil, the response says **Not enough Foil** and
  points to `/foilbury daily` and `/foilbury packs`.
- An empty pool points to `/foilbury packs` and collection preferences.
- A disabled installation/channel explains the next admin action.
- The command description, help text and buttons all use the actual nested
  invocation. A standalone `/open` is not registered and is not intercepted;
  help/entry points make `/foilbury open` discoverable.

## Tests

`tests/workers/discord.test.ts` covers:

- the signed HTTP PING and real handler path;
- default `/foilbury open` with no pool (real draw, one debit, receipt);
- an empty default that returns real eligible alternatives and charges nothing;
- insufficient funds with a daily/packs next step;
- selected eligible pool, empty/disabled pool, wrong guild/channel, unbound
  installation, concurrent opens, retry/replay and restricted-art ephemerality;
- `/foilbury missions`, NPC inspection and the guided tour handler.

`pnpm demo:discord:check` is a read-only production preflight (15 PASS / 2
BLOCKED at the last read). It does not prove a live client invocation.

## Live acceptance still required

1. In the real Discord desktop client in `#card-collector-test`, run
   `/foilbury open` with no pool and confirm the reveal, serial and balance.
2. Repeat on the real mobile client.
3. Repeat with an empty default (after temporarily hiding the default
   collection for a dedicated demo identity, or use a dedicated empty pool) and
   confirm the picker is clear and does not charge until pressed.
4. Trigger insufficient funds on a dedicated low-balance identity and confirm
   the daily/packs recovery copy.
5. Optionally run `/foilbury missions` and claim one mission; confirm one
   ledger credit and no duplicate on a second press.
6. A controlled second account confirms what is ephemeral versus visible.

The test channel still has no `@everyone` View Channel deny, so no member-only
art may be posted there. No permission was changed by this work.

## Live delivery repair (2026-11-04)

Production logs showed two real `/foilbury open` interactions on 2026-11-03
(12:53 and 12:54 UTC) that committed a draw and charged 80 Foil each, but left
an empty public placeholder and a `processing` interaction row. The cards were
in inventory (Homura Akemi Plain and Madoka Kaname Plain), but the reveal never
arrived.

The delivery path is now bounded and terminal:

- every Discord webhook request has an 8-second timeout instead of an unbounded
  fetch;
- a missing/unreadable render strips the `attachment://` reference and sends the
  embed as a visible text receipt with a named recovery path;
- a failed follow-up falls back to editing the deferred placeholder; it never
  leaves a blank message;
- `recordFinish` runs exactly once through a guarded `finish()` helper;
- the scheduled Worker maintenance marks interactions stuck in `processing` for
  more than 10 minutes as `failed / delivery_timeout`, without touching the
  committed card or ledger;
- tests cover a missing render, a dead Discord webhook and stale-processing
  expiry;
- every failed request is logged with an allowlisted route template, a safe
  correlation ID and scrubbed detail; interaction tokens never survive;
- a committed draw with failed delivery is recorded as completed with
  `delivery_failed`, keeps its persisted receipt, and offers a re-send path that
  cannot draw or debit again.

The two empty bot messages were deleted from `#card-collector-test` as
housekeeping; the awarded cards and ledger rows were not changed.

## Deployment dependency

Production is now `0782b12d-3bb0-41af-ba70-0e46365aacba` from source
`fc325f5`, migrations through `0022`. The delivery fix itself is in the next
revision containing this document; until that revision is deployed, the live
empty-message defect remains possible. The fixed source registers `missions` and
`npc` in the guild command tree.
