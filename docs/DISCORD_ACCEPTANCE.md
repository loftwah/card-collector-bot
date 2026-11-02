# Foilbury follow-on acceptance: deployed Discord pilot

Generated from the working tree on 2026-11-02. Follow-on code revision: `ff581de` (Discord OAuth sign-in), building on `80b851d` and `531756f`. Deployed Worker version: `dfb77cf4-8539-4676-971b-9e4017131e4b`. This is the follow-on report; the original local-first acceptance record remains in `docs/LOCAL_ACCEPTANCE.md`.

## Baseline preserved

- Original build revision inspected: `4bd7609` (`chore: record final local acceptance evidence`), clean tree, no worktrees or competing agent.
- Pre-existing checks: `pnpm check` passed (0 errors; 8 unit and 23 Workers tests at baseline).
- The original local build, EmDash mount, catalogue, layered renders, local acceptance evidence and `docs/LOCAL_ACCEPTANCE.md` were retained.
- No App Composer work was added.

## This pass changed

- Added `migrations/0005_discord.sql`: installations, Discord identities, interaction receipts and confirmation records.
- Added the signed HTTP interaction handler in `src/server/discord/` and intercepted `/api/discord/interactions` in `src/worker.ts`.
- Added the full `/foilbury` command contract, card reveal with attached artwork, persistent collection, daily entitlement, channel allowlist, admin status/settings/pools/enable/disable/grant and one-use confirmation buttons.
- Added 12 Workers tests for signatures, stale timestamps, player reuse, draw replay, concurrent duplicate delivery, guild/channel rejection, collection persistence, card lookup, admin denial, admin grant confirmation and deferred follow-ups.
- Fixed production password hashing to stay within Cloudflare Workers' 100,000-iteration PBKDF2 cap.
- Added production deployment, seeding and media-upload scripts; created independent D1, R2 and KV resources and the `foilbury` Worker.
- Added Cloudflare Access applications for `/admin` and `/api/v1/admin` with an allow policy for the account owner's Cloudflare email.
- Added `PRODUCT.md`, `DESIGN.md` and this report.
- Added Discord OAuth account sign-in at `/auth/discord/start` and `/auth/discord/callback`, with state, PKCE, deliberate account linking and session creation.

## Discord application and installation

Verified through the Discord REST API with the existing Foilbury bot credential:

- Application: **Foilbury**, ID `1566702936615026769`; bot user ID is the same snowflake.
- Guild: **Loftwah**, ID `997734945206313041`; bot is in the guild (`GET /users/@me/guilds`).
- Test channel: `#card-collector-test`, ID `1566700752385081355`; belongs to the Loftwah guild.
- Guild install scopes: `bot` and `applications.commands`.
- Privileged Gateway intents: Presence, Server Members and Message Content remain disabled. The implementation uses HTTP interactions, not a Gateway connection.
- Interactions Endpoint URL: `https://foilbury.loftwah.com/api/discord/interactions` (set and accepted by Discord).
- Guild commands: one `/foilbury` command, ID `1566755562551779330`, with options `open`, `daily`, `collection`, `card`, `packs`, `profile`, `help`, `admin`.
- No global commands were registered; no unrelated guild commands existed.
- Discord's portal still reports Public Bot enabled. No Administrator permission was requested.

## Live Discord evidence

All commands below were sent as the authenticated **Loftwah** account in `#card-collector-test`. Discord's message API was used to correlate the displayed message with D1.

| Check | Result | Evidence |
|---|---|---|
| Endpoint receives Discord's endpoint verification | PASS | Discord accepted the endpoint URL. The Worker answers PING with `{type:1}`; signature verification is tested with real Ed25519 keys in `tests/workers/discord.test.ts`. |
| First interaction creates one Player | PASS | D1 `fb_discord_identities` has one row for Discord user `707281352818425929`; repeated commands reuse it. |
| `/foilbury daily` entitlement | PASS with recorded ack incident | The first live call predated deferred acknowledgement and Discord showed “The application did not respond”, but D1 recorded one 120 Foil claim and ledger entry. A later daily call returned “Allowance not ready … in 20 hours” with no second claim. The reported next-eligible boundary is now the later of the cooldown and the next UTC midnight. |
| `/foilbury open` real gachapon pull | PASS | Live message: **Nora — Plain**, serial `FB-1-DE-705527`, balance 390 ✦. D1: draw `drw_mvz3ly6d8wce39151k2f9se3`, instance `ins_mvz3ly6dwajwem2pe5hb11ge`, owned by `usr_prod_owner`, spend ledger −80. |
| Card artwork visible in Discord | PASS | Live **Pippa — Plain** message embeds `attachment://foilbury-card.webp`; Discord reports image `750×1050`, serial `FB-1-DE-513D6B`. Screenshot: `docs/evidence/discord-live-card-attachment.png`. |
| Persistent collection | PASS | `/foilbury collection` showed Nora, Rhea and Loftwah copies with the same serials; later profile reported 7 owned cards. D1 inventory rows are `owned`. |
| Interactive button | PASS | “Open again” produced **Rhea — Silver** (`FB-1-DE-6A448B`), balance 310; the button uses the same idempotent command path. |
| `/foilbury packs` | PASS | Returned four active pools with prices, eligible counts and revisions (Cabinet, Fighter, Protocol, Late Night). |
| `/foilbury profile` | PASS | Ephemeral response: Dean, Foilbury Cabinet, 120 ✦, 7 owned cards, daily in 20 hours, Bot-scoped inventory. |
| `/foilbury help` | PASS | Lists the implemented commands only; admin caveat is explicit. |
| `/foilbury admin status` | PASS | Bot Owner response: Loftwah guild, channel allowlist, switches, 16 published cards, 4 active pools, 7 owned cards, 1 member. This is Bot administration, not platform administration. |
| Channel restriction | PASS | `/foilbury daily` in `#chat` returned “Foilbury is not enabled in this channel” and did not create a player or claim. |
| Duplicate/replayed interaction | PASS (integration test) | Same interaction body delivered concurrently yields one draw, one instance and one ledger row. Sequential replay returns the recorded result. |
| Stale/invalid signature | PASS (integration test) | Invalid Ed25519 signature → HTTP 401; timestamp outside 300 seconds → HTTP 401 before parsing. |

### Direct D1 correlation

```text
fb_discord_identities: 707281352818425929 -> usr_prod_owner (Dean, owner)
fb_draws:              drw_mvz3ly6d8wce39151k2f9se3 -> ins_mvz3ly6dwajwem2pe5hb11ge
fb_card_instances:     serial FB-1-DE-705527, status owned
fb_ledger_entries:     +350 welcome, +120 daily, -80 draw
```

## Website and infrastructure

| Check | Result | Evidence |
|---|---|---|
| Production origin | PASS | `https://foilbury.loftwah.com/` returns 200; custom domain on Worker `foilbury`. |
| Production data | PASS | D1 `foilbury` contains 16 cards, 80 published renders, 4 pools, 7 owned instances and the test installation. |
| Production media | PASS | 103 R2 objects uploaded to `foilbury-media`; public render URLs return `image/webp` (e.g. 750×1050). |
| Production owner login | PASS | Password login returns 200 after the PBKDF2 100k Workers fix; admin wallet adjustment returned 200 and wrote a ledger row. |
| Cloudflare Access | PASS at the edge | `/admin`, `/admin/catalogue` and `/api/v1/admin/status` return 302 to the Access login; `/`, `/api/v1/status` and the Discord endpoint remain public. Apps: `Foilbury Administration` (`foilbury.loftwah.com/admin`) and `Foilbury Admin API` (`foilbury.loftwah.com/api/v1/admin`); IdP: Cloudflare one-time PIN; policy allows the account owner's Cloudflare email. |
| Access JWT validation in the Worker | NOT IMPLEMENTED | The edge enforces Access; the Worker does not independently verify the Access JWT. No alternate hostname or preview URL is enabled. |
| Discord endpoint after Access | PASS | `/foilbury profile` still worked after Access was enabled. |

## Testing

```sh
pnpm check          # 0 type errors; 9 unit + 35 Workers tests (44 total)
pnpm exec vitest run --config vitest.workers.config.ts tests/workers/discord.test.ts
pnpm discord:register
pnpm deploy:production
```

The original local acceptance gate was not re-run as a replacement for this evidence. Its recorded local result remains historical; the current follow-on suite is the 44-test result above.

## What remains incomplete

| Area | Status | Why |
|---|---|---|
| Website “Continue with Discord” | PASS | Real production browser OAuth signed into the production owner and showed the same 7 cards and 120 Foil. Screenshot: `docs/evidence/production-discord-oauth-collection.png`. |
| Magic links, passkey registration/login, authenticator MFA, recovery codes, session review | NOT IMPLEMENTED | The production bootstrap login is password-only. |
| Administrative strong-authentication policy | NOT IMPLEMENTED | Access protects the edge; the app does not enforce recent strong auth for sensitive mutations. |
| Super Admin bootstrap | NOT IMPLEMENTED | The production owner is a Bot Owner with `platform_admin=0`. No Super Admin was provisioned. |
| Creator self-service Bot creation / second-guild installation | NOT IMPLEMENTED | The domain is still effectively single-Bot for this deployment; `cbots`/multi-tenant website flows are absent. |
| Kaylee two-person acceptance / second server | BLOCKED | Requires the real person's consent and an authorised second guild. |
| Live `/foilbury card` submission | NOT VERIFIED live; unit PASS | Discord's composer did not submit the slash command during automation and posted plain text instead. The handler lookup by display name is covered by a passing Workers test. |
| Live admin grant confirmation | NOT VERIFIED live; unit PASS | The grant command requires the Discord option form; the confirmation, idempotency and audit path are covered by a passing Workers test. |
| EmDash production editorial flow | NOT VERIFIED | EmDash migrations are applied in production, but no production CMS owner/site and no create/publish/disable journey were exercised. Local EmDash remains the tested integration. |
| Email / Resend delivery | NOT IMPLEMENTED / NOT VERIFIED | No message was sent. |
| Paid FAL / ElevenLabs generation | NOT VERIFIED | No billed job was submitted. |
| AI agent headless parity with Discord | PARTIAL | Existing scoped REST/CLI/MCP works locally; no live agent run was made against the production Bot. |
| shadcn/ui official skill and `components.json` | NOT USED | The incumbent UI uses hand-built Radix/Tailwind primitives; `components.json` is absent. |
| Cloudflare official skills | NOT INSTALLED | Wrangler and the live API were used directly. |
| Impeccable | LOADED, DETECTOR CLEAN | Context loaded for `src/pages/index.astro`; detector returned no findings for the changed UI files. No live hook was active. |
| Playwright | USED | Real Discord browser journeys and screenshots retained in `docs/evidence/`. |

## Human prerequisites

1. **Cloudflare Access OTP** — open `https://foilbury.loftwah.com/admin` and complete the one-time PIN sent to the account owner's Cloudflare email. This is required for the admin browser journey; the Worker remains closed to unauthenticated admin requests.
2. **Local Discord OAuth callback** — the portal has `http://localhost:5173/auth/discord/callback`, but the local dev server runs at `http://127.0.0.1:4321`. Production OAuth is verified. For local OAuth, either add `http://127.0.0.1:4321/auth/discord/callback` in Discord or run the dev server on port 5173 and set the local origin/redirect consistently.
3. **Super Admin** — explicitly confirm the immutable Discord/account identity to receive platform-wide authority. The current pilot intentionally does not infer it from guild ownership.
4. **Kaylee / second guild** — obtain her consent and an authorised second server before running the two-person acceptance matrix.
5. **EmDash production** — configure the production CMS owner/site if editorial publishing must be proven in this deployment.

## Verdicts

- **Local core:** PASS for the original local gate and the follow-on 42-test suite.
- **Deployed pilot:** PASS for the real Discord loop (player creation, pull, reveal, persistent collection, buttons, channel restriction, Bot Owner status) and public production site; PARTIAL for admin because Access OTP and the missing website auth flows are human/implementation gaps.
- **Two-person acceptance:** BLOCKED.
- **Public launch:** NOT READY (auth, multi-tenant creator flows, moderation/age review, email and provider verification remain).

## Evidence

- `docs/evidence/discord-live-card-attachment.png` — real Discord card reveal with artwork.
- `docs/evidence/discord-live-draw.png` — first real pull and channel context.
- `.foilbury/production-owner.json` — production bootstrap login (ignored, mode 600; never commit).
- `.foilbury/production-seed.sql` — reproducible catalogue/installation seed (ignored).
- Remote D1 queries in this report.
