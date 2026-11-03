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
