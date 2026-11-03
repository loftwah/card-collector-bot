# Foilbury integrated acceptance — 2026/11/03

Source SHA and deployment are recorded at the end. Status vocabulary: **PASS**,
**PARTIAL**, **BLOCKED**, **NOT IMPLEMENTED**. A clean unit test is not a visual
or live-client pass.

## 1. Current-state reconciliation

| Claim | Status | Evidence |
|---|---|---|
| Owner sign-in correction was run and PR #5 merged | PASS | `main` contains `f161b68`; PR #5 merged; Access read-back still shows the five apps and inherited MFA. |
| Deployed Worker was `b5a8d35d…` | VERIFIED TRUE for the previous release | `wrangler deployments list` history; docs commit `51b6a0d`. |
| Old final-issue note source `d98b825` / Worker `099b878f…` | STALE | It is a historical note. The current deployment was checked directly. |
| `docs/DISCORD_TOUR.md` preflight 15 PASS / 2 BLOCKED | PASS | `pnpm demo:discord:check` re-ran with the same result. |
| Kaylee is a full Super Admin | FALSE | Production `platform_admin=0`, no `fb_platform_admins` row. |
| Kaylee is an ordinary User with no scoped role | STALE | A scoped Global Collection Admin row is now active (production, `2026/11/03 17:59 Melbourne`). |
| EmDash and Foilbury have one clear boundary | PASS | `docs/EMDASH_BOUNDARY.md`; no second card editor or second journal editor. |
| Public/member card fronts include the collection emblem in production | PARTIAL | New renderer proved locally; existing production renders were not rewritten. See section 8. |

## 2. Roles and permissions

| Requirement | Status | Evidence |
|---|---|---|
| Super Admin explicitly provisioned, one active row | PASS | Production read-back: 1 active Super Admin, `usr_prod_owner`. |
| Global Collection Admin is scoped and not root | PASS | `fb_platform_role_assignments`; API rejects public approval and out-of-scope collections; `tests/workers/roles.test.ts`. |
| Kaylee can manage shared collections without root | PASS (provisioned) | Production grant `role_kaylee_mvzm5yiky28tmcyedbg20wdx`, `all:true`, audited. Local visual review at `/studio` and `/studio/collections` shows one scoped world and no platform root. |
| Kaylee can own/manage her own Bot | PARTIAL — requires her passkey | The Worker now accepts a verified Discord link as identity proof and still requires a passkey/authenticator for a protected account. A human passkey enrolment is the remaining step. |
| People search/filter, scopes, grant/revoke, pending invites | PASS | `/platform-admin/people`; `PlatformPeople.tsx`; `GET /api/v1/platform/people`, `POST /api/v1/platform/roles`, `POST /api/v1/platform/roles/:id/revoke`. |
| Idempotent grant/revoke and audit | PASS | `assignPlatformRole` returns `changed:false` for the same scope; `revokePlatformRole` is idempotent; audit rows. |
| Same checks on website, API, MCP, background jobs | PASS (worker/API); PARTIAL (MCP) | `/api/v1/studio/*` aliases the same domain routes; `mcp/server.mjs` adds scoped collection/share tools. MCP has no platform-role grant tool by design. |
| No public approval from a scoped admin | PASS | `requireSuperAdminContent` remains on `view_audience=public`; test. |
| No hidden UI-only capability | PASS | The Studio UI and `/api/v1/studio/*` share `requireGlobalCollectionManager`; scoped collection list uses the same scope. |

## 3. EmDash versus Foilbury

| Requirement | Status | Evidence |
|---|---|---|
| One editable card catalogue | PASS | Foilbury owns cards/editions/variants; EmDash has no card editor. |
| One journal/CMS | PASS | EmDash owns journal; Foilbury has a read-only handoff at `/admin/editorial`. |
| Clear boundary documented | PASS | `docs/EMDASH_BOUNDARY.md`; `PRODUCT.md`; `README.md`; Studio copy. |
| Useful direct links | PASS | `/admin/editorial`, `/_emdash/admin`, `/journal`; Studio editorial link. |
| Native EmDash console human proof | BLOCKED | Requires Dean's Cloudflare Access session; no agent impersonation. |

## 4. Admin, demo and tours

| Requirement | Status | Evidence |
|---|---|---|
| Platform Admin, Bot Admin, native EmDash, demo personas | PASS (local) / BLOCKED (live native console) | `pnpm demo` 33 stages; `/platform-admin/people`; `/studio`; EmDash local dev bypass. |
| Website tour, returning path, skippable/resumable | PASS | `/tour` with six steps, signed-in continuation and private operator appendix. |
| Discord guided tour | PASS (preflight/registered); BLOCKED (human client/spectator) | `/foilbury tour`; `docs/DISCORD_TOUR.md`; preflight 15 PASS / 2 BLOCKED. |
| Spectator proof, actual desktop/mobile Discord | BLOCKED | Requires Dean's client and a controlled second account. |
| Channel audience check | BLOCKED for member channel-visible art | Test channel has no `@everyone` deny; restricted art stays ephemeral. |
| Safe local demo fixtures | PASS | `.foilbury` fixtures, demo album reset, no production seeding. |
| Owner fresh Access session | BLOCKED | Human consent/MFA; Access configuration is already correct. |

## 5. Experience and collection identity

| Requirement | Status | Evidence |
|---|---|---|
| Distinct Foilbury palette and design system | PASS | `DESIGN.md`; Signal palette; `docs/evidence/signal-*.png`. |
| Collection mark on card front and back | PASS locally / PARTIAL production | Front renderer now embeds the collection mark; local Danganronpa and public assets re-rendered. Existing production assets are unchanged. |
| Full-set front/back/finish contact sheets | PASS locally | `.foilbury/evidence/contact-sheets/` (private, contains member art). |
| Designed public backs | PASS locally | `pnpm content:backs` built and published 42 public variant backs locally. Production publish is pending an approved operator path. |
| Card flat/flip/zoom/3D/variant comparison | PASS locally | `/play/card/:id`; reduced-motion and keyboard paths; album test. |
| Opening reveal, skip, replay, receipt, new/duplicate | PASS locally | `/play/draw`; `DrawStudio.tsx`; committed receipt before animation. |
| Progress: unique, copies, duplicates, all core finishes | PASS | `/play/collection`; binder and finish bars; `collectionProgress`/`collectionBinder`. |
| Achievements: first, all Plain/Silver/Gold/Holo, core mastery, roster | PASS | 126 new production definitions; `provision-mastery-achievements`; evaluator tests. |
| Achievement badge art relationship | PASS | Collection emblem overlay on badge; family silhouettes. |
| Share: card, collection, badge, wishlist, profile | PASS (local) | `/s/:token`; SharePanel/ShareLinkButton; member gate and public-safe audience. |
| Export stills and playable video | PASS (local/public) | `/showcase`; 18s and 8s H.264 MP4; `public/media/showcase/manifest.json`. |
| Public SEO | PASS | `pnpm test:seo`; sitemap/robots; dynamic public card OG image. |
| Full production re-render of existing card assets | BLOCKED (approval/operator) | No production asset mutation without a bounded, approved render run. |

## 6. Accessibility, performance and cleanup

| Requirement | Status | Evidence |
|---|---|---|
| Keyboard/touch/focus/reduced-motion | PASS (local) | Album/opening tests; `prefers-reduced-motion` reveal, 3D fallback. |
| Rendered visual review | PASS | `docs/evidence/signal-*.png`; `.foilbury/demo/latest`. |
| Production smoke | PASS | `pnpm test:deployed` 15 checks. |
| Performance hot-path audit | PARTIAL | Existing `docs/PERFORMANCE.md`; no new waterfall introduced; new tour queries bounded. |
| Resource cleanup | PASS (this run) | Demo/browser contexts closed; temporary scripts under `.foilbury/tmp`; no broad cleanup. |
| No orphaned processes | PASS | Dev server owned by this session; no killall. |

## 7. Commands and entry points

```sh
pnpm check                       # 72 unit + 76 Workers = 148 tests
pnpm test:album                  # real Chromium album journey
pnpm test:privacy                # privacy boundary
pnpm test:seo                    # public SEO
pnpm test:deployed               # production read-only smoke
pnpm demo                        # 33-stage local storyboard
pnpm demo:discord:check          # read-only Discord preflight
pnpm brand:generate              # regenerate the brand kit
pnpm export:showcase             # regenerate public stills/video
pnpm achievements:mastery        # dry-run mastery definitions
pnpm roles:provision             # dry-run Kaylee's scoped role
pnpm content:backs               # dry-run designed public backs
pnpm content:requeue --slug ...  # dry-run a bounded render queue
```

## 8. Remaining honest gaps

1. **Production card assets:** the deployed Worker has the new emblem and
   `MEMBER EDITION`/`PUBLIC SHOWCASE` renderer, but existing production renders
   were created by the previous renderer. Re-rendering them requires an
   approved operator run with the production asset store. Do not call the old
   assets "new design".
2. **Human Access session:** Dean must open `/platform-admin` and
   `/_emdash/admin` in a real Cloudflare session to record final human proof.
3. **Kaylee passkey/Bot ownership:** she has the scoped role and can sign in
   with Discord. To create a Bot she must add a passkey or authenticator; this
   is a deliberate human security step, not an implementation gap.
4. **Discord spectator/mobile:** requires Dean's real client and a controlled
   second account. The channel `#card-collector-test` still lacks an
   `@everyone` View Channel deny, so member art remains ephemeral there.
5. **Production EmDash console:** requires the human Access session; the local
   native console is already exercised.

## 9. Revisions

- Deployed Worker: `4de8b0ac-fefa-45d8-92d9-cfe7881a62a0` (initial Signal
  deployment). Redeploy the final commit after the last acceptance checks.
- Migration applied: `0014_scoped_roles_and_shares.sql`.
- Backup: `.foilbury/backups/prod-pre-signal-2026-11-03.json`
  (86 tables, 30,695 rows, SHA-256 `87d8f47d98f7b24abef3f372285d29e40011cee8015666a4bc6178d155affebc`).
- Production role: `role_kaylee_mvzm5yiky28tmcyedbg20wdx`, active, `all:true`,
  granted by `usr_prod_owner`, audited.
- Production mastery definitions: 126 inserted, 0 pending.
