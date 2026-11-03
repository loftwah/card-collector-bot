# Discord core loop — `/foilbury open`

## Current contract

- Invocation: `/foilbury open` (nested subcommand). `pool` is optional and
  defaults to `cabinet-draw`.
- No website registration is required. A first Discord interaction creates the
  Bot member, wallet and starter allowance through the existing domain services.
- One intentional opening produces one committed draw, one serial, one ledger
  debit at the quoted price and a retrievable receipt. Retries and repeated
  button presses reuse the interaction/domain idempotency key.
- The reveal is ephemeral for restricted member art unless the channel audience
  is verified. Public-safe originals may be shareable; member-only art stays
  ephemeral in the current test channel.

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

## Deployment dependency

The repaired source is `a39e2bf` (plus the current mission work). Production is
still `c4581234…` from `2c133ee`; the live command uses the older source until
the approved release. The preflight command list therefore does not yet show
`missions` or `npc`.
