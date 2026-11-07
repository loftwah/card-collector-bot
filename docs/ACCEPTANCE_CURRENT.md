# Current acceptance view

The current machine-readable matrix is `docs/release-acceptance.json`. It is
bound to the exact source tree and is validated by `pnpm release:check`. Older
hand-written reports remain historical and are not release authority:

- `docs/DISCORD_ACCEPTANCE.md` — archive of earlier deployed-pilot snapshots.
- `docs/LOCAL_ACCEPTANCE.md`, `docs/acceptance-report.json` — original local gate.
- `docs/PASS_HANDOFF.md`, `docs/DISCORD_HANDOFF.md` — historical handoff notes.

## What "pass" means here

- **Domain pass** — the domain invariant is proven by a focused test against
  D1/R2 or a pure service fixture.
- **Production-path pass** — a signed fixture runs through the emitted Worker
  artifact, deferred lifecycle, durable receipt and delivery double.
- **Live API pass** — the current Discord application, command schema, guild,
  channel and effective bot permissions were read back.
- **Authentic interaction pass** — a real authorised person invoked the command
  and the delivered message/receipt was observed.
- **Client/audience pass** — the real desktop/mobile presentation was inspected,
  and an independent authorised spectator observed the same result.

A lower layer never silently passes a higher one. `docs/release-acceptance.json`
marks only the first three as current required evidence; authentic interaction
and spectator observation remain explicitly `blocked` until performed.

## Current residuals

- A real mobile Discord client invocation by the authorisation holder. The
  signed-in desktop client was driven through the retained sequence on
  2026/11/04; mobile is still open.
- An independent authorised spectator observation. A second tab of the same
  account is not a spectator.
- The scoped live grant to the designated Admin requires the owner's recent
  strong-auth step at the time of the change.
- Guild channel/role setup mutations require `MANAGE_CHANNELS` / `MANAGE_ROLES`
  or an owner-applied subset; see `docs/DISCORD_SETUP.md`.
- Sourced official collection logos (wordmarks/icons) are still a content task;
  current marks are reviewed Foilbury interpretations.
- Production import of the two new roster subjects remains separate from the
  local manifest/render proof.
- The channel audience is verified as `members` from the current three-person
  private test guild. A future non-member invitee could see retained member
  artwork; re-verify if guild membership changes.

## 2026-11-04 evening — server scope, AI provenance and persistent demonstration

- Latest deployed build: source `2ab20a515224606af8ed8cee773a30f88f04afd8`,
  Worker `85d3fb74-d448-4312-958f-5504d31e7d8e`, schema
  `0027_ai_art_provenance_and_scope.sql`. The persistent demo was produced by
  source `a33e4dc` / Worker `dfe306d3`; the later release adds the Studio AI
  preference and the read-back verifier.
- **Persistent demonstration delivered:** twelve ordinary retained messages,
  start `1567443524209872926`, conclusion `1567443613346959481`. Full stage
  table, receipts and residuals: `docs/PERSISTENT_DEMO_2026-11-04.md`.
- **Real interaction pass:** 15 real draws, 15 instances, 15 spend rows
  (−1,200 Foil), one `Three schools` unlock, one 640 Foil reward ledger row, one
  mission claim/replay, one share receipt. Reconciled from production D1.
- **Persistent delivery pass:** Discord API read-back 12/12 PASS; every required
  image HTTP 200; signed-in desktop client reloaded and scrolled.
- **Configured-server scope pass:** one enabled Danganronpa album, verified
  members channel, scope digest `5ee761338552f0e1fbadb3957dc75ca42a3d5519a7b60fc25d6681af23f76e87`;
  six focused scope tests; no out-of-scope content or spend.
- **Independent audience/client pass:** **BLOCKED** — no second-account
  spectator and no real mobile client. The preflight with the recorded desktop
  actor evidence is **19 PASS · 0 FAIL · 3 BLOCKED** (pin, channel visibility,
  spectator).
- **AI provenance/toggle:** typed `origin`, queryable generation records,
  per-Bot `ai_art_enabled` default off, Studio/Admin toggle exercised in
  production `false → true → false`, visible origin label. `pnpm art:audit`.

## 2026-11-04 visible tour and release evidence update

- Final deployed build: source `4a6f04c7d0050679317ea8d83cb835f416e79028`, Worker
  `86d916ce-3e81-4349-830e-9e36fca18682`, schema
  `0026_gift_instance_uniqueness.sql`. Rollback target:
  `d343b9c5-5372-42c8-8228-16d82d9b482b`. The build-bound production smoke passed
  after deployment.

- The persistent **Start the Foilbury tour** entry is live at
  https://discord.com/channels/997734945206313041/1566700752385081355/1567185366014763079
  (message `1567185366014763079`). It has a real `foilbury:tour:welcome`
  component, Claim daily, Packs and three web links. API read-back and the
  Discord preflight pass; the owner's actual click is still unperformed.
- Preflight is **17 PASS, 0 FAIL, 4 BLOCKED**. The new PASS is the tour entry;
  the four blocked items remain pinning, channel visibility, an independent
  spectator and an authenticated actor session.
- The command-execution health gate is `pnpm discord:command-health`. It draws
  only through the emitted Worker against an isolated D1/R2 fixture and writes
  `.foilbury/evidence/discord-command-health.json`. It is not a live draw.
- A real deployed scheduled invocation was captured with `wrangler tail`:
  Worker `91e5c2bf-3451-42e2-887e-d0e5a72d1437`, cron `*/5 * * * *`, outcome
  `ok`, 2026-11-04 03:25 UTC. It proves the scheduled entry ran, not each step's
  side effect.
- Production content read-back is **21 collections, 156 cards, 640 variants,
  640 fronts, 640 backs**. Gonta Gokuhara and Kamui Gakupo are still local-only;
  see `docs/CONTENT_QUALITY_MATRIX.md` for the named omissions and bounded
  import plan.
- Release-gate hardening adds working-tree content identity, a complete
  module/asset digest, a freshly fetched remote ref, a verified previous Worker
  version and an affected-scope evidence check. Negative tests cover each.

## Assisted Discord acceptance runner (2026-11-04)

`scripts/discord/assisted-acceptance.mjs` now writes a bounded acceptance
session before any human step:

```sh
node scripts/discord/assisted-acceptance.mjs --prepare \
  --guild <guild-id> --channel <channel-id> --actor <discord-user-id>
node scripts/discord/assisted-acceptance.mjs --verify <interaction-id> \
  --session .foilbury/evidence/discord-assisted/session-<timestamp>.json
node scripts/discord/assisted-acceptance.mjs --watch --session <file> --minutes 10
node scripts/discord/assisted-acceptance.mjs --spectator <observer.json> --session <file>
```

The session records the environment, origin, `x-foilbury-build` read from
`/api/v1/status`, worker version when discoverable, guild, channel, initiating
account, start/end window, session id and expected cases. Use
`--cases open,daily,share` to bound a smaller run; the default covers all ten
prepared cases. Verification rejects any interaction outside that binding.
`processing` stays pending and `--watch` rechecks the same interaction until
`completed` or `failed`, or reports `timeout_pending` after the bounded window.

Per-command rules are separate. Read-only commands have no draw or ledger
requirement; daily and mission claims require one matching reward claim and
credit; open requires one exact draw debit (`reference_id = draw_id`), one owned
instance with the receipt serial, correct currency and a reconcilable balance;
shares require one durable share row and public delivery. A `failed` interaction
is never a success, even when `receipt_json` parses to `{}`; it must carry a real
ApiError code. Unrelated ledger rows are never counted.

Reports name the layer that established each fact: **API** (status/build),
**database** (D1 interaction, receipt, economics), **actual client** (never
claimed without an observer) and **observer/attestation**. A spectator file is a
hand-authored attestation, not proof: it must name the session, guild, channel,
Discord message id, a different actor, an `observed_at` inside the window,
`observed_intended_share: true` and `private_content_absent: true|false|"unverified"`.
A screenshot or API read-back is not accepted as proof that private content was
absent.

Read-only slash interactions currently store only the top-level `foilbury`
command in D1. The runner therefore requires `--case <case-id>` to bind a
read-only subcommand as an operator attestation. `--watch` reuses a terminal
`--verify` report for the same session, so `--verify --case help` also binds that
interaction during the watch. Economic commands are bound by their durable draw,
claim or share rows, not by a label.

The focused tests are `node --test tests/scripts/assisted-acceptance.test.mjs`.
They are logic and negative-control tests only. A green run does not replace a
real Discord invocation or an independent observer; those remain blocked in this
document.

## 2026-11-06 Studio collections loading states

PR #89 merged at `517b3f280464c5590cb073d8bba2ba52f71971d7` and deployed as
Worker `a16d2774-5fac-44c9-bf80-79f40ae9afea`. The routine release rebuilt the
artifact, passed all 18 read-only production smoke checks and wrote
`.foilbury/evidence/release-receipt-517b3f280464-ba811d01-5fd4-4278-b9a5-f87c5ad7748b.json`.
The exact merged source passed the isolated supervisor at
`.foilbury/evidence/technical-candidate-9BkfXc/receipt.json` (sha256
`d567549913188b1730afc2e4d870b1750b964c02cbc82127ba411d675ee96682`): `pnpm check`,
built Worker, UI (54), product (59/59), artwork (11/11), album, privacy and
performance. An initial run failed an unrelated `public-inspector` focus
assertion; the same container passed that test alone and the full re-run passed.

The synthetic built-Worker Studio journey held the real `/studio/collections`
request, observed eight reduced-motion placeholders and no `0 on · 0 shown` or
empty-list claim, then loaded real collections. A forced 503 showed
`Collections unavailable`; keyboard retry loaded the real data. Desktop
selection and serious/critical axe passed. The journey found `aria-label` on a
generic loading `div`; the detail placeholder now has `role="status"`, and the
component fixture checks axe during loading as well as after load. The synthetic
Worker has five collections, so its create panel moved 102px; the eight-row
component fixture measured 0px at 390px and 1280px. Production pages eight rows,
and the live first page has more than eight collections.

Signed-in live read-back is **BLOCKED**: the retained bootstrap owner password
returns `invalid_credentials`, and no current magic-link, passkey or signed-in
browser session was available. The deployed `AdminApp.DDQntcOI.js` chunk is
byte-identical to the built artifact (`sha256
7280509a64baa72fe11ef79d451fa1bb003c0bd657955d2725eebef2b3ef8969`) and contains
the new loading, error and retry strings. This is technical artifact evidence,
not signed-in product acceptance. Physical-device and assistive-technology
checks remain unperformed; non-eight-row geometry can still shift.

## 2026-11-06 API dispatch contract (#16)

Runtime source `0886641e41d1f94c8c789a57b5db25f3fb168a5d`. `pnpm check`
passed 316 tests, including the new route-inventory contract. The inventory
records 168 dispatcher routes and 21 direct Astro routes with no shadowed or
duplicate branch, and reconciles 340 browser/CLI/MCP/OpenAPI consumer paths
(208 with an explicit method) with no unresolved path or method mismatch.
`/api/v1/studio/*` is checked as its executing admin alias.

The reconciliation found that the CLI and MCP card-merge call had no dispatcher
branch. `POST /api/v1/admin/cards/{id}/merge` now requires content write and
recent strong authentication, and an HTTP test asserts the persisted alias.
Operational pickers use `GET /api/v1/admin/people` (id, display name, role).
Contact records and invitations are human-only under the live `members`
capability at `/admin/team` and `/admin/members`; `/admin/bot` no longer carries
the people arrays. Economy-only and agent callers were denied the contact routes
in HTTP tests.

The exact built Worker at that source was exercised with a synthetic trade and
gift receipt. The phone gift page rendered the recorded description, note, value
and reason. The trade detail rendered both sides of the offer, recorded the
first acceptance, then the second, reached `completed`, and the serials
exchanged. Serious/critical axe findings were empty on the gift page and both
trade-detail states. Evidence is under
`.foilbury/evidence/gift-trade-ui-20261106/` in the isolated worktree.

Production was deployed from `617c773da4e970cdc9bcb3031d15a73528feb892` as
Worker `a3cc5c7b-0d0e-4147-93ff-fe4cb29c2ea3`. The release rebuilt the artifact,
passed `pnpm check` and all 18 read-only production smoke checks, and wrote
`.foilbury/evidence/release-receipt-617c773da4e9-9fc176a8-71e8-4e6b-893c-c59e34c53dc9.json`
in the release worktree. The live build header is `617c773da4e9`.

Signed-in live read-back is **BLOCKED** by the retained bootstrap owner
password returning `invalid_credentials`; production dev login is disabled and
no current magic-link, passkey or Access session was available. The deployed
`GiftComposer`, `AdminTeam` and `AdminApp` client chunks are byte-identical to
the built artifact (`sha256 161239ad…`, `7653fff1…`/`fd647612…`, `d7238c56…`).
Signed-out `/api/v1/admin/*` requests return the Access redirect, so they do not
prove the new route guards. This is technical artifact evidence, not signed-in
production acceptance.

## 2026-11-07 — independent profile composition and Storybook

- **Production:** source `2347ee66730f98db9ab5534bed7fc66744125195`, Worker
  `ab245dc5-cad6-44cc-ba6e-d5f887655274`. Receipt:
  `.foilbury/evidence/release-receipt-2347ee66730f-712c5a92-724d-4560-89f4-2488a84e9261.json`.
- **Schema:** additive `0029_profile_presentation.sql` added
  `profile_presentation_json` and `profile_presentation_version` to
  `fb_player_preferences`. A production D1 JSON backup was taken first:
  `.foilbury/backups/d1-2026-11-07T03-34-26-015Z.json` (94 tables, 32,849 rows,
  SHA-256 `9fd5d3332c81cc8b1527e9fa974b70540d7456352ac2c37564d4bf5fa96f1c84`).
  The previous Worker ignores both columns.
- **Gates:** `pnpm check` 113 unit + 321 Worker; `pnpm build`; `pnpm test:ui`
  54/54; `pnpm test:product` 57/57; Impeccable detector `[]`; Storybook static
  build and built-catalogue render/axe checks passed.
- **Live signed-in:** one-use owner magic link. At 390 and 1440 the profile page
  had no horizontal overflow, the featured card kept 5:7 geometry (0.7127), and
  axe found no serious/critical findings. The independent frame, avatar
  decoration, name treatment and effect survived save and reload; the exact
  featured copy was `Chiaki Nanami · FB-3-DE-4E3CB0`. The owner's prior
  preferences and favourite flags were restored and the magic-link row was
  deleted afterwards.
- **Discord preflight (read-only):** 18 PASS / 0 FAIL / 4 BLOCKED — command
  execution health, pin capability, spectator observation and authenticated
  actor session. BLOCKED remains unperformed, not accepted.
- **Remaining for #42:** locked/preview-only cosmetics, a dedicated
  share/export composer, and the full keyboard/touch reorder acceptance across
  the #40 viewport matrix. The Stitch state variants remain outstanding for
  #92.
