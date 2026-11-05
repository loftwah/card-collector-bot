# NPC collectors

Foilbury supports persistent, clearly labelled synthetic collectors. They are
ordinary `fb_users` rows with `is_synthetic = 1` and `synthetic_kind = 'npc'`,
a real Bot-scoped wallet, membership, inventory, serials and ledger. They are
never Discord members, human testimonials or fabricated engagement.

## Data model

| Table | Purpose |
| --- | --- |
| `fb_users.is_synthetic` | Hard separation from human sign-in. Login, magic-link and passkey lookup reject these rows. |
| `fb_npc_collectors` | Bot, display name, original avatar, bio, preset/version, goals, schedule, status and action counters. |
| `fb_npc_actions` | Every planned/completed/skipped/failed action with the pool, price, draw/instance ids, before/after snapshot and a unique idempotency key. |
| `fb_npc_limits` | Per-Bot `max_npcs`, `max_draws_per_day` and a global `paused_all` switch. |

NPC draws use the same `getPoolPreview` and `executeDraw` services as a human.
Ordinary odds, price, allowance, achievement evaluation and frozen roster data
are unchanged. Serial prefixes use the NPC display name, but identify the same
instance and ledger receipt as any other draw.

## Presets

`casual_explorer`, `completionist`, `gold_hunter`, `holo_hunter`,
`variety_collector`, `friendly_collector`, `rookie` and `established_rival`.

Presets choose **which eligible capsule to open** by scoring the current
distribution. They never improve odds, add entries, change weights or award
cards outside a real draw. A preset can use a focus collection and/or a fixed
pool slug.

## Controls and limits

- Create one or a bounded batch (1–10) from Studio → NPC collectors.
- Preview the next permitted action, Play Once, Run 3 (bounded batch), inspect
  receipts, edit goals/schedule, clone into a separate wallet, pause, resume or
  retire.
- Reaching a limit records a `skipped` action with a reason. Nothing is charged,
  awarded or retried unbounded.
- `paused_all` stops every NPC on the Bot immediately.
- A retired NPC keeps its cards, serials, ledger and achievements. Retirement is
  not a destructive reset.
- Scheduled progression runs from the existing Worker cron after EmDash's
  scheduled handler, at most ten NPCs per Bot per invocation and only when the
  NPC's own schedule is enabled. Manual runs remain available.

## Authority

- Super Admin: platform oversight.
- Bot Owner: `npc.manage` by default.
- Bot Admin: only when the invitation includes `npc.manage`.
- Global Collection Admin: **not** NPC authority over every Bot.
- Ordinary members: read the member-facing lounge and comparisons only.
- Agents: `npc:read` for inspection; `npc:write` plus the represented human's
  current `npc.manage` authority for every mutation.
- NPC-to-human trades and gifts are blocked by default. Human-issued admin gifts
  exclude synthetic accounts from recipient resolution.

## Surface entry points

- `/studio/npcs` — first-class Bot-scoped Admin workspace.
- `/play/rivals` — member-facing NPC lounge and honest side-by-side comparison.
- `GET /api/v1/npcs/admin`, `POST /api/v1/npcs`, `POST /api/v1/npcs/:id/play`,
  `preview`, `run`, `pause|resume|retire`, `actions`, `compare` and
  `POST /api/v1/npcs/run-scheduled`.
- MCP tools prefixed `foilbury_npc_`.
- Discord: `/foilbury npc [name]` — ephemeral, on-demand inspection only. There
  are no scheduled NPC messages or fake member accounts.

## Acceptance and evidence

`pnpm test:npc` exercises creation, synthetic sign-in denial, a real draw with a
serial and ledger spend, idempotent replay, insufficient funds, daily caps,
pause/resume/retire, cross-Bot denial, Global Collection Admin denial, agent
scopes, comparisons, a bounded batch and scheduled progression.

`pnpm test:npc:ui` drives the actual Studio UI and member lounge in Chromium,
then removes its temporary fixture. `pnpm demo:npcs` creates or refreshes the
three local demo collectors with original Foilbury portraits and real recorded
draws; it refuses non-loopback origins.

Evidence: `docs/evidence/npc-studio.png`, `docs/evidence/npc-lounge.png`,
`docs/evidence/npc-lounge-mobile.png`, `docs/evidence/npc-browser.json`,
`docs/evidence/npc-studio-receipts.png`.

The original portrait sources are under `brand/npc/`; the served 512×512 WebP
avatars are under `public/brand/npc/`. They are original Foilbury characters,
not third-party likenesses.

## Not claimed

A local NPC proving its own persisted records does not prove a real Discord
host/spectator journey, which remains #7's human acceptance gate.

## Local draft: NPC trade candidate

`POST /api/v1/npcs/:id/trade-preview` accepts `offeredInstanceId` and
`requestedInstanceId` from a signed-in human player. It reports interest in a
one-copy-for-one-copy offer for different subjects in the same catalogue with the same valid rarity,
material and effect, provided an additional currently eligible NPC copy of the
requested subject can be proven. This is a simple matching rule, not a claim of
equal market value; print scarcity and player preferences are not priced. The assessment is read-only:
it neither reserves nor transfers copies, and is not a promise that a later
offer will be accepted. `POST /api/v1/npcs/:id/trade-offers` uses an
idempotency key to persist a decision and reserve an interested pair. The
player explicitly confirms or cancels via `/api/v1/npcs/trades/:id/confirm`
or `/cancel`; `/api/v1/npcs/trades` returns a minimal private status list.
The pending Discord entry offers private, actor-bound suggestions and buttons.

The draft conservatively excludes private collections, delegated agents, and
artwork with unknown, derivative or recorded input ancestry when AI art is
disabled. It applies daily attempt/completion caps and prevents returning a
previously exchanged copy to the same NPC. A bounded scheduled task expires
abandoned offers and releases both reservations atomically. The schema under
`docs/pending/` is not numbered or automatically applied; migration ordering,
rollback and the shared recursive lineage policy must be resolved first.
The spare proof checks at most eight other copies using the subject index and
current visibility and art rules. It can return unavailable even when another
eligible spare exists outside that window; availability and timing may vary
with copy order, including when hidden copies precede an eligible spare. This is not perfect secrecy. The proof is checked again in the transaction. Discovery stores a source-bound receipt for the latest page and rechecks the
current audience before retry; it offers a fixed budget of four pages. Each
page scans at most four distinct indexed windows of eight copies per side, and
shows up to three live-authorized pairs. Once internal traversal is exhausted,
remaining pages are empty without repeating pairs. Continuation does not reveal
whether more inaccessible copies exist. Players can stop or start a new search;
a new search can repeat the same sample. Timing and result position can still
vary with hidden copies, and the fixed budget can miss valid pairs. The SQL
limits JSON parsing, but SQLite still has to read TEXT values to evaluate their
length, so this is not a hard total CPU or storage-read guarantee. The change
remains held pending independent review and realistic latency testing.
Each window samples up to three of 64 possible pairs, so these are sampled
ideas, not an exhaustive match list. The implementation remains held pending
independent review and wider adversarial tests.
The exchanged-copy index also needs migration preflight/backfill if prior NPC
exchanges exist. Nothing here is deployed. Real Discord rendering, inline artwork, performance
with large inventories, full audience review and a real-client exchange remain
unverified.
