# Foilbury pass handoff — identity, administration, collections and design

Date: 2026-11-02. Production Worker: `e188ea0e-e73c-4c37-a62b-b5134cc2abc3`. Repository: working tree based on `0077fb3`. Tests: **64 passing** (19 unit + 45 Workers), plus real Chromium journeys.

## What was preserved

- Production D1 database, R2 media bucket, KV sessions, Worker `foilbury`, custom domain `foilbury.loftwah.com`.
- Discord application `1566702936615026769`, guild `997734945206313041`, channel `1566700752385081355`, bot identity, HTTP interactions endpoint, no privileged intents, no Administrator permission.
- `usr_prod_owner` internal ID, Discord link `707281352818425929`, all card serials, ownership history, wallet and ledger rows.
- Existing EmDash 1.4 database and the existing Dean CMS account (`dean@deanlofts.xyz`, role 50, passkey credential retained).
- Existing artwork, mascot, banner, layered card renderer, game rules and Discord command contract.

## What changed

- Added identity/auth schema: Access email allowlist and identity links, magic links, WebAuthn credentials/challenges, encrypted TOTP secrets, recovery codes, session assurance/method metadata.
- Added access JWT verification and administrative session establishment in the Worker.
- Added passwordless sign-in UI, account security, passkey/TOTP/recovery/session APIs.
- Added Bot creation, scoped Bot Admin invitations/revocation, capability checks and Bot switching.
- Added global/Bot collections with logos, descriptions, card membership and per-Bot enable/disable; D1 guards future drops from disabled collections.
- Added card `bio`, `quote` and card-back view; populated the 16 curated identities with editorial copy.
- Added artwork edition creation, asset upload, render queue and pool workflow for creators.
- Added Platform Administration for accounts, Access links, Bots, installations, global collections, Super Admin record and audit.
- Integrated shadcn/ui and Geist Sans/Serif/Mono; redesigned sign-in, player home, collection, card detail/back, Bot admin, collections, team, Platform Administration and account security.
- Added docs: `docs/AUTH_ACCEPTANCE.md`, `docs/COLLECTIONS.md`, `docs/SKILLS.md`, `docs/PASS_HANDOFF.md`; updated `PRODUCT.md`, `DESIGN.md`, `README.md`, `docs/AGENT_GUIDE.md`, `AGENTS.md`.

## Identity mapping

| Field | Before | After |
|---|---|---|
| Account | `usr_prod_owner` | `usr_prod_owner` |
| Email | `owner@foilbury.loftwah.com` | `dean@deanlofts.xyz` |
| Display name | Dean | Dean |
| Discord | `707281352818425929` | same |
| Access | none | `fb_access_identities` linked to subject `cc245d5e-fe7f-58c3-aa0b-3dc7efcca6cc`, verified `2026-11-02T12:21:41Z` |
| Platform role | none | sole active Super Admin |
| Cards | 7 owned at baseline | 8 owned, including one real Discord draw at 11:37Z, all prior serials preserved |
| Balance | 120 at baseline | 40, after the recorded 80 Foil draw |
| Ledger | 10 rows at baseline | 11 rows, the new row is the draw spend |
| Global collections | none in the new model | Bubbles, Fighter, Protocol 11, Shared Characters; 16 card memberships |

## Collection answers

- **Yes, a collection is a real product object**, not just a category string. It has a name, slug, description, logo, status and explicit card membership.
- **Global collections** are managed by the Super Admin and visible to every Bot. A Bot can turn them on or off; it cannot edit them.
- **Bot collections** are managed by the Bot Owner or a Bot Admin with content capability. They are private to that Bot, and that Bot also sees the global collections.
- A disabled collection prevents future drops of its cards for that Bot. Existing owned copies, serials and ledger history remain.
- Conversation with Dean: `Protocol 11`, `Fighter`, `Bubbles` and `Shared Characters` now have real logo marks (`/art/collections/*.svg`), descriptions and collection membership.
- Card detail has bio, quote, provenance and a real card back. The web can flip the card; Discord receives the published single-image front render. Layering remains background → subject → material → frame → effect → text.

## Required answers

1. **Can Dean enter administration with his Cloudflare account alone, without a routine Foilbury password?**
   Yes in the implemented journey: `/platform-admin` is Cloudflare-IdP only with independent Access MFA; `/admin` accepts Dean's Cloudflare account. The Worker validates the JWT and resolves `usr_prod_owner`; no Foilbury password form is involved. A real Access identity link exists in production. A fresh human MFA screenshot remains the one human step.

2. **Does the account show Dean's verified real email?**
   Yes: `dean@deanlofts.xyz`, `email_verified_at=2026-11-02T11:30:45.170Z`. The bootstrap email is gone from the account display and login identity.

3. **Can Discord and magic-link sign-in resolve the intended account safely?**
   Yes. Discord identity → the same `usr_prod_owner`. Magic links are 15-minute, single-use, hashed, rate-limited, enumeration-safe, and redeemed only on a confirmation POST. A valid email creates/uses the verified email account, not a duplicate.

4. **Did all existing cards, balances and ownership survive?**
   Yes. All seven earlier serials and ledger rows remain. The only change is one real Discord draw after the baseline (8 owned / 40 Foil / 11 ledger rows), documented above.

5. **Is Dean the sole explicitly provisioned Super Admin?**
   Yes. `fb_platform_admins` has one active row (`usr_prod_owner`); the unique partial index on `fb_users.platform_admin=1` prevents a second. Access membership and Discord guild ownership create no role.

6. **Can another person become an Admin only of their own/assigned Bot?**
   Yes locally. An independent magic-link creator adds a passkey, creates a Bot, and sees only that Bot. Invitations are expiring, single-use, bound to the invitee email, capability-scoped, and revocable. Platform Administration is denied.

7. **Does card editing through EmDash affect the actual playable catalogue?**
   The source of truth is deliberately split: Foilbury owns structured cards/artwork/pools/awards; EmDash owns journal content/media. Card draft→artwork→publish→pool→draw→disable is proven in `scripts/test-editorial-e2e.mjs`. A native EmDash card editor was **not** added because maintaining two editable card catalogues would be unsafe. The EmDash operator console is Access-protected and Dean's existing account is preserved; human console verification is the remaining step.

8. **Are the separate administration areas and sign-in behaviours understandable?**
   Yes: `/admin` is labelled **Bot administration** with Bot Owner/Bot Admin; `/platform-admin` is **Platform Administration** with Super Admin; `/_emdash` is **EmDash editorial operator**; `/account/security` is personal security; `/login` prioritises Discord, email magic link and passkey, with administration clearly separated.

9. **Were the required skills used, not merely installed?**
   Yes. See `docs/SKILLS.md`: Impeccable context/craft-floor/operate + rendered critique and detector; shadcn CLI/info/components/tokens; Cloudflare One/Wrangler/Workers/Email; EmDash site/plugin/CLI; Playwright real Chromium. Each names the implementation or evidence it produced.

10. **Are the rendered interfaces polished, legible and usable?**
    The public home, sign-in, player home, collection, card detail/back, Bot admin, collections, team, Platform Administration and account security were inspected in Chromium. `docs/evidence/ui-a11y.json` records zero serious/critical axe findings across light/dark, desktop/mobile, reduced motion and 200% zoom-equivalent checks. Screenshots: `docs/evidence/ui-*.png`.

11. **What still requires genuine human verification?**
    - Dean's fresh Cloudflare Access MFA prompt and an authenticated Platform Administration/editorial screenshot (identity already linked in production).
    - A completed local Discord OAuth consent at `http://localhost:5173` (production callback preserved).
    - EmDash's native operator console with the existing Dean CMS account.
    - A second real Discord guild and a second human creator/Kaylee acceptance matrix; do not act as Kaylee without consent.
    - A fully human inbox click for the live Resend link (delivery accepted and local redemption tested).

## Evidence

- `docs/AUTH_ACCEPTANCE.md` — identity, Access policies, migration, test matrix.
- `docs/COLLECTIONS.md` — global/Bot collection semantics.
- `docs/SKILLS.md` — skill provenance and actual use.
- `docs/evidence/auth-browser.json` — passkey, TOTP, recovery, session, magic-link E2E.
- `docs/evidence/creator-browser.json` — independent creator E2E.
- `docs/evidence/editorial-browser.json` — draft→artwork→publish→pool→draw→disable E2E.
- `docs/evidence/ui-a11y.json` — axe/contrast/overflow/zoom/reduced-motion results.
- `docs/evidence/ui-*.png`, `account-security.png`, `creator-collections.png`, `editorial-proof-card.png` — rendered after evidence.
- `docs/evidence/production-*` from the original Discord/OAuth pass remains valid for the preserved production OAuth/inventory journey.

## Commands run

```sh
pnpm check                    # 64 passing tests
pnpm build
pnpm deploy:production        # Worker e188ea0e-e73c-4c37-a62b-b5134cc2abc3
node scripts/backup-d1-json.mjs .foilbury/backups/prod-pre-auth-2026-11-02.json
node scripts/provision-owner.mjs --apply --email dean@deanlofts.xyz
node scripts/test-auth-e2e.mjs
node scripts/test-creator-e2e.mjs
node scripts/test-editorial-e2e.mjs
node scripts/test-ui-a11y.mjs
```

---

# Album increment handoff — 2026-11-03

## Revisions

- Source revision: `main@d98b825` (base `main@5f71454`).
- Production migration: `0008_album_visibility_achievements_gifts.sql` and
  `0009_existing_showcase_review.sql`.
- Production Worker: `099b878f-1f79-4132-ac7c-b1c15e8ae77c` (plus later
  docs/script-only changes).
- Production catalogue release: `3`.
- Public origin: `https://foilbury.loftwah.com`.
- D1 backup before the change: `.foilbury/backups/prod-pre-album-2026-11-03.json`
  (74 tables, 669 rows, SHA-256 recorded). This file is private/gitignored.

## Data invariants

Before → after (production):

| Invariant | Before | After |
|---|---:|---:|
| Accounts | 1 | 1 |
| Owned instances | 8 | 8 |
| Ledger rows | 11 | 14 (three achievement reward credits) |
| Wallet total | 40 | 600 (three intended achievement rewards) |
| Memberships | 1 | 1 |
| Existing collections | 4 | 4 (plus 17 launch collections) |
| Existing published renders | 80 | 80 (preserved; 560 launch renders added) |

`usr_prod_owner`, Dean's email/Discord/Access links, roles, existing serials,
inventory, ledger history and the Discord application are unchanged. Achievement
rewards are new issue rows; no old ledger row was edited.

## Delivered

- Explicit public/members/private viewing audience, independent of global,
  published and distribution switches.
- Main-album membership onboarding via magic link/Discord; revocation revokes
  sessions and denies catalogue/media.
- Public showcase remains Bubbles/Fighter/Protocol 11/Shared only. NBA + 16
  properties are members-only.
- Media authorisation on every render/back/derivative/source request; legacy
  `/media/public` re-checks. Public cache; member/private no-store.
- 17 launch collections, 140 cards, complete profiles, attributes, source
  boundaries and provenance; private manifests imported through the validated
  API.
- Four core finishes on every launch card, designed backs, 750×1050 delivery,
  300×420/600×840 derivatives, contact sheets.
- On-demand CSS 3D inspector with keyboard/touch, reduced-motion and flat
  fallback; no canvas per grid tile.
- Achievements: 11 platform + 34 collection definitions; versioned criteria,
  idempotent unlocks, separated reward/notification, backfill.
- Generous main-album economy (800 welcome / 480 daily / 80 opening; 45/30/18/7
  finish weights) and scoped gifts (Foil/Opening/Card) with preview, limits,
  receipts and idempotency.
- Real Admin UI journey for collection, logo/cover upload, card identity,
  biography/attributes, four finishes, publish, render, achievement and gift.
- Public-only SEO sitemap/robots, JSON-LD and privacy tests.
- New docs: PRIVACY_MODEL, ACHIEVEMENTS, ECONOMY_GIFTS, MEDIA, CONTENT_SCHEMA,
  CONTENT_COVERAGE, DESIGN_REVIEW, STATE_MACHINES, SEO.

## Verification

- `pnpm check`: 24 unit + 57 Workers tests = **81 passing**.
- `node scripts/test-album-e2e.mjs`: **13/13 PASS** — real Admin UI + member
  draw/inspect/3D/achievement/gift/retire journey.
- `node scripts/test-privacy.mjs`: **9/9 PASS** — anonymous/member/public media,
  API, HTML, sitemap, global reuse.
- `node scripts/test-seo.mjs`: **6/6 PASS**.
- `node scripts/test-ui-a11y.mjs`: **30/30 PASS** — axe/contrast/overflow/zoom/
  reduced motion across public/member/admin.
- `node scripts/test-deployed.mjs`: production smoke PASS.
- Production counts after import: 21 collections, 156 cards, 640 variants,
  640 published renders, 560 launch backs, 1,280 responsive derivatives, 45 active
  achievement definitions, 21 active pools.

## 2026-11-03 corrective art pass

### Baseline preserved

Before this pass the production D1 held 2 users, 2 active memberships, 10 card
instances (10 owned), 19 ledger rows, 2 wallets with a total balance of 1,880
Foil, 21 collections, 156 cards, 159 editions, 640 variants, 640 published
renders, 45 active achievement definitions and 21 active pools. Catalogue
release was version 3. The only duplicate editions were the pre-existing public
showcase cards `loftwah`, `pepe` and `pippa`.

A logical D1 JSON backup was written before mutation:
`.foilbury/backups/prod-pre-art-2026-11-03.json` (85 tables, 22,456 rows,
SHA-256 `08ea0ebe8927a02547a5ac9a1705066bc4c762e1df1ed30773506281c537cb31`).

### Artwork and correctness changes

- Sourced subject images for **140/140 launch cards** from the property wiki or
  Wikimedia Commons. The old oversized initials/monograms are no longer used.
  Provenance records the page, file, image URL, retrieval time, licence metadata,
  artist where published, and credit.
- Total Drama uses season-one 2007 stills, not the 2023 reboot. The Simpsons uses
  clean character renders. Rin and Len use separate voicebank renders. Context
  cards use scenes/posters rather than a duplicate character.
- The back layout now wraps/shrinks the title, reserves a fixed lower section,
  and truncates the biography with an ellipsis instead of overlapping attributes.
  Credit is printed on the back in small type.
- The importer now revises the current artwork edition **in place** and keeps
  edition/variant IDs stable, so owned serials and the ledger continue to point
  at the same collectible. The previous "new edition on every revision" path
  created duplicates.
- `migrations/0010_render_source_hash.sql` binds each render to the edition
  source hash. A changed source hash invalidates the old render without forcing
  the whole catalogue.
- Achievement rewards now reconcile against the ledger idempotency key and retry
  pending/failed rewards on every evaluation/backfill. Backfill is paginated with
  `next_offset`/`done` instead of reprocessing the first page.
- `CardInspector` applies the selected face in flat, interactive, offscreen and
  reduced-motion modes. Reduced motion removes tilt, not the back.

### Verification

- `pnpm check`: **82 tests passing** (24 unit + 58 Workers).
- `node scripts/test-album-e2e.mjs`: **13/13 PASS**, including rendered front/back
  screenshot comparison, mode switching while the back is selected, reduced
  motion, accessibility-tree agreement and owned-copy survival after retirement.
- `node scripts/test-privacy.mjs`: **9/9 PASS**.
- `node scripts/test-seo.mjs`: **6/6 PASS**.
- `node scripts/test-ui-a11y.mjs`: **30/30 PASS**.
- Local launch catalogue: 140 cards, 560 variants, 560 renders whose source hash
  matches the current edition, 0 placeholder subjects, 0 duplicate launch
  editions, 140/140 sourced credits.
- Final local contact sheet: `.foilbury/evidence/launch-art-contact-sheet.jpg`
  (private, gitignored).

### Production delivery

- D1 migrations `0010_render_source_hash.sql`, `0011_achievement_roster_snapshots.sql`
  and `0012_achievement_roster_snapshots_unique.sql` applied after the backup.
- Worker: `17e140dc-9652-43cb-9d13-abbdcff9c396` (final; the content import ran on
  the preceding `f7d76d03-55ad-417a-9618-8f2ca0d45041` and the final deploy added
  the roster-aware achievement evaluation).
- Content import: 640 render jobs, **640 rendered / 0 failed**; catalogue release
  **4**.
- Production counts: 21 collections, 156 cards, 159 editions (the 3 pre-existing
  public-showcase duplicates remain), 640 variants, 640 published renders, 45
  active achievements, 21 active pools.
- Launch coverage: **560/560** variants have a render bound to the current
  edition source hash; **0** placeholder subjects; **0** duplicate launch
  editions; **140/140** sourced credits.
- Ledger/inventory baseline preserved: 10 instances (10 owned), 19 ledger rows,
  1,880 Foil total, unchanged by the corrective import.
- Temporary production agent grant and Access service token were revoked/removed
  after the import. Administration is back to the human Access path.
- Guild command `/foilbury` re-registered with the `achievements` option; the
  existing command ID and unrelated commands were preserved.

## Honest remaining gaps

- The sourced subject images are **third-party works**, not licensed or official
  Foilbury artwork. They are used in a private, non-commercial member album with
  provenance and credit; permission review remains a separate open item.
- Human contact-sheet review on calibrated displays and constrained mobile
  hardware remains a release step. The agent reviewed all 17 collections and
  corrected specific bad sources, but that is not Dean's final creative approval.
- Live Discord registration and a real member front/back/details journey still
  need a deployed interaction session; the HTTP paths are implemented and
  locally tested.
- Dean's fresh Access MFA screenshot, the EmDash native console and a second
  human guild/creator matrix remain human steps from the previous pass.
- Public-to-private cache recall is not possible for already-downloaded copies;
  the documented policy is not to publish restricted content publicly.
