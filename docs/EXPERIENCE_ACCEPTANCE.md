# Foilbury integrated acceptance — 2026/11/03

Source SHA and deployment are recorded at the end. Status vocabulary: **PASS**,
**PARTIAL**, **BLOCKED**, **NOT IMPLEMENTED**. A clean unit test is not a visual
or live-client pass.

> **2026-11-04 backlog execution:** the owner execution contract was implemented
> across the existing issue set. See section 10 for the current issue/EXP matrix,
> exact test results and the remaining production/deployment/client gates. The
> earlier notes below are retained as history, not current status. Production was
> read-only during this run; the deployed Worker remains `c4581234…` from source
> `2c133ee`, while this work is local and release-checked only.

## 1. Current-state reconciliation

| Claim                                                                 | Status                                 | Evidence                                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Owner sign-in correction was run and PR #5 merged                     | PASS                                   | `main` contains `f161b68`; PR #5 merged; Access read-back still shows the five apps and inherited MFA.        |
| Deployed Worker was `b5a8d35d…`                                       | VERIFIED TRUE for the previous release | `wrangler deployments list` history; docs commit `51b6a0d`.                                                   |
| Old final-issue note source `d98b825` / Worker `099b878f…`            | STALE                                  | It is a historical note. The current deployment was checked directly.                                         |
| `docs/DISCORD_TOUR.md` preflight 15 PASS / 2 BLOCKED                  | PASS                                   | `pnpm demo:discord:check` re-ran with the same result.                                                        |
| Kaylee is a full Super Admin                                          | FALSE                                  | Production `platform_admin=0`, no `fb_platform_admins` row.                                                   |
| Kaylee is an ordinary User with no scoped role                        | STALE                                  | A scoped Global Collection Admin row is now active (production, `2026/11/03 17:59 Melbourne`).                |
| EmDash and Foilbury have one clear boundary                           | PASS                                   | `docs/EMDASH_BOUNDARY.md`; no second card editor or second journal editor.                                    |
| Public/member card fronts include the collection emblem in production | PARTIAL                                | Public fronts are updated in production; launch member fronts still use the previous renderer. See section 8. |

## 2. Roles and permissions

| Requirement                                                 | Status                           | Evidence                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super Admin explicitly provisioned, one active row          | PASS                             | Production read-back: 1 active Super Admin, `usr_prod_owner`.                                                                                                                         |
| Global Collection Admin is scoped and not root              | PASS                             | `fb_platform_role_assignments`; API rejects public approval and out-of-scope collections; `tests/workers/roles.test.ts`.                                                              |
| Kaylee can manage shared collections without root           | PASS (provisioned)               | Production grant `role_kaylee_mvzm5yiky28tmcyedbg20wdx`, `all:true`, audited. Local visual review at `/studio` and `/studio/collections` shows one scoped world and no platform root. |
| Kaylee can own/manage her own Bot                           | PARTIAL — requires her passkey   | The Worker now accepts a verified Discord link as identity proof and still requires a passkey/authenticator for a protected account. A human passkey enrolment is the remaining step. |
| Attach a real verified email                                | PASS                             | `/account/security` → Add or change primary email; one-use `link_email` bound to `user_id`; test `tests/workers/roles.test.ts`.                                                       |
| People search/filter, scopes, grant/revoke, pending invites | PASS                             | `/platform-admin/people`; `PlatformPeople.tsx`; `GET /api/v1/platform/people`, `POST /api/v1/platform/roles`, `POST /api/v1/platform/roles/:id/revoke`.                               |
| Idempotent grant/revoke and audit                           | PASS                             | `assignPlatformRole` returns `changed:false` for the same scope; `revokePlatformRole` is idempotent; audit rows.                                                                      |
| Same checks on website, API, MCP, background jobs           | PASS (worker/API); PARTIAL (MCP) | `/api/v1/studio/*` aliases the same domain routes; `mcp/server.mjs` adds scoped collection/share tools. MCP has no platform-role grant tool by design.                                |
| No public approval from a scoped admin                      | PASS                             | `requireSuperAdminContent` remains on `view_audience=public`; test.                                                                                                                   |
| No hidden UI-only capability                                | PASS                             | The Studio UI and `/api/v1/studio/*` share `requireGlobalCollectionManager`; scoped collection list uses the same scope.                                                              |

## 3. EmDash versus Foilbury

| Requirement                       | Status  | Evidence                                                                     |
| --------------------------------- | ------- | ---------------------------------------------------------------------------- |
| One editable card catalogue       | PASS    | Foilbury owns cards/editions/variants; EmDash has no card editor.            |
| One journal/CMS                   | PASS    | EmDash owns journal; Foilbury has a read-only handoff at `/admin/editorial`. |
| Clear boundary documented         | PASS    | `docs/EMDASH_BOUNDARY.md`; `PRODUCT.md`; `README.md`; Studio copy.           |
| Useful direct links               | PASS    | `/admin/editorial`, `/_emdash/admin`, `/journal`; Studio editorial link.     |
| Native EmDash console human proof | BLOCKED | Requires Dean's Cloudflare Access session; no agent impersonation.           |

## 4. Admin, demo and tours

| Requirement                                             | Status                                                                          | Evidence                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform Admin, Bot Admin, native EmDash, demo personas | PASS (local) / BLOCKED (live native console)                                    | `pnpm demo` 33 stages; `/platform-admin/people`; `/studio`; EmDash local dev bypass.                                                                                                                                                                                        |
| Website tour, returning path, skippable/resumable       | PASS                                                                            | `/tour` with six steps, signed-in continuation and private operator appendix.                                                                                                                                                                                               |
| Discord guided tour                                     | PASS (preflight/registered + handler journey); BLOCKED (human client/spectator) | `/foilbury tour`; preflight 15 PASS / 2 BLOCKED; `tests/workers/discord.test.ts` now walks welcome → album → free play → real draw → inspect → progress with a real ledger spend and attachment metadata. Live desktop/mobile client and a second spectator remain BLOCKED. |
| Spectator proof, actual desktop/mobile Discord          | BLOCKED                                                                         | Requires Dean's client and a controlled second account.                                                                                                                                                                                                                     |
| Channel audience check                                  | BLOCKED for member channel-visible art                                          | Test channel has no `@everyone` deny; restricted art stays ephemeral.                                                                                                                                                                                                       |
| Safe local demo fixtures                                | PASS                                                                            | `.foilbury` fixtures, demo album reset, no production seeding.                                                                                                                                                                                                              |
| Owner fresh Access session                              | BLOCKED                                                                         | Human consent/MFA; Access configuration is already correct.                                                                                                                                                                                                                 |

## 5. Experience and collection identity

| Requirement                                                           | Status                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distinct Foilbury palette and design system                           | PASS                                                                   | `DESIGN.md`; Signal palette; `docs/evidence/signal-*.png`.                                                                                                                                                                                                                                                                                                  |
| Collection mark on card front and back                                | PASS public production / PASS local member / PARTIAL member production | Public fronts and designed backs were published to production (80 variants, 80 backs). Local Danganronpa member assets were re-rendered; existing production member fronts remain from the previous renderer.                                                                                                                                               |
| Full-set front/back/finish contact sheets                             | PASS locally                                                           | `.foilbury/evidence/contact-sheets/` (private, contains member art).                                                                                                                                                                                                                                                                                        |
| Designed public backs                                                 | PASS                                                                   | `pnpm content:backs` built and `pnpm renders:publish-public` published 80 public fronts and 80 designed backs to production R2/D1; read-back 80 public fronts.                                                                                                                                                                                              |
| Card flat/flip/zoom/3D/variant comparison                             | PASS locally                                                           | `/play/card/:id`; reduced-motion and keyboard paths; album test.                                                                                                                                                                                                                                                                                            |
| Opening reveal, skip, replay, receipt, new/duplicate                  | PASS locally                                                           | `/play/draw`; `DrawStudio.tsx`; committed receipt before animation.                                                                                                                                                                                                                                                                                         |
| Progress: unique, copies, duplicates, all core finishes               | PASS                                                                   | `/play/collection`; binder and finish bars; `collectionProgress`/`collectionBinder`.                                                                                                                                                                                                                                                                        |
| Achievements: first, all Plain/Silver/Gold/Holo, core mastery, roster | PASS                                                                   | 126 new production definitions; `provision-mastery-achievements`; evaluator tests.                                                                                                                                                                                                                                                                          |
| Achievement badge art relationship                                    | PASS                                                                   | Collection emblem overlay on badge; family silhouettes.                                                                                                                                                                                                                                                                                                     |
| Share: card, collection, badge, wishlist, profile                     | PASS (local)                                                           | `/s/:token`; SharePanel/ShareLinkButton; member gate and public-safe audience.                                                                                                                                                                                                                                                                              |
| Export stills and playable video                                      | PASS (local/public)                                                    | `/showcase`; 18s and 8s H.264 MP4; `public/media/showcase/manifest.json`.                                                                                                                                                                                                                                                                                   |
| Public SEO                                                            | PASS                                                                   | `pnpm test:seo`; sitemap/robots; dynamic public card OG image.                                                                                                                                                                                                                                                                                              |
| Production public render refresh                                      | PASS                                                                   | 80 public variants and 80 designed backs published; old public assets remain in R2/D1 history.                                                                                                                                                                                                                                                              |
| Production member front re-render                                     | PREPARED / BLOCKED (approval/operator)                                 | 560 member variants still use the previous renderer. `pnpm plan:rerender` produced a read-only 16×40 bounded plan with asset/hash checks, backup/migration/render/read-back sequence and rollback pointer (`.foilbury/evidence/production-rerender-plan.json`). A real production Monokuma source renders with the full body in the new compositor locally. |

## 6. Accessibility, performance and cleanup

| Requirement                         | Status          | Evidence                                                                                 |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| Keyboard/touch/focus/reduced-motion | PASS (local)    | Album/opening tests; `prefers-reduced-motion` reveal, 3D fallback.                       |
| Rendered visual review              | PASS            | `docs/evidence/signal-*.png`; `.foilbury/demo/latest`.                                   |
| Production smoke                    | PASS            | `pnpm test:deployed` 17 checks.                                                          |
| Performance hot-path audit          | PARTIAL         | Existing `docs/PERFORMANCE.md`; no new waterfall introduced; new tour queries bounded.   |
| Resource cleanup                    | PASS (this run) | Demo/browser contexts closed; temporary scripts under `.foilbury/tmp`; no broad cleanup. |
| No orphaned processes               | PASS            | Dev server owned by this session; no killall.                                            |

## 7. Commands and entry points

```sh
pnpm check                       # 72 unit + 77 Workers = 149 tests
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

1. **Production member card fronts:** the public showcase fronts and designed
   backs are now published (80 + 80). The ~560 launch member variants still carry the previous renderer. A bounded member re-render requires an approved operator
   run; the local Danganronpa proofs show the target quality. Do not call the old
   member assets "new design".
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

- Deployed Worker: `c4581234-fa70-4247-9f89-70a35d5a1ec1` from source
  `2c133ee` (2026/11/03 19:14 Melbourne; 08:14 UTC).
- Final repository HEAD after release notes: `HEAD` on `main`; no runtime code
  changes after the deployed source.
- Migration applied: `0014_scoped_roles_and_shares.sql`.
- Backup: `.foilbury/backups/prod-pre-signal-2026-11-03.json`
  (86 tables, 30,695 rows, SHA-256 `87d8f47d98f7b24abef3f372285d29e40011cee8015666a4bc6178d155affebc`).
- Production role: `role_kaylee_mvzm5yiky28tmcyedbg20wdx`, active, `all:true`,
  granted by `usr_prod_owner`, audited.
- Production mastery definitions: 126 inserted, 0 pending.
- Public render refresh: 80 fronts and 80 designed backs published; read-back
  80 public fronts, designed back `rnd_8cdf267058b0c8fa66d8` returns
  `image/webp` with a public immutable cache.


## 10. Backlog execution — 2026-11-04

This section is the current matrix for the owner execution contract. It does not
replace the earlier historical evidence; it records what changed after the
quality-recovery pass.

### 10.1 Source, build and environment

| Item | Actual value |
| --- | --- |
| Starting local HEAD | `7766623` on `main`, 17 commits ahead of `origin/main`, clean tree |
| Final source | the commit containing this document; `git log` is authoritative |
| Production Worker | `c4581234-fa70-4247-9f89-70a35d5a1ec1` from source `2c133ee` |
| Production schema | through `0014_scoped_roles_and_shares.sql` |
| Migrations prepared, not applied | `0015_artwork_composition`, `0016_collection_preferences`, `0017_npc_collectors`, `0018_artwork_revisions`, `0019_finish_wishlists` |
| Production catalogue | 156 cards, 640 variants, 640 published fronts, 640 published backs, 0 pending render jobs |
| Production collections | 21 published collections, 21 with identity logos, 17 with covers |
| Release plan | `.foilbury/evidence/release-plan-a6364b36e913.json` (clean tree, no leaked env, secret markers absent, migrations listed) |
| Local DB | migrated through `0019`; rendered fixtures and demo identities are local only |

The release helper now refuses a dirty tree, a bundled `.dev.vars`, or secret
markers in the server bundle, and records source/build/migration identity in a
plan/receipt. It was run in `--check` mode only. No production write, deployment,
migration or member render was performed.

### 10.2 Issue disposition

| Issue | Implemented | Locally verified | Integrated | Deployed | Live/client accepted |
| --- | --- | --- | --- | --- | --- |
| #2 collections/content/privacy | 21 published collections and 640/640 rendered variants verified; anonymous discovery/direct lookup leaks repaired | `test:privacy`, `test:album`, 201-card lookup regression | yes | old production catalogue, no new deploy | owner visual approval open |
| #3 performance | measured before/after; no new waterfall; production read-only samples | `perf:local` 7 routes, 0 long tasks | yes | no new deploy | production percentile monitoring open |
| #4 runner ownership/cleanup | every new browser script uses `finally`; owned server stopped; no broad kill | success/failure/cancel paths exercised in this run | yes | n/a | — |
| #7 Discord tour | handler journey + on-demand NPC inspection tested | `discord.test.ts` 18 tests; preflight 15 PASS / 2 BLOCKED | yes | commands in production are older (no `npc`) | **BLOCKED** desktop/mobile/spectator |
| #8 experience epic | see EXP matrix below | product/UI/album/artwork/NPC/editorial scripts | yes | no new deploy | owner creative + Discord gates open |
| #9 NPC collectors | full vertical slice + presets + lounge + API/MCP/Discord inspection | 8 worker tests, 8 browser checks, 3-demo cast | yes | no new deploy | human client inspection open |
| #10 artwork admin | visible art, non-destructive composition, revision lineage, strong-auth recovery | `test:artwork` 11/11; revision worker regression | yes | no production migration | production editor save open (approval) |
| #11 card rendering | one 5:7 contract, controls outside object, safe art window, derivatives | `test:product` 56/56 + negative controls | yes | old member renders remain | owner visual acceptance open |
| #12 UX remediation | Studio/collection pagination, preferences, wishlist, lounge, copy/state fixes, contrast sweep | `test:ui` 48 checks; product 56 | yes | no new deploy | owner visual acceptance open |
| #13 autonomous QA | 201 lookup, stale odds, route shadowing, scopes, revocation, CMS fidelity, rate-limit buckets, NPC flows | see 10.3 | yes | n/a | live Discord/human cases remain |
| #14 collection preferences | collection-first opt-in/out, multi-collection/unfiled policy, distribution fingerprint | 5 preference tests + draw consent test | yes | no production migration | web journey exercised; Discord live blocked |
| #15 share privacy/UX | one resolution policy, owner revocation, cross-Bot denial, preview/confirm/expiry/manage/revoke | 5 privacy tests + browser panels | yes | no new deploy | recipient client proof still local |
| #16 exact routing | gifts/received, trades/:id, member directory, unknown suffix 404 | 6 HTTP dispatch tests | yes | no new deploy | — |
| #17 agent scopes | named read/write scopes, human-only join/admission, no write-on-read exploration | route-scope negative tests | yes | no new deploy | — |
| #18 membership lifecycle | no magic-link restoration, invited/suspended/revoked denial, capability-based member admin, session invalidation | 14 auth tests incl. existing-session revocation | yes | no new deploy | — |
| #19 release acceptance | source/build/migration plan and receipt, read-back reconciliation | `deploy:production --check` | yes | **NOT DEPLOYED** | deployment approval missing |
| #20 EmDash fidelity | native renderer for rich blocks, explicit unsafe fallbacks, draft→publish→revise→schedule→unpublish | 4 unit tests + 8-step local EmDash acceptance | yes | no new deploy | native human Access console BLOCKED |
| #21 auth abuse limits | edge client HMAC bucket, per-email and service ceilings, 429, prune, spoof resistance | 5 rate-limit tests incl. concurrency | yes | no new deploy | production traffic not load-tested |

### 10.3 Test and evidence ledger

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm check` | access config + types + 76 unit + 119 Workers tests pass | `.foilbury/evidence/final-tests.txt` |
| `pnpm test:ui` | 48 route/theme/viewport checks, 0 serious/critical axe, no overflow | `docs/evidence/ui-*.png`, `.foilbury/evidence/final-ui.txt` |
| `pnpm test:product` | 56/56, including forced 502/503, retry, no-JS, 5:7 geometry, negative controls | `.foilbury/evidence/final-product.txt` |
| `pnpm test:artwork` | 11/11, real editor, step-up, persisted composition | `.foilbury/evidence/artwork-editor/report.json` |
| `pnpm test:album` | 15/15, real passkey admin → render → draw → gift → retire | `docs/evidence/editorial-browser.json` |
| `pnpm test:privacy` | 9/9 | `docs/evidence/privacy.json` |
| `pnpm test:seo` | 6/6 | command output |
| `pnpm test:deployed` | 17/17 read-only production smoke | command output |
| `pnpm test:npc` | 8/8 real NPC economy/permissions/schedule tests | `docs/evidence/npc-browser.json` |
| `pnpm test:npc:ui` | 8/8 Studio + lounge browser checks, fixture cleaned | `docs/evidence/npc-studio.png`, `npc-lounge*.png` |
| `pnpm test:editorial:emdash` | 8/8 native CMS draft/publish/read/revise/schedule/unpublish | `docs/evidence/emdash-editorial.json` |
| `pnpm demo:mastery` | real 7/8 → 8/8, Gold mastery, Holographic mastery, one reward, member-gated share | `docs/evidence/mastery-summary.json`, private `.foilbury/evidence/mastery/` |
| `pnpm perf:local` | `/play` LCP 172 ms, `/play/collection` 116 ms, 0 long tasks | `.foilbury/evidence/performance/report.json` |
| Production read-only timing | home TTFB 0.25–0.96 s, catalogue 0.22–0.32 s | recorded in this run |

### 10.4 EXP-01–EXP-25

| ID | Status | Evidence / remaining |
| --- | --- | --- |
| EXP-01 Research | PASS | `docs/DESIGN_REVIEW.md`; bounded references, adopted/rejected decisions |
| EXP-02 Set identity | PASS | 21/21 collection logos; card front/back emblem renderer; production read-back |
| EXP-03 Cohesion | PASS local | contact sheets under `.foilbury/evidence/contact-sheets`; human display review open |
| EXP-04 Information | PARTIAL | 126 fact-checked / 14 explicitly draft profiles; spoiler-safe bios/attributes/credits |
| EXP-05 Cards | PASS | web flat/flip/zoom/3D/finish comparison; keyboard/touch/reduced motion tests |
| EXP-06 Opening | PASS | committed receipt, skip/replay, new/duplicate/finish states |
| EXP-07 Discord cards | BLOCKED | real desktop/mobile clients not available; handler/media parity tested |
| EXP-08 Progress | PASS local | unique/copies/finish counts agree in web and handler tests |
| EXP-09 Wishlist | PASS local | owned/obtainable/wanted view, exact finish/edition target, pool paths |
| EXP-10 Mastery | PASS local | versioned definitions, frozen rosters, Plain/Silver/Gold/Holographic predicates |
| EXP-11 Semantics | PASS | duplicate-subject/normalised finish tests; current vs lifetime explicit |
| EXP-12 Rewards | PASS | idempotent/concurrent/backfill tests; no duplicate mastery reward |
| EXP-13 Integration | PASS local | unlocks in opening, album, achievements and profile; no duplicate announcement |
| EXP-14 Showcase | PASS local | curated favourites, badges, world progress, share audience preview |
| EXP-15 Privacy | PASS local | anonymous/member/cross-Bot/revoked/audience-change share matrix |
| EXP-16 Media | PASS | 18 s trailer, 8 s teaser, stills, posters, private replay; silent H.264 |
| EXP-17 Export truth | PASS | manifest hashes/source commit; export does not mutate gameplay |
| EXP-18 Tours | PARTIAL | web tour PASS; Discord host/spectator BLOCKED |
| EXP-19 Live transitions | PASS local | real 7/8→8/8, Gold, Holographic, 8/8 roster, one reward, member-gated share |
| EXP-20 Admin | PARTIAL | real local Studio/editor journeys; native Cloudflare Access human session BLOCKED |
| EXP-21 SEO | PASS local | metadata/schema/sitemap/robots/unfurl checks; private surfaces excluded |
| EXP-22 Accessibility/performance | PASS local | 48 UI checks, axe clean, measured LCP/CLS; field data not claimed |
| EXP-23 Retention | PASS | daily allowance, goals, mastery; no punitive streak or paid randomness |
| EXP-24 Integrity/operations | PASS local | IDs/serials/wallets preserved; release plan; cleanup and rollback recorded |
| EXP-25 Acceptance | BLOCKED | owner creative approval and real Discord desktop/mobile/spectator remain |

### 10.5 Remaining exact blockers

1. **Production deployment**: applying `0015`–`0019` and deploying source
   requires owner approval. The release plan is ready; no production write was
   made.
2. **Production member re-render**: 560 existing member fronts still use the
   previous renderer; a bounded re-render/publication plan is prepared and
   approval-gated. Public showcase fronts/backs are already current.
3. **Human Cloudflare Access proof**: `/platform-admin` and `/_emdash/admin`
   need Dean's real Access session and MFA.
4. **Discord live acceptance**: `/foilbury tour`, desktop/mobile clients and a
   controlled second-account spectator cannot be performed by this host. The
   test channel still lacks an `@everyone` View Channel deny, so member artwork
   stays ephemeral and no channel permission was changed.
5. **Human creative approval**: owner review of the current palette, Studio,
   card contact sheets and generated NPC cast is not inferred.

Cleanup: the owned dev server is stopped before handoff; every browser context,
temporary NPC and EmDash token created by the new scripts is closed/deleted in
`finally`. Unrelated processes from other projects were not touched.
