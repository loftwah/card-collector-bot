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
| `fb_npc_trade_decisions` | Deterministic accept/decline decision, reason and wants/spare snapshot for each human-initiated NPC trade. The trade itself uses the ordinary `fb_trades` lifecycle and triggers. |

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
- Humans may initiate exact-copy trades with an active NPC from `/play/trades`
  or `/foilbury trade`. The NPC may accept or decline deterministically from its
  preset, recorded goals and current holdings. NPCs never initiate a trade, send
  a gift, join a guild or act as a second human participant. Human-issued admin
  gifts still exclude synthetic accounts from recipient resolution.
- Every offer reserves both copies before the NPC decision. Accepting both sides
  completes the exchange atomically through the ordinary trade lifecycle and
  ownership triggers; declining or cancelling releases the reservations. Serials
  and acquired-at history are preserved.

## Surface entry points

- `/studio/npcs` — first-class Bot-scoped Admin workspace.
- `/play/rivals` — member-facing NPC lounge and honest side-by-side comparison.
- `/play/trades?npc=<npc_id>` — NPC trade desk: offer an exact owned copy, request
  one of the NPC's copies, ask for a decision and confirm or cancel.
- `GET /api/v1/npcs/admin`, `POST /api/v1/npcs`, `POST /api/v1/npcs/:id/play`,
  `preview`, `run`, `pause|resume|retire`, `actions`, `compare` and
  `POST /api/v1/npcs/run-scheduled`.
- `POST /api/v1/npcs/:id/trade/preview` and `/trade`; `GET /api/v1/trades`
  returns the same persisted NPC and human trades.
- MCP tools prefixed `foilbury_npc_`, including `foilbury_npc_trade_preview` and
  `foilbury_npc_trade_execute`.
- Discord: `/foilbury npc [name]` — ephemeral, on-demand inspection only.
  `/foilbury trade npc:<slug> give:<serial> take:<serial>` returns an ephemeral
  preview with Confirm exchange and Cancel offer buttons. There are no scheduled
  NPC messages or fake member accounts.

## Acceptance and evidence

`pnpm test:npc` exercises creation, synthetic sign-in denial, a real draw with a
serial and ledger spend, idempotent replay, insufficient funds, daily caps,
pause/resume/retire, cross-Bot denial, Global Collection Admin denial, agent
scopes, comparisons, a bounded batch and scheduled progression. The trade suite
adds deterministic accept/decline, exact-copy reservation, dual acceptance,
atomic completion, serial preservation, cancel/decline release and cross-Bot
denial.

`pnpm test:npc:ui` drives the actual Studio UI and member lounge in Chromium,
then removes its temporary fixture. `pnpm demo:npcs` creates or refreshes the
three local demo collectors with original Foilbury portraits and real recorded
draws; it refuses non-loopback origins.

Evidence: `docs/evidence/npc-studio.png`, `docs/evidence/npc-lounge.png`,
`docs/evidence/npc-lounge-mobile.png`, `docs/evidence/npc-browser.json`,
`docs/evidence/npc-studio-receipts.png`.

A declined preview was also exercised against Taro Brass: offering Chiaki
Nanami Silver `FB-3-DE-4E3CB0` for Victor Wembanyama Gold `FB-4-TA-A2CA60`
returned `decline` with “The collector cannot spare Victor Wembanyama
FB-4-TA-A2CA60: the NPC's only goal copy.” No trade row and no reservation were
created by the preview.

Production cast (2026-11-08): Mina Quill (`completionist`), Taro Brass
(`gold_hunter`) and Juniper Vale (`friendly_collector`), each with 1,200 Foil and
eight real draws. Dean's first human-initiated NPC trade,
`trd_mw6vw8jl6zv9c2pbsh9jwzs5`, completed against Taro Brass: Anakt Garden Gold
`FB-4-DE-7A6A37` moved to Taro, and Gonta Gokuhara Plain `FB-4-TA-626A51` moved
to Dean. The trade produced no new instance or Foil row; both serials and
`acquired_at` values are unchanged. Production counts after settlement: 147 card
instances, 230 Foil ledger rows, one NPC decision, one completed trade.

The original portrait sources are under `brand/npc/`; the served 512×512 WebP
avatars are under `public/brand/npc/`. They are original Foilbury characters,
not third-party likenesses.

## Not claimed

A local NPC proving its own persisted records does not prove a real Discord
host/spectator journey, which remains #7's human acceptance gate.
