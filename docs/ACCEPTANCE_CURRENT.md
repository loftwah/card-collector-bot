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

- A real Discord desktop/mobile invocation by the authorisation holder.
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

## 2026-11-04 visible tour and release evidence update

- Final deployed build: source `3ffa24197e82c1488933418de8e1a7935fea66a8`, Worker
  `608c92ab-034d-4b5b-8b91-bef11a890f8f`, schema
  `0026_gift_instance_uniqueness.sql`. Rollback target:
  `36b8705a-8413-4e79-a31f-1a14c6ee89f5`. The build-bound production smoke passed
  after deployment. Two later commits (`57c57f9` and its docs companion) are
  tooling/documentation only and are not part of the deployed runtime source.

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
