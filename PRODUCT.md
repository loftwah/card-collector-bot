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
- Player cabinet at `/play/cabinet`: owned copies grouped by collection, pinned display, recent pulls, close-to-finish shelves and explicit share/view actions. `/play/collection` is the complete copy list and collection binder; `/play/collections` is discovery.
- Bot administration at `/admin/*`: catalogue, artwork editions, collections, team invitations, sets, pools, economy, availability, imports, render studio and audit.
- Scoped Studio at `/studio`: a normal signed-in workspace for Bot Owners/Admins and Global Collection Admins. It does not require Cloudflare Access and cannot grant platform root. `/studio/prints` reviews distinct artwork editions, records agent or human decisions separately, and links approved prints to catalogue editions. `/studio/art` is the Art Lab: briefs, twelve named card art directions (Atelier, Cinematic, Editorial, Archive, Manga, Minimal, Wedding, Fairy, Gothic, Neon, Broadcast, Street), bounded whole-card AI and composed candidates, real-size comparison, durable feedback, separate approval and publish. `/studio/all-art` is the dense all-art shelf. `/platform-admin/art` is the Super Admin brand-art surface with distinct icon directions, Keeper mascots, wordmarks, OG, banners, shareables and card styles.
- Art Lab candidates carry durable thumbs up/down with an optional comment, on the review wall and in the shared viewer; the saved feedback is readable in the candidate thread. Approved and published candidates cannot be re-rated.
- Cards are layered objects by default: separate scene, subject, material, frame, effect and exact-type layers; borders, finishes and special editions are layer sets. Flat whole-card AI remains a comparison method.
- The art shelf now carries seven distinct AI icon directions (folded F, Keeper owl, card fan, archive drawer, foil seal, signal aperture and the current mark), four Keeper mascot concepts (Wedding, Fairy, Gothic, Neon), twelve named card directions and a dense `/studio/all-art` page. The Tux Plain card was replaced with a reviewed Neon whole-card AI front and AI-designed back and published to production.
- One shared card viewer (`src/components/cards/CardViewer.tsx`) opens any saved card from the Art Lab, Print Studio, platform art, all art, cabinet, collection binder, collection copy list or card detail. It shows saved front/back, style, finish, method, status, dimensions, print code, serial, audience and provenance; the card image is the trigger and Download is separate.
- Platform Administration at `/platform-admin`: accounts, People & roles, Access links, Bots, installations, global collections, explicit Super Admin record and audit.
- Brand kit at `/brand-kit`: the selected **Foil Standard** identity plus the historical Signal Fold, Bastion and Aperture boards. Foil Standard is a monochrome paper/ink system with Geist Serif display, Geist Sans UI, Geist Mono data and one foil-blue signal. The wider Loftwah guild identity is unchanged.
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

### Artwork and catalogue growth

- Start with original or creator-published artwork whose source and use are documented. Prefer credited, permitted hand-made fan art or other human-made work next. Use AI-assisted or generated artwork for considered alternates, missing art and explicit experiments.
- Record the source, creator, rights or permission, generation method, credit, and review state as separate facts. Preserve unknowns when evidence is missing. Show provenance on the card and keep the full source record in Studio.
- Bot admins can opt into AI artwork for the collecting experience. AI artwork starts off for new Bots. Studio can review generated candidates while the Bot excludes them from new draws.
- A collection should have a distinctive cover and visual language, a deep roster, and different print artwork worth owning. Curators should be able to import a large custom roster with a preview of duplicate identities, source gaps and affected editions before publishing.

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
- Card language v2 is production-verified on 96 variants (32 each for Doki Doki Literature Club, Project Sekai and Scott Pilgrim), front and back. The remaining published collections still carry renders from the previous composure; do not claim those old member renders are the new composure. Their rollout waits for the v2 language to clear the owner's bar.
- The Foil Standard identity is selected across the public shell, brand kit and Discord embed palette. The Discord application icon and cover image are applied through the application endpoint; the Loftwah guild icon was not changed and the server banner is blocked by the Boost entitlement. The bot profile banner remains a Developer Portal step. Studio and Platform inherit the new tokens but have not each been re-photographed for a dedicated acceptance record.
- The multi-print proof has eight reviewed original-IP prints and a dedicated pool locally; production publication is the remaining release step. The shared collection/card language now covers every published collection (Slice 3, 2026-11-10), and the profile/share shelf, Discord collection identity and Foil ledger clarity are delivered. A live Discord interaction/spectator acceptance remains open for the current Discord presentation.
- Paid generation is now run for the reviewed original-IP print set only (fal.ai, about US$2.10). ElevenLabs and other billed providers remain intentionally unrun.
- The Art Lab now has named card styles, per-style jobs, style recording on approval and publish, and the shared card viewer across admin and member surfaces. Production `/studio/art` and `/platform-admin/art` were checked at 1440 and 390; the platform brand catalogue loaded and a live favicon selection succeeded. Production has no card briefs or candidates yet, so the live candidate viewer and an owner-selected card publish still need a real production brief. The art expansion and review thumbs release is `1a65fbf` (Worker `a7badb01`). The earlier card viewer/admin release was `00bc703` (Worker `8755e52f`). the Access-gated `/platform-admin/art` brand journey and a real owner-selected card publish still need a fresh human session and a real brief. A real local FAL comparison spent US$0.12: FLUX whole-card produced a poster with gibberish lettering, while the composed method produced a real card with exact type readable at 214×300. A reference-guided GPT Image 2.6 run then produced two finished 5:7 cards with exact copy for US$0.10; a Seedream Edit run produced one clean card and one with malformed small type for US$0.06. The owner still needs to choose and publish a direction. The first OpenAI failure was a stale shell key; the project `.env` key works and the runner now prefers it.
