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
