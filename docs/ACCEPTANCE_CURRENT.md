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
