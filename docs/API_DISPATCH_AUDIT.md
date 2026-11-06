# API dispatch contract

This is the closing record for issue #16 against runtime source `0886641`. The
earlier gift/receipt and trade/detail shadowing fixes remain in place: list
routes match one segment and the receipt/detail routes have their own exact
patterns. The peer directory and administrative member list are separate
handlers.

## Route inventory

`pnpm api:inventory` reads `src/server/api/router.ts` and the direct Astro
routes under `src/pages/api`, then writes:

- `docs/API_ROUTE_INVENTORY.md` — method, path, guards, agent scope, request
  schema, side effects and source line for each first-matching branch;
- `docs/api-route-inventory.json` — the machine-readable inventory used by the
  contract test.

The current inventory contains **168 dispatcher routes** and **21 direct Astro
routes**, with **no duplicate or shadowed branch**. The extractor expands
literal alternatives such as `accept|decline|cancel` and `ops|admin` so a later
route cannot disappear behind a prefix. `tests/scripts/api-route-inventory.test.mjs`
fails if the committed inventory drifts, if an earlier branch accepts a later
branch's example path, or if a browser, CLI, MCP or OpenAPI path no longer
resolves.

The same test reconciles **340 consumer paths** (208 with an explicit method)
from browser components/pages, `scripts/foilbury.mjs`, `mcp/server.mjs` and the
test scripts. It reported no unresolved path and no method mismatch. OpenAPI
has no undocumented dispatch operation. `/api/v1/studio/*` is checked as the
`/api/v1/admin/*` alias it executes.

The reconciliation found one real break: the CLI and MCP called
`POST /api/v1/admin/cards/{id}/merge`, but the dispatcher had no branch even
though `mergeCards` was imported and OpenAPI documented it. The route now
requires content write and recent strong authentication, and an HTTP test
asserts the alias row is persisted.

## Contact boundary

Operational pickers use `GET /api/v1/admin/people`, which returns `id`,
`display_name` and `role` only. Economy, gift and agent screens use it.

Contact records are human-only:

- `GET /api/v1/admin/members` and `GET /api/v1/admin/team` require the Bot
  Owner, Super Admin, or a Bot Admin with the live `members` capability.
- Agent grants are denied with `human_admin_required`.
- `GET /api/v1/admin/bot` now returns Bot settings only. It no longer carries
  administrator email addresses or invitation addresses.
- The Studio team page redirects accounts without the `members` capability.

`tests/workers/api-dispatch-http.test.ts` proves a player with only `economy`
can use `/admin/people` but not `/admin/members`, a live `members` grant opens
both, an `ops:read` agent sees names but never contact records, and the Bot
settings response no longer contains the people arrays.

## HTTP and UI evidence

`tests/workers/api-dispatch-http.test.ts` and `tests/workers/route-contract.test.ts`
cover gift list vs received receipt, trade list vs individual detail, peer vs
privileged directory, the merge route, the suffix fixture matrix, trailing and
interior slashes, unsupported methods, agent scopes, and no-mutation denial
cases. `pnpm check` passed 316 tests.

The exact built Worker at runtime source `0886641` was exercised with a real
synthetic trade and gift receipt:

- `/play/gifts` showed the recorded description, note, value and reason on a
  phone viewport;
- `/play/trades` showed both sides of the individual offer, recorded the first
  acceptance, then the second, reached `completed`, and the serials exchanged;
- serious/critical axe findings were empty on the gift page and both trade-detail
  states.

Evidence, including the built-Worker journey and screenshots, is under
`.foilbury/evidence/gift-trade-ui-20261106/` in the isolated worktree.

## Residuals

These are not claimed by #16:

- Historical trade-detail privacy after a card or collection audience changes is
  re-homed to the audience-safe sharing work in #15.
- Complete artwork-lineage policy is re-homed to #10.
- The held Studio wallet recipient selector and its active-human eligibility
  guard are re-homed to the economy/wallet work in #30.
- The direct Astro auth/security routes are inventoried and consumed by existing
  auth/security suites; they are not a second dispatch table and do not change
  the findings above.

No production data was mutated by this audit. Deployment status and the live
read-back are recorded in the release receipt when the change is deployed.
