# Foilbury follow-on acceptance: deployed Discord pilot (historical)

> Historical archive. It is not current release authority. The current
> tree-bound matrix is `docs/release-acceptance.json`, with the readable index
> in `docs/ACCEPTANCE_CURRENT.md`. Rows below describe their recorded revision
> and must not be read as evidence for a later build.

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

| Check                                             | Result                          | Evidence                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint receives Discord's endpoint verification | PASS                            | Discord accepted the endpoint URL. The Worker answers PING with `{type:1}`; signature verification is tested with real Ed25519 keys in `tests/workers/discord.test.ts`.                                                                                                                                                                                |
| First interaction creates one Player              | PASS                            | D1 `fb_discord_identities` has one row for Discord user `707281352818425929`; repeated commands reuse it.                                                                                                                                                                                                                                              |
| `/foilbury daily` entitlement                     | PASS with recorded ack incident | The first live call predated deferred acknowledgement and Discord showed “The application did not respond”, but D1 recorded one 120 Foil claim and ledger entry. A later daily call returned “Allowance not ready … in 20 hours” with no second claim. The reported next-eligible boundary is now the later of the cooldown and the next UTC midnight. |
| `/foilbury open` real gachapon pull               | PASS                            | Live message: **Nora — Plain**, serial `FB-1-DE-705527`, balance 390 ✦. D1: draw `drw_mvz3ly6d8wce39151k2f9se3`, instance `ins_mvz3ly6dwajwem2pe5hb11ge`, owned by `usr_prod_owner`, spend ledger −80.                                                                                                                                                 |
| Card artwork visible in Discord                   | PASS                            | Live **Pippa — Plain** message embeds `attachment://foilbury-card.webp`; Discord reports image `750×1050`, serial `FB-1-DE-513D6B`. Screenshot: `docs/evidence/discord-live-card-attachment.png`.                                                                                                                                                      |
| Persistent collection                             | PASS                            | `/foilbury collection` showed Nora, Rhea and Loftwah copies with the same serials; later profile reported 7 owned cards. D1 inventory rows are `owned`.                                                                                                                                                                                                |
| Interactive button                                | PASS                            | “Open again” produced **Rhea — Silver** (`FB-1-DE-6A448B`), balance 310; the button uses the same idempotent command path.                                                                                                                                                                                                                             |
| `/foilbury packs`                                 | PASS                            | Returned four active pools with prices, eligible counts and revisions (Cabinet, Fighter, Protocol, Late Night).                                                                                                                                                                                                                                        |
| `/foilbury profile`                               | PASS                            | Ephemeral response: Dean, Foilbury Cabinet, 120 ✦, 7 owned cards, daily in 20 hours, Bot-scoped inventory.                                                                                                                                                                                                                                             |
| `/foilbury help`                                  | PASS                            | Lists the implemented commands only; admin caveat is explicit.                                                                                                                                                                                                                                                                                         |
| `/foilbury admin status`                          | PASS                            | Bot Owner response: Loftwah guild, channel allowlist, switches, 16 published cards, 4 active pools, 7 owned cards, 1 member. This is Bot administration, not platform administration.                                                                                                                                                                  |
| Channel restriction                               | PASS                            | `/foilbury daily` in `#chat` returned “Foilbury is not enabled in this channel” and did not create a player or claim.                                                                                                                                                                                                                                  |
| Duplicate/replayed interaction                    | PASS (integration test)         | Same interaction body delivered concurrently yields one draw, one instance and one ledger row. Sequential replay returns the recorded result.                                                                                                                                                                                                          |
| Stale/invalid signature                           | PASS (integration test)         | Invalid Ed25519 signature → HTTP 401; timestamp outside 300 seconds → HTTP 401 before parsing.                                                                                                                                                                                                                                                         |

### Direct D1 correlation

```text
fb_discord_identities: 707281352818425929 -> usr_prod_owner (Dean, owner)
fb_draws:              drw_mvz3ly6d8wce39151k2f9se3 -> ins_mvz3ly6dwajwem2pe5hb11ge
fb_card_instances:     serial FB-1-DE-705527, status owned
fb_ledger_entries:     +350 welcome, +120 daily, -80 draw
```

## Website and infrastructure

| Check                               | Result           | Evidence                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production origin                   | PASS             | `https://foilbury.loftwah.com/` returns 200; custom domain on Worker `foilbury`.                                                                                                                                                                                                                                                                                       |
| Production data                     | PASS             | D1 `foilbury` contains 16 cards, 80 published renders, 4 pools, 7 owned instances and the test installation.                                                                                                                                                                                                                                                           |
| Production media                    | PASS             | 103 R2 objects uploaded to `foilbury-media`; public render URLs return `image/webp` (e.g. 750×1050).                                                                                                                                                                                                                                                                   |
| Production owner login              | PASS             | Password login returns 200 after the PBKDF2 100k Workers fix; admin wallet adjustment returned 200 and wrote a ledger row.                                                                                                                                                                                                                                             |
| Cloudflare Access                   | PASS at the edge | `/admin`, `/admin/catalogue` and `/api/v1/admin/status` return 302 to the Access login; `/`, `/api/v1/status` and the Discord endpoint remain public. Apps: `Foilbury Administration` (`foilbury.loftwah.com/admin`) and `Foilbury Admin API` (`foilbury.loftwah.com/api/v1/admin`); IdP: Cloudflare one-time PIN; policy allows the account owner's Cloudflare email. |
| Access JWT validation in the Worker | PASS             | The Worker verifies signature/JWKS, issuer, audience and expiry on every protected request. A real Access identity is linked to `usr_prod_owner`; forged headers are rejected at the edge. See `docs/AUTH_ACCEPTANCE.md`.                                                                                                                                              |
| Discord endpoint after Access       | PASS             | `/foilbury profile` still worked after Access was enabled.                                                                                                                                                                                                                                                                                                             |

## Testing

```sh
pnpm check          # 0 type errors; 9 unit + 35 Workers tests (44 total)
pnpm exec vitest run --config vitest.workers.config.ts tests/workers/discord.test.ts
pnpm discord:register
pnpm deploy:production
```

The original local acceptance gate was not re-run as a replacement for this evidence. Its recorded local result remains historical; the current follow-on suite is the 44-test result above.

## What remains incomplete

| Area                                                                                       | Status                                      | Why                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Website “Continue with Discord”                                                            | PASS                                        | Real production browser OAuth signed into the production owner and showed the same 7 cards and 120 Foil. Screenshot: `docs/evidence/production-discord-oauth-collection.png`.                                                              |
| Magic links, passkey registration/login, authenticator MFA, recovery codes, session review | PASS locally / human production Access step | Implemented and exercised in Chromium; live Resend accepted delivery. The bootstrap password is retained only as a documented emergency fallback.                                                                                          |
| Administrative strong-authentication policy                                                | PASS                                        | Sensitive mutations require Access, passkey or recent MFA. Platform/editorial Access apps require independent MFA.                                                                                                                         |
| Super Admin bootstrap                                                                      | PASS                                        | `usr_prod_owner` is the sole explicitly provisioned Super Admin; `fb_platform_admins` and the unique partial index enforce it.                                                                                                             |
| Creator self-service Bot creation / second-guild installation                              | PASS local / second guild BLOCKED           | Bot creation, scoped collections, invitations and revocation are implemented and browser-tested. A real second guild requires an authorised installer.                                                                                     |
| Kaylee two-person acceptance / second server                                               | BLOCKED                                     | Requires the real person's consent and an authorised second guild.                                                                                                                                                                         |
| Live `/foilbury card` submission                                                           | NOT VERIFIED live; unit PASS                | Discord's composer did not submit the slash command during automation and posted plain text instead. The handler lookup by display name is covered by a passing Workers test.                                                              |
| Live admin grant confirmation                                                              | NOT VERIFIED live; unit PASS                | The grant command requires the Discord option form; the confirmation, idempotency and audit path are covered by a passing Workers test.                                                                                                    |
| EmDash production editorial flow                                                           | PARTIAL / human console step                | Access protection, branding and `autoProvision:false` are deployed; the existing Dean CMS account is preserved. Native console verification needs the human Access session. The card draft→publish→draw→disable journey is proven locally. |
| Email / Resend delivery                                                                    | PASS                                        | Live Resend accepted a one-use link to `dean@deanlofts.xyz`; local Chromium redeemed it and rejected replay/expiry.                                                                                                                        |
| Paid FAL / ElevenLabs generation                                                           | NOT VERIFIED                                | No billed job was submitted.                                                                                                                                                                                                               |
| AI agent headless parity with Discord                                                      | PARTIAL                                     | Existing scoped REST/CLI/MCP works locally; no live agent run was made against the production Bot.                                                                                                                                         |
| shadcn/ui official skill and `components.json`                                             | PASS                                        | Skill installed, `components.json` created, official components added and mapped to the Foilbury token palette. See `docs/SKILLS.md`.                                                                                                      |
| Cloudflare official skills                                                                 | PASS                                        | `cloudflare-one`, `wrangler`, `workers-best-practices` and `cloudflare-email-service` installed and used.                                                                                                                                  |
| Impeccable                                                                                 | PASS                                        | Context, craft-floor and operate references used; rendered critique, implementation, polish and axe/browser audit completed. Detector clean is not treated as acceptance.                                                                  |
| Playwright                                                                                 | USED                                        | Real Discord browser journeys and screenshots retained in `docs/evidence/`.                                                                                                                                                                |

## Human prerequisites

1. **Cloudflare Access OTP** — open `https://foilbury.loftwah.com/admin` and complete the one-time PIN sent to the account owner's Cloudflare email. This is required for the admin browser journey; the Worker remains closed to unauthenticated admin requests.
2. **Local Discord OAuth callback** — the canonical local origin is now `http://localhost:5173`; the registered callback, dev server, environment and OAuth redirect all match. Production OAuth is preserved. A completed local consent still needs a human Discord session.
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

---

# Guided tour release — 2026-11-03

## Live configuration

- Production Worker `b5a8d35d-7911-4d1e-a7e8-d4d08fd9bb21`; deployed source `f161b6879a3a9d209e1b565c500ebc420659f492`; D1 migration `0013_discord_channel_audience.sql` applied after the recorded backup.
- The existing Foilbury application (`1566702936615026769`), Loftwah guild (`997734945206313041`), `#card-collector-test` (`1566700752385081355`) and installation were retained.
- `/foilbury` command ID `1566755562551779330` was updated with the `tour` option; all existing options were preserved. No global commands, Gateway connection, privileged intents or Administrator permission were added.
- The tour uses the real Danganronpa — Three Killing Games release roster (8 cards, 32 variants, 32 fronts, 32 backs) and the frozen **Three schools** achievement. Public showcase remains the four approved original-IP collections.

## Preflight

`pnpm demo:discord:check` is read-only. Production result:

```text
15 PASS · 0 FAIL · 2 BLOCKED
```

The two blocked checks are channel visibility and a genuine outsider spectator. `#card-collector-test` has no `@everyone` View Channel deny, so it is readable by every guild member. The bot therefore keeps member-only artwork ephemeral there and permits only public original-IP shares. Recording a `members` channel policy without a genuine restriction would be a privacy regression, so it was not done.

## Local evidence

- `pnpm demo`: 28-stage storyboard including Bot Admin, Platform Administration and the native EmDash console (`/_emdash/admin` via EmDash's development-only setup bypass).
- `pnpm demo:album --mode seven --apply` then `--mode complete --apply`: real 1 → 7 → 8 unique Danganronpa cards, **First trial** earned at 7 unique, **Three schools** earned at 8/8 with a one-time 640 Foil reward. No odds were changed and no draw was fabricated.
- `tests/workers/discord.test.ts`: revoked membership, old confirmation after revocation, disabled-game recovery, restricted reveal delivery, public/member channel policy, opt-in share receipt and duplicate-share rejection, and a passive tour that does not draw or spend.
- `tests/workers/achievements.test.ts`: collection-linked achievement visibility and pending-reward recovery after a trade-away.
- `tests/workers/assets.test.ts`: kind-scoped R2 keys for identical bytes.
- `tests/workers/bot-switch.test.ts`: strong-auth timestamp is not refreshed by a Bot switch.

## Live acceptance still BLOCKED

The following require Dean's real Discord client and/or a legitimately controlled second account. They were not simulated, and no screenshots are presented as if they were live:

1. A fresh `/foilbury tour` click-through in `#card-collector-test` on desktop.
2. Actual Discord mobile screenshots.
3. A genuine ordinary spectator account seeing only public shares and not ephemeral responses.
4. Live non-member, wrong-channel, wrong-Bot and removed-member checks in Discord (the same rules pass in Workers tests).
5. A live member-only channel-visible reveal in a channel whose `@everyone` access is denied.

See `docs/DISCORD_TOUR.md` for the exact host script and PASS/FAIL/BLOCKED matrix.

---

# Command-handler acceptance extension — 2026-11-03 evening

Source `8aa4084`; **not deployed**. This section separates the command contract
from the live Discord client.

## Proven without impersonating a Discord user

- `pnpm demo:discord:check` re-ran against production: **15 PASS, 0 FAIL,
  2 BLOCKED** (channel visibility and spectator setup). No draw, grant, spend,
  message or paid provider call.
- `tests/workers/discord.test.ts` (17 tests) now includes a full tour journey:
  welcome → album → free play → open → a real draw → private inspection →
  progress. The draw created one D1 draw and one instance, spent 80 Foil, wrote
  the −80 ledger row, attached `foilbury-card.webp` at 750×1050 and is replay-safe.
- A separate real local draw through the same domain service produced
  **Till — Silver · FB-32-JU-F0C4DD · 80 Foil · 0.40% shown chance**; replaying
  the idempotency key returned the stored receipt (`replayed: true`).
- The local Danganronpa album is 8/8 unique, 18 copies, 10 duplicates, and
  `Three schools` is earned with a 640 Foil reward. This completion is from the
  documented administrator demo-gift flow, **not** a pull; it is labelled as a
  completion demonstration.
- Website parity: `.foilbury/evidence/album-danganronpa-dark.png`,
  `card-monokuma-front-dark.png`, `card-monokuma-back-dark.png`. The card front
  and back are the same published renders Discord attaches.

## Still BLOCKED (human client / spectator / channel policy)

1. Dean runs `/foilbury tour` in the real Discord desktop client in
   `#card-collector-test`, including one charged opening, front/back inspection,
   progress, a public share and the private admin appendix.
2. Dean repeats the tour on the real mobile client and captures mobile layout.
3. A controlled second account verifies that ephemeral tour responses are not
   visible and only the explicit public share is.
4. The test channel has no `@everyone` View Channel deny. Member-only art stays
   ephemeral there. A safe fix is a genuinely private channel with
   `@everyone` View Channel denied, Foilbury added with View Channel, Send
   Messages and Attach Files, and the channel audience recorded in Bot Admin.
   No permission change was made by this task.

The smallest owner action is item 1: open Discord desktop, run the existing
`/foilbury tour`, and record the screen. That one action unblocks the live
command and opening; the spectator item still needs a second controlled account.

---

# Configured-server scope closure — 2026/11/08 (#37)

## Source and deployment

- Source `811f5e7c05cb5b8a87ed4a28e3107eafade1120d`; production Worker
  `71148849-387b-4184-bcf1-118df67c1a6a`.
- `pnpm check`: 46 files, 342 tests, 0 failures.
- The retained 21-stage sequence was not reposted. The NPC chapters received
  explicit scope narration in place; no message ID, start/end link, card,
  serial, ledger row or draw was changed.

## Verified configuration

- Installation `dci_loftwah_test`, guild `997734945206313041`, channel
  `1566700752385081355`, bot `bot_E9696B66F4660241`.
- Channel allowlist: [`1566700752385081355`].
- Verified channel audience: `members`; `@everyone` View Channel is denied.
- Effective Bot-enabled published members collections: **17**
  (Alien Stage, Chainsaw Man, Danganronpa, Death Note, DDLC, NANA, NBA,
  Evangelion, Project Sekai, Madoka, Rick and Morty, Scott Pilgrim, South Park,
  The Simpsons, The Summer Hikaru Died, Total Drama Island, Vocaloid).
- The installation has no explicit collection allowlist; the server inherits
  the Bot-enabled published set. The current scope digest
  `dd827bfce35fde0eca7fd94b0f54bdd0bc599bfa19c5be76501e0d37dfc82fbf`
  matches the digest captured when the demonstration was published, and the
  live capsule preview still reports 36 eligible variants.
- Disabled public collections (Bubbles, Fighter, Protocol 11, Shared Characters)
  do not appear in any retained message.

## Read-back

- `pnpm demo:discord:verify`: **21/21 PASS**, 0 failures. Every stage has the
  expected ID, stage footer, non-ephemeral flag and required image; the start
  links to the conclusion and the conclusion links to every chapter.
- Read-only scope audit (`.foilbury/evidence/demo-scope-audit-2026-11-08.json`):
  **PASS**, 28 card-name occurrences, all filed only in the configured set;
  zero disabled-collection hits; 0 failures.
- Start: https://discord.com/channels/997734945206313041/1566700752385081355/1567443524209872926
- End: https://discord.com/channels/997734945206313041/1566700752385081355/1568794099039998004
- Real signed-in desktop Discord client: stages 19 and 20 display the new
  `Scope` fields, and stage 20 still renders the saved NPC trade image.
  Private capture: `.foilbury/demo-readback/real-client-stage-20-scope-2026-11-08.png`.
- `pnpm demo:discord:check`: **18 PASS · 0 FAIL · 4 BLOCKED**. The blocks are
  command-execution freshness, pin capability, independent spectator and an
  authenticated actor session; they are not scope failures.

## Scope narration

- Stages 1–17 remain the Danganronpa album journey.
- Stage 17 announces the NPC chapter as a deliberate scope change.
- Stage 18 states that NPC holdings span the 17 configured members collections.
- Stage 19 labels `Anakt Garden` as Alien Stage and `Victor Wembanyama` as NBA.
- Stage 20 labels `Anakt Garden` as Alien Stage and `Gonta Gokuhara` as
  Danganronpa.
- Stage 21 repeats the scope and states that every retained card is inside the
  17-collection members set.

## Code boundary

Discord NPC inspection and trading now resolve the verified installation scope.
The tradeable list is filtered with `discordScopeCardIds`, and both sides of an
exchange are checked with `assertCardInDiscordScope` before reservation. The
new regression creates a card filed in a collection outside the installation
allowlist and proves it disappears from the NPC tradeable list even while the
Bot still enables that collection.

## Not claimed

Independent second-account spectator observation and a physical mobile Discord
client remain BLOCKED and are not claimed by this closure.

## Print Room

The Print Room is a retained reply to the existing demo index in
`#card-collector-test`. It gives Homura Akemi's original Plain card and all
four Mitakihara Rain finishes their own buttons. Ryuk's Rain over Kira,
Pochita's After Hours and Mizi's Centre Stage open their published Plain prints.
Gucci Morty opens the unofficial member fan print of Morty Smith.
The NBA Opening Night row opens the Gold prints of Victor Wembanyama, Shai
Gilgeous-Alexander and Nikola Jokić.
The signed Discord card handler serves each saved front, back and version to
the invoking member after checking the current catalogue and channel scope.

Preview the chapter with `pnpm discord:tour:entry --prints --dry-run`. Publish
from the Foilbury checkout with `pnpm discord:tour:entry --prints --publish`.
The publisher uses the existing Foilbury bot and test channel, links back to
the original index as a reply, and reads back the retained message. If a send
is interrupted, it reconciles the recent chapter before attempting any new
send. The local receipt is `.foilbury/discord-print-demo.json`.
