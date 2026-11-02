# Foilbury

Foilbury is a standalone, local-first collectible-card cabinet: a curated collection game, an owner-managed content library and a headless service for agents. It is built with TypeScript, Astro, React, Cloudflare Workers simulation, D1 and R2.

The intended production hostname is **foilbury.loftwah.com**, but this build is **not deployed**. The working local URL is the one printed by `pnpm setup:local` and confirmed by `pnpm doctor` — normally `http://127.0.0.1:4321`. The server binds to loopback.

Discord is a future entrypoint, not the product's authority. It is disabled and unconnected. Email is a local outbox; image generation is not called.

## Start locally

```sh
pnpm install
pnpm setup:local
pnpm doctor
pnpm dev
```

`pnpm setup:local` is non-destructive after the first run. On a fresh local database it:

1. generates allowlisted local runtime secrets in `.dev.vars` (mode 600);
2. applies local D1 migrations;
3. creates one owner tenant and two fixture tenants;
4. creates local owner/player accounts with random passwords in `.foilbury/local-credentials.json` (mode 600);
5. creates scoped owner/player agent credentials in `.foilbury/agents.json` (mode 600);
6. imports the curated Bubbles, Fighter and Protocol 11 selection;
7. renders the layered card finishes locally and activates a catalogue release.

Use `pnpm setup:local --skip-sources` if you only want the accounts and schema. The source import needs the sibling checkouts; the running game does not.

Open `http://127.0.0.1:4321`, sign in with the local accounts (or the explicit loopback development sign-in), and use the cabinet.

## Useful commands

```sh
pnpm dev                  # start Astro/Workers local server (daemonised by Astro 7)
pnpm exec astro dev status
pnpm exec astro dev logs
pnpm check                # Astro/TypeScript check plus unit and Workers integration tests
pnpm test:e2e             # real Chrome E2E, screenshots into docs/evidence
pnpm test:agent           # real stdio MCP client plus CLI against the running service
pnpm test:persistence     # stop/start the local server and compare inventory/ledger state
pnpm doctor               # missing/configured/locally verified/live verified/unverified
pnpm db:migrate:local     # apply D1 migrations locally only
pnpm sources:discover     # inspect sibling source commits/hashes
pnpm sources:preview      # diff the curated manifest without writing
pnpm sources:import --apply
pnpm cards:render         # process the durable local render queue
pnpm sources:import --apply --publish
pnpm foilbury help        # JSON-capable CLI over the same authorised commands
pnpm mcp                  # local stdio MCP server
pnpm backup               # Foilbury domain D1/R2 export with checksums, excluding secrets
pnpm restore --backup <dir>   # verify into an isolated local target
pnpm acceptance:local     # run the full local acceptance gate and write evidence
```

`pnpm acceptance:local` writes:

- `docs/acceptance-report.json` — machine-readable gate results;
- `docs/LOCAL_ACCEPTANCE.md` — human evidence, limitations and owner playtest checklist;
- `docs/evidence/` — E2E screenshots, MCP/CLI evidence, persistence evidence.

## What is in the cabinet

The seed catalogue is a curated selection, not a franchise whitelist:

- **Bubbles** cast previews and world backgrounds;
- **Fighter** launch and expanded-roster portraits;
- **Protocol 11** table-night avatars and a table background.

It currently contains **16 identities, 19 artwork editions, 80 explicit variants and 4 backgrounds**. Loftwah, Pippa and Pepe appear in more than one source; they share a stable identity and keep separate artwork editions with source repository, relative path, commit and hash recorded.

Artwork is composed as background → subject → material → frame → effect → exact application text. Plain, Silver, Gold, Diamond and Holographic/Prismatic finishes are authored layers, not CSS tints. Renders are stored in local R2; the source library remains private. Public card exports are explicit.

## Architecture

```
src/pages/            Astro public, player and admin shell
src/components/       Astro and React/shadcn-style interface
src/server/           identity, catalogue, assets, economy, collecting, trading,
                      integrations, operations and the shared command layer
src/server/api/       versioned REST routes
src/worker.ts         Astro + EmDash Worker entry
migrations/           D1 schema and transaction guards
mcp/server.mjs        stdio MCP server
scripts/              setup, doctor, sources, CLI, renderer, backup, acceptance
tests/                unit, real workerd/D1/R2 integration, E2E and agent tests
```

UI, REST, CLI and MCP call the same authorised commands. Ownership and money-like accounting are relational in D1. Draws use a conditional single-batch transaction with trigger guards: a draw cannot overspend, double-issue, reroll on retry or run against a stale pool revision. Wallets use an append-only ledger; corrections are compensating entries. The outbox and job queue are durable, retry-safe and processed locally.

EmDash 1.4 is mounted at `/_emdash` on the same local D1/R2. It owns editorial drafts, media, taxonomy and journal entries. The journal is served at `/journal`; the owner editorial desk is at `/admin/editorial`. Editorial publication cannot issue cards or mutate a wallet.

## Agent access

Read `docs/AGENT_GUIDE.md` and `skills/foilbury/SKILL.md`. The OpenAPI document is at `/openapi.json`.

```sh
pnpm foilbury status --json
pnpm foilbury whoami
pnpm foilbury pools show cabinet-draw
pnpm foilbury inventory --as player
pnpm foilbury reward claim --as player
```

The MCP server is stdio-only and uses a scoped local credential. No unauthenticated remote MCP endpoint is provided. An agent acts for its represented member and only within its scopes; it cannot create or expand its own grants.

Development sign-in is explicit, loopback-only and revocable with `FOILBURY_DEV_LOGIN=false`. It is not a production authentication mechanism. There is no universal admin token or production master password.

## Privacy and safety

- Raw libraries and imports are private by default. Public pages use explicit composed exports.
- Uploads are checked for type, size, dimensions and magic bytes; storage access is authorised, not URL-secret.
- Tenant membership and scope are derived from the authenticated principal. A tenant-looking request parameter is not authority.
- CSRF protection applies to cookie-authenticated mutations; agent bearers are independently scoped and revocable.
- Secrets are excluded from browser output, tracked files, CMS content, prompts, logs, backups and generated reports.
- `.env` is not loaded as Worker bindings. `.dev.vars` is generated, allowlisted and mode 600.
- Deployment credentials stay in the owner's private `.env` and are only mapped at an explicit operator boundary; no deployment is performed here.

## Current status

Local implementation and local acceptance are complete; the owner review gate is the stop point. See `docs/LOCAL_ACCEPTANCE.md` for the exact tested revision, commands, results, screenshots, limitations and owner playtest checklist.

External capabilities remain unverified: Discord delivery, email delivery, live FAL/ElevenLabs calls and deployed Cloudflare infrastructure. No Discord bot was installed, no command registered, no endpoint/tunnel opened, no message sent, no DNS changed and no cloud resource created. The Discord handoff is in `docs/DISCORD_HANDOFF.md`.

Foilbury is not affiliated with or endorsed by the source game projects. Source artwork is credited per edition; the owner remains responsible for the content they import and publish.
