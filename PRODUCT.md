# Foilbury product truth

Foilbury is a collectible-card cabinet. A player claims a free allowance, opens a capsule pool, receives a card copy, and keeps that copy in a Bot-scoped inventory. The website, Discord slash commands, REST API, CLI and MCP server all call the same domain services and the same D1 award ledger.

## Actors

- **Account** — one persistent Foilbury identity, resolved by Discord, a one-use email link, a passkey, or a verified Cloudflare Access identity for administration.
- **User** — an ordinary player. A verified Discord interaction creates a lightweight player without a website registration step.
- **Bot Owner** — the account that owns a Foilbury Bot. This is not platform administration.
- **Bot Admin** — an account explicitly authorised for a named Bot, with a capability set, expiring invitation and revocation path.
- **Global Collection Admin** — an audited, scoped platform role for shared collection curation. It is not platform root and cannot approve public showcase content.
- **Super Admin** — platform-wide authority. Only the explicitly provisioned Dean account has it; it is not inferred from guild ownership, email suffix, first sign-up or Cloudflare membership.
- **Installation** — a server-to-Bot binding. A guild is resolved on the server; a tenant or guild ID in an interaction payload is not authority.

## Current product surface

- Public showcase landing page and catalogue for approved Loftwah-owned project content only.
- Explicit viewing audiences: public showcase, members, private. Global, published and public are separate dimensions.
- Member album with collection browsing, front/back and on-demand 3D card inspection.
- Versioned achievements shared by web, Discord and the reward ledger.
- Generous free-play defaults (800 welcome / 480 daily), truthful finish odds and scoped administrator gifts.
- Passwordless player sign-in: Discord OAuth, one-use email magic links, passkeys; authenticator TOTP and recovery codes for step-up.
- Account security: passkeys, authenticator, recovery codes, session review and revocation.
- Player cabinet: collection filtered by collection and set, draw studio, rewards, trades, preferences, collector showcase and share links.
- Bot administration at `/admin/*`: catalogue, artwork editions, collections, team invitations, sets, pools, economy, availability, imports, render studio and audit.
- Scoped Studio at `/studio`: a normal signed-in workspace for Bot Owners/Admins and Global Collection Admins. It does not require Cloudflare Access and cannot grant platform root. `/studio/prints` reviews distinct artwork editions, records agent or human decisions separately, and links approved prints to catalogue editions.
- Platform Administration at `/platform-admin`: accounts, People & roles, Access links, Bots, installations, global collections, explicit Super Admin record and audit.
- Brand kit at `/brand-kit`: three complete identity systems plus the legacy marks. Signal Fold is selected and applied to the Foilbury application under delegated authority; Bastion and Aperture remain available. The wider Loftwah guild identity is unchanged.
- Website tour at `/tour`: public-safe, skippable and resumable, with a member continuation and a private operator appendix.
- Showcase at `/showcase`: real public stills and playable MP4 exports with an export manifest and audience label.
- Discord HTTP interactions at `/api/discord/interactions`: `/foilbury open`, `daily`, `collection`, `card`, `packs`, `achievements`, `tour`, `profile`, `help` and guarded `admin` subcommands. The guided tour is private by default and shares only after explicit audience checks.
- Headless REST API, CLI and stdio MCP server using scoped agent grants.
- EmDash is the editorial CMS for journal drafts and media; Foilbury remains the source of truth for card identity, artwork editions, categories, tags, pools, awards and inventory.

## Collections

- **Global collection** — curated by the Super Admin or a scoped Global Collection Admin, reusable by every Bot, enabled or disabled per Bot. The Bot reads it; it does not edit or clone it.
- **Bot collection** — private to one Bot, managed by its Bot Owner or a Bot Admin with content capability.
- `view_audience` is independent of scope and status: **public** (approved showcase), **members** (active album/Bot membership) or **private** (owner scope plus explicit viewers).
- New collections default to members-only. Only the Super Admin can approve public showcase material or promote a collection to public.
- A card inherits the most restrictive audience of every collection it belongs to.
- Disabling a collection prevents its cards from dropping in that Bot without deleting or changing already-owned copies or their access records.

## Trust boundaries

- Bot A permissions do not grant Bot B authority.
- Discord server moderator status is not Foilbury platform authority.
- Cloudflare Access admission is an authentication boundary, not a Foilbury role. The Worker validates the Access JWT signature, issuer, audience and expiry on every administrative request.
- Inventory, quotas and awards are authoritative in D1. Editorial/CMS publication cannot mint cards or mutate a wallet.
- Every draw is one D1 batch: entitlement debit, selected outcome, inventory insert, ledger row and idempotency receipt.
- Interaction retries use the interaction ID as an idempotency key. A replayed interaction returns the recorded outcome and cannot re-roll or double-award.
- Private media is authorised by ownership or membership, not by a secret URL.

## Content and economy

- 17 launch collections are delivered as private manifests and imported through the validated pipeline: NBA (12) plus 16 properties (8 each). See `docs/CONTENT_COVERAGE.md`.
- The launch catalogue is members-only. Approved Loftwah originals remain the public showcase.
- Achievements: 11 platform definitions plus collection milestones and a versioned mastery catalogue (first card, all Plain/Silver/Gold/Holographic per collection, core mastery, roster progress), frozen criteria, idempotent unlocks and separated reward/notification delivery.
- Gifts: Foil, opening and card, scoped to the Bot, capped by role, previewed and idempotent.
- No paid generation was run. Franchise cards use publicly published reference images with recorded provenance; the card design and finishes remain Foilbury originals. They are third-party images in a private, non-commercial member album, not official or licensed artwork.

## Known gaps

- Dean's administration uses his existing Cloudflare-account sign-in. A fresh human Access session and a complete authenticated Production Administration journey still need to be recorded (see `docs/AUTH_ACCEPTANCE.md`).
- The production EmDash operator console is protected by Access and configured for the existing Dean account; a human authenticated editorial session is still required to exercise the native console.
- A real second Discord guild installation and a second-person acceptance matrix require an authorised human participant. The channel visibility and spectator items remain BLOCKED in the preflight.
- Production member card renders for the pre-existing 560 variants were generated with the previous composure; a bounded re-render/publication plan is prepared. Do not claim those old member renders are the new composure.
- The Signal Fold identity is selected and applied to the Foilbury application; the Loftwah guild icon was not changed and the server banner is blocked by the Boost entitlement. The bot profile banner remains a Developer Portal step.
- The multi-print proof has eight reviewed original-IP prints and a dedicated pool locally; production publication is the remaining release step. The wider collection-by-collection rollout is not complete.
- Paid generation is now run for the reviewed original-IP print set only (fal.ai, about US$2.10). ElevenLabs and other billed providers remain intentionally unrun.

