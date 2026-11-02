# Foilbury local acceptance

Generated 2026-11-02T09:00:17.903Z from the actual local checkout.

- Local URL: http://127.0.0.1:4321
- Tested revision: 92204c09eb3a520fa2c5fc2e5e14e3ca9b0d7a3e (code clean; 13 evidence-only working-tree entries)
- Node: v22.23.4; pnpm: 10.34.4
- Machine-readable report: `docs/acceptance-report.json`

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| Types and automated tests | passed | `pnpm check` · exit 0 |
| Unit and Workers integration tests | passed | `pnpm test` · exit 0 |
| Browser end-to-end | passed | `pnpm test:e2e` · exit 0 |
| CLI and real MCP client | passed | `pnpm test:agent` · exit 0 |
| Persistence across server restart | passed | `/Users/deanlofts/.local/share/mise/installs/node/22.23.4/bin/node scripts/test-persistence.mjs --json` · exit 0 |
| Doctor (local, read-only) | passed | `/Users/deanlofts/.local/share/mise/installs/node/22.23.4/bin/node scripts/doctor.mjs --json` · exit 0 |
| Source discovery | passed | `/Users/deanlofts/.local/share/mise/installs/node/22.23.4/bin/node scripts/sources/discover.mjs --json` · exit 0 |
| Source preview (idempotent) | passed | `/Users/deanlofts/.local/share/mise/installs/node/22.23.4/bin/node scripts/sources/preview.mjs --json` · exit 0 |
| Local backup | passed | `/Users/deanlofts/.local/share/mise/installs/node/22.23.4/bin/node scripts/backup.mjs --json` · exit 0 |
| Isolated restore | passed | `/Users/deanlofts/.local/share/mise/installs/node/22.23.4/bin/node scripts/restore.mjs --json --backup /Users/deanlofts/gits/card-collector-bot/.foilbury/backups/2026-11-02T085734138Z` · exit 0 |
| Secret scan | passed | `tracked file scan` · exit n/a |
| Runtime provider absence | passed | `read local status and .dev.vars key names` · exit n/a |
| Sibling-checkout independence | passed | `discovery with a missing source root, then public catalogue and media` · exit n/a |
| Fresh setup proof | passed | `throwaway fresh checkout ·pnpm setup:local` · exit n/a |
| External effects audit | passed | `local D1 read-only query` · exit n/a |

## Required demonstrations

| Requirement | Observed evidence |
| --- | --- |
| freshLocalSetupWithoutProviders | throwaway fresh checkout completed setup/import/render/release with no provider keys or bindings |
| realSourceImports | {"cards":16,"editions":19,"variants":80,"backgrounds":4,"commits":{"bubbles":"98608579813a47879815bc8eaee0e0058095e009","fighter":"66e4333f7a0acf8b72ec55eab21a027863368f60","protocol-11":"a3264fa5dc091d6ff4a8ef1e02d4a36dd9ee61b6"}} |
| layeredFinishes | 80 published variants across Plain, Silver, Gold, Diamond and Holo/Prismatic effects; finish studio and exported renders |
| ownerBrowserAdmin | true |
| explicitSharing | true |
| privateMediaAuthorisation | true |
| ownerAgentAdmin | true |
| playerSameInventory | true |
| rewardsAndDrawsPersist | inventory ids, balances, ledger counts and set progress matched across a full server stop/start |
| concurrencyAndIdempotency | workers/draws.test.ts: concurrent draws, replay, stale revision, empty pool |
| tradeGiftRecycle | workers/social.test.ts: reservations, both acceptances, atomic swap, favourite/locked protection, gift history, recycle ledger |
| tenantIsolation | workers/tenancy.test.ts: cross-tenant object references and wallets |
| failuresRecoverable | workers/failures.test.ts: malformed upload, missing asset, job retry/terminal failure, archive with owned instances |
| backupRestore | isolated target .foilbury/restore/2026-11-02T085739332Z; 103 assets checksummed; counts match |
| phoneDesktopKeyboardReducedMotion | ["Keyboard focus: passed","Light presentation: passed","Dark presentation: passed","Mobile landing: passed","Reduced motion: passed"] |
| siblingCheckoutIndependence | missing source root stops discovery while the public catalogue and stored media remain available |
| secretsAbsent | tracked files and browser output scanned |
| noDiscordOrDeployment | no Discord delivery, generation job, deployment or DNS mutation in this run |

## Imported material

- 16 identities, 19 artwork editions, 80 variants, 4 backgrounds.
- Source commits: bubbles 9860857981; fighter 66e4333f7a; protocol-11 a3264fa5dc.

## Screenshots

- `docs/evidence/home-desktop.png`
- `docs/evidence/play-overview.png`
- `docs/evidence/collection.png`
- `docs/evidence/draw-room.png`
- `docs/evidence/draw-result.png`
- `docs/evidence/admin-catalogue.png`
- `docs/evidence/home-light.png`
- `docs/evidence/home-mobile.png`
- `docs/evidence/card-reduced-motion.png`

## External use and cost

- Provider jobs: 0 (none submitted).
- Email sent: 0 (local outbox only).
- Discord deliveries: 0 (disabled).
- Image generation jobs: 0.
- Cloud deployment, DNS mutation and Discord connection: not performed.

## Limitations and stop point

- No live provider verification: FAL, Resend, ElevenLabs and Discord were not contacted.
- No Discord bot installation, command registration, interaction endpoint, tunnel, message or DNS change.
- The domain backup covers Foilbury fb_* tables, triggers and referenced assets. EmDash editorial tables and FTS indexes are excluded because D1 cannot export FTS5 virtual tables; use an EmDash site export for the CMS. This limitation is visible in the backup manifest.
- Generation is implemented behind a budget guard but no billed job was submitted because no ceiling is recorded.
- Owner visual playtest and Kaylee/Dean acceptance are still required; automated evidence cannot replace trying the game.
- The local server binds to loopback. Local proof is not proof of Discord delivery, production auth or deployed infrastructure.

## Owner playtest checklist

1. Open http://127.0.0.1:4321 and confirm the wordmark, hero cards and catalogue read as a premium collector's cabinet on your screen.
2. Sign in as owner and try:
   - claim the daily allowance if available;
   - inspect the draw odds and draw one card (the reveal is skippable);
   - inspect the live layered card and its ownership history;
   - open a trade, gift a duplicate, preview a recycle without confirming unless you mean it.
3. Sign in as player and confirm the same inventory and Foil balance are visible in the browser and via `pnpm foilbury inventory --as player`.
4. Visit Administration and edit a draft, publish a set/pool, adjust the economy in a safe direction, and inspect the audit trail.
5. Try an agent client against `mcp/server.mjs` using the local credentials file and `docs/AGENT_GUIDE.md`.
6. Confirm mobile width, keyboard focus and reduced motion in your browser.
7. Report screenshots, failures and any visual/editorial changes you want before the Discord connection phase.

Review this evidence before authorising Discord. Local acceptance is not proof of Discord delivery or production authentication.
