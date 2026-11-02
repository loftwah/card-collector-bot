# Foilbury — implementation plan and acceptance checklist

Status: local plan preserved; follow-on deployment and Discord evidence are in `docs/DISCORD_ACCEPTANCE.md`. The table below describes the original local build unless a later report supersedes it.

## Product decisions recorded for this build

| Decision | Value |
| --- | --- |
| Product name | Foilbury |
| Production hostname | foilbury.loftwah.com — deployed on Cloudflare Workers |
| Repository | card-collector-bot (unchanged) |
| Local URL | `http://127.0.0.1:4321` (loopback only) |
| Runtime | Astro 7 + React islands on Cloudflare Workers; D1 for relational state; R2 for objects; KV for sessions |
| CMS | EmDash 1.4 mounted locally and migrated in production; production editorial flow not yet verified |
| Auth | Local password sessions for players/owners; production bootstrap password; OAuth/passkey/MFA pending; scoped agent bearer tokens |
| Currency | earned `Foil` only (integer units, no purchase, cash-out or NFT) |
| Primary tenant | `cabinet` (owner-controlled); test tenants `harbour` and `attic` are fixture-only |
| Source policy | curated imports only; raw assets and libraries private by default; composed showcase cards published explicitly |
| Finish model | Plain, Silver, Gold, Diamond materials; None, Holographic, Prismatic effects; variants are explicit combinations |
| Default draw price | 80 Foil for the cabinet pool (editable, versioned) |
| Default reward | 120 Foil daily cabinet allowance, 20 hour cooldown |
| Discord | HTTP interactions live in Loftwah; guild commands registered; privileged intents off; see `docs/DISCORD_ACCEPTANCE.md` |
| Email | local outbox only; no production send verified |
| Generation | provider jobs implemented with budget guard; no billed generation called (no recorded ceiling) |

## Architecture

```
src/
  pages/              Astro public, player and admin shell
  components/         Astro and React UI
  server/             authorised application commands and adapters
    modules/          identity, catalogue, assets, economy, collecting, trading, integrations, operations
    api/              REST route handlers
    db/               migrations and query helpers
  worker.ts           EmDash + Astro worker entrypoint
migrations/           D1 schema (domain tables only; EmDash auto-migrates its own)
scripts/              setup, doctor, sources, CLI, MCP, rendering, backup, acceptance
tests/                unit, workerd integration, HTTP/e2e, CLI/MCP
public/               generated brand, public card exports, OpenAPI
```

All adapters (UI, REST, CLI, MCP) call the same authorised commands in `src/server/modules/`. There is one wallet and one ledger. Rendering is asynchronous through a D1 outbox/jobs table with a local Node runner; no cloud provisioning is required.

## Delivery slices

1. Workspace, typed configuration, loopback-only local runtime, migrations, and owner/player auth.
2. Headless slice: author content, publish, award, draw, read instance via REST, CLI and MCP.
3. Curated real source imports, layered artwork, catalogue workflows, EmDash editorial integration.
4. Brand identity, public site, player/admin UI, trades, gifts, recycling.
5. Concurrency, permissions, persistence, backup/restore, accessibility and visual acceptance.
6. Discord-ready handoff documentation only; no Discord activation.

## Acceptance checklist (evidence required)

- [ ] Fresh setup starts with Discord/email/generation credentials absent and still completes.
- [ ] Real image bytes imported from Bubbles, Fighter and Protocol 11; usable with siblings absent.
- [ ] One base illustration renders Plain, Silver, Gold, Diamond and Holographic examples.
- [ ] Owner admin works in the browser and through a real MCP client.
- [ ] Player browser and headless calls see the same balance and inventory.
- [ ] Rewards/draws persist across reload and process restart.
- [ ] Concurrent draw/reward/retry tests do not overspend, duplicate or reroll.
- [ ] Pool filters, empty pools, stale revisions and set changes behave as documented.
- [ ] Trades/gifts/recycling enforce authority, reservations and atomicity.
- [ ] Two fictional tenants cannot read or mutate each other's private data.
- [ ] Malformed uploads, missing assets, expired grants and job failures are recoverable.
- [ ] Backup/restore into an isolated target recovers inventory, ledger and assets.
- [ ] Phone/desktop, keyboard and reduced-motion journeys inspected.
- [ ] No secrets in browser output, tracked files, reports or public assets.
- [ ] No deployment, DNS, Discord or message delivery occurred.
- [ ] `pnpm check`, `pnpm test:e2e`, `pnpm test:agent`, `pnpm acceptance:local` actually run and are recorded.

A checked box requires a command, result and evidence path. Visual inspection and owner playtest remain separate from automated evidence.

## Build outcome (local)

Implemented and locally verified:

- Astro 7.4.4 / React 19 / Tailwind 4 / EmDash 1.4 on Cloudflare Workers simulation with D1 and R2.
- One owner tenant, two fixture tenants, owner/editor/economy-admin/player capabilities and scoped agent grants.
- Curated source import from Bubbles, Fighter and Protocol 11: 16 identities, 19 artwork editions, 80 variants, 4 backgrounds. Stable shared identities for Loftwah, Pippa and Pepe with separate artwork editions.
- Authored layer system and local renderer: Plain, Silver, Gold, Diamond and Holographic/Prismatic examples; public composed exports, private source assets.
- Earned Foil ledger, daily allowance, set completion, transparent draw odds, atomic draws, recycling, reciprocal trades and separately labelled gifts.
- REST, JSON CLI and real stdio MCP tools over the same command layer; OpenAPI and agent guide.
- EmDash journal integration at `/_emdash` and `/journal`; one real published journal entry created locally.
- Owner browser administration and agent administration; player browser and headless inventory parity.
- Durable jobs/outbox, local render runner, export/backup and verified isolated restore.
- Unit tests, real workerd/D1/R2 integration tests (concurrency, idempotency, tenancy, grants, trades, recycling, failures), Chrome E2E and MCP/CLI tests.

Evidence: `docs/LOCAL_ACCEPTANCE.md`, `docs/acceptance-report.json`, `docs/evidence/`.

Remaining limitations: no live FAL/Resend/ElevenLabs/Discord checks; no deployment or DNS; EmDash editorial tables and FTS indexes are excluded from the domain backup because D1 cannot export FTS5 virtual tables; use EmDash site export; no billed generation because no ceiling is recorded; owner visual playtest still required.
