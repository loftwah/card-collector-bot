# Skills used in the Foilbury pass

Installed and exercised on 2026-11-02 against this working tree. Installation used the supported `skills` CLI (the OpenCode-compatible path), then the skills were loaded through the agent's skill mechanism. Source copies live under `.agents/skills/`; they are project-local and visible to the harness.

| Skill | Source / version | Installed location | Actual use | Material findings | Changes / evidence |
|---|---|---|---|---|---|
| Impeccable | `~/.agents/skills/impeccable` (current installed skill); context run against `src/pages/index.astro` | User skill directory, loaded by the OpenCode harness | Ran `context.mjs`; loaded `craft-floor.md` and `operate.md`; critiqued rendered public/player/admin screens; set a cabinet/editorial direction; polished; ran `detect.mjs --json` over changed UI files | Zero mechanical detector findings was not treated as acceptance. Browser review found dark-band inversion, brass text contrast, portal/form labels, mobile ring overflow and admin active-state contrast. | Geist font system; shadcn token mapping; card flip/back; collection marks; axe checks; `docs/evidence/ui-*.png` and `docs/evidence/ui-a11y.json` |
| shadcn/ui | `shadcn/ui` skill from skills.sh; current CLI `shadcn@latest` | `.agents/skills/shadcn` | Ran `shadcn info --json`, added official `table`, `badge`, `label`, `textarea`, `separator`, `checkbox`, `dropdown-menu`, `select`, `tooltip`, `skeleton`, `spinner`, `alert`, `empty`; created `components.json` with Astro/Tailwind 4 aliases | Existing hand-built Radix/Tailwind primitives were compatible; official components needed Foilbury token mapping and accessible `Field` labels. | `components.json`; `src/components/ui/*`; focus/contrast fixes; axe result `docs/evidence/ui-a11y.json` |
| Cloudflare One | `cloudflare/skills` (installed 2026-11-02) | `.agents/skills/cloudflare-one` | Reviewed Access app, IdP, policy, MFA and JWT configuration; inspected existing apps/policies before changes; used Cloudflare API for Apps/Policies/IdPs | Existing admin app was Dean-only; creators had no supported admission path; platform app did not exist; Access JWT was not validated by the Worker. | `/admin` and `/api/v1/admin` retain Dean + explicit creator group + one-time PIN entry; `/platform-admin`, `/api/v1/platform` and `/_emdash` Dean-only with Cloudflare IdP + independent MFA; Worker JWT verification in `src/server/access.ts`; `scripts/configure-cloudflare-access.mjs` |
| Wrangler / Workers best practices | `cloudflare/skills` (installed 2026-11-02) | `.agents/skills/wrangler`, `.agents/skills/workers-best-practices` | Checked version, bindings, routes, secrets, D1 migrations, deployment and rollback; removed `.dev.vars` from the production bundle | Needed explicit build/deploy cleanup; production secret `RESEND_API_KEY` was missing. | `wrangler.production.jsonc`; deploy cleanup; D1 backup `scripts/backup-d1-json.mjs`; Worker version `e188ea0e-e73c-4c37-a62b-b5134cc2abc3` |
| Cloudflare Email Service | `cloudflare/skills` (installed 2026-11-02) | `.agents/skills/cloudflare-email-service` | Reviewed Resend sender/domain and transactional send path | Existing Resend domain `loftwah.com` is verified; the Worker had no Resend secret. | `src/server/email.ts`; magic-link delivery; live accepted send to `dean@deanlofts.xyz`; audit `delivered:true` |
| EmDash site / CLI / plugins | `emdash-cms/skills` (installed 2026-11-02); EmDash `1.4.0` | `.agents/skills/building-emdash-site`, `.agents/skills/creating-plugins`, `.agents/skills/emdash-cli` | Inspected native auth, Access adapter, migrations, admin branding and route protection; used supported `@emdash-cms/cloudflare` `access()` adapter | Production Access mode disables native passkey login; existing Dean user/passkey had to be preserved; nested setup/API routes needed edge coverage. | `astro.config.mjs` Access auth with `autoProvision:false`; Foilbury admin branding; `/_emdash` Access app; existing Dean user preserved; nested routes tested with 302 |
| Playwright | `@playwright/test` 1.64.1 | `node_modules`; scripts in `scripts/test-*` | Real Chromium journeys for Discord OAuth start, magic-link redemption/replay, virtual passkeys, TOTP, recovery, session revocation, independent creator, editorial catalogue and UI/axe checks | Static checks and screenshots alone missed contrast/labels/overflow; virtual authenticator + real server exposed actual state transitions. | `scripts/test-auth-e2e.mjs`, `scripts/test-creator-e2e.mjs`, `scripts/test-editorial-e2e.mjs`, `scripts/test-ui-a11y.mjs`; JSON evidence in `docs/evidence/` |

## Harness notes

- The browser integration changed from the prior `browser` tool to the OpenCode Playwright tools during the pass. The scripts use the installed Playwright package directly, so they are reproducible without assuming a desktop tab.
- Impeccable's automatic hook was not active. `detect.mjs` was run explicitly and its result is recorded, but acceptance used rendered axe/manual checks.
- No skill was copied merely as documentation: each entry above names the code/configuration or browser evidence it produced.

## 2026-11-03 album increment

| Skill | Provenance / version | Loaded location | Actual work | Findings | Evidence |
|---|---|---|---|---|---|
| Impeccable | User-installed `~/.agents/skills/impeccable`, version `4.0.4`; upstream docs checked at `https://impeccable.style/docs/` (install/context/hooks/detector workflow) | Harness skill + `scripts/context.mjs --target src/pages/index.astro`; `reference/craft-floor.md` read before UI edits | Replaced the restrained cabinet-only landing composition with a warmer public-showcase direction, added coral/saffron/teal accents, kept Geist, rewrote player language, built the 3D inspector, achievement badge family and gift surface | The mechanical detector is not visual acceptance. The first render showed an over-tall members section and duplicate filter chips; both were corrected. Eyebrow overuse remains on admin surfaces and is being reduced on player surfaces. | `.foilbury/tmp/home-desktop.png`, `home-mobile.png`, `cabinet.png`, `card.png`; final evidence in `docs/evidence/` |
| shadcn/ui | `shadcn` skill from `shadcn/ui`, project-local `.agents/skills/shadcn`; upstream docs checked at `https://ui.shadcn.com/docs/skills`; `npx shadcn@4.23.0 info --json` confirmed Astro/Tailwind v4/base-radix/lucide and the `@/components/ui` alias | Existing `src/components/ui/*` primitives | Reused Button, Field, Input, Select, Textarea, Switch, Dialog and Badge for the gift composer, achievement admin, collection visibility form and card inspector controls. No second primitive library was introduced. | Inputs needed explicit labels and `className` rather than `class` in React surfaces; the detector/typecheck caught the mismatch. | `pnpm check:types`; `src/components/admin/GiftComposer.tsx`, `AchievementAdmin.tsx`, `CardInspector.tsx` |
| Cloudflare One / Wrangler / Workers best practices | `cloudflare/skills` project-local copies from `skills-lock.json`; Wrangler `4.156.1`; Workers compatibility date `2026-11-01` | `.agents/skills/cloudflare-one`, `.agents/skills/wrangler`, `.agents/skills/workers-best-practices` | Added D1 migration `0008`; used `wrangler d1 execute --remote` read-only inspections, a JSON backup, local migration application, Worker deployment and live smoke checks. Reviewed D1/R2 bindings, cache headers, media delivery and Access separation. | The existing agent path was blocked by the Access gate on `/api/v1/admin`; fixed by allowing scoped agent tokens only on that API surface, while gifts and platform administration still require a human. D1's bound-parameter budget broke 200-card hydration; fixed with 20-card hydration batches. | `migrations/0008_album_visibility_achievements_gifts.sql`; `scripts/backup-d1-json.mjs`; `wrangler deployments list`; `docs/evidence/deployed-*.json` |
| EmDash CMS | `emdash-cli`, `building-emdash-site` and `creating-plugins` skills from `emdash-cms/skills`; EmDash `1.4.0`; upstream docs checked at `https://docs.emdashcms.com/agent-skills/` | `.agents/skills/emdash-cli`, `.agents/skills/building-emdash-site`, `.agents/skills/creating-plugins` | Inspected the adopted editorial boundary before changing collection/card content. Confirmed the journal remains EmDash-owned and the Foilbury catalogue remains D1-owned; no second editable card catalogue was added. | The older issue sentence implying EmDash should own card editing is superseded by the working boundary. Documented the reconciliation in `docs/COLLECTIONS.md` and `PRODUCT.md`. | `/journal`, `/_emdash` route protection; `docs/COLLECTIONS.md` |
| Playwright | `@playwright/test` `1.64.1` | Project dependency; real Chromium scripts in `scripts/` | Public showcase, cabinet, card detail, 3D controls, mobile reflow, admin collection/card/achievement/gift journeys, member draw/inspection and privacy states. Axe/keyboard/zoom checks use the existing UI script. | Screenshots alone did not catch duplicate chips, a too-tall section or the 3D fallback; the scripts assert the visible state and take desktop/mobile evidence. | `scripts/test-album-e2e.mjs`, `docs/evidence/album-*.png`, `docs/evidence/album-browser.json` |
| SEO audit | `coreyhaines31/marketingskills` `seo-audit`, checked against Google Search Central; not installed as a broad marketing toolkit | Read-only skill guidance applied to approved public routes | Audited titles, descriptions, canonical URLs, headings, image alternatives, sitemap/robots posture and structured-data scope. Kept member routes `noindex` and out of the sitemap. | The public showcase has a small, honest index surface; no franchise landing pages, public profiles or achievement feeds were created. | `docs/SEO.md`; `scripts/test-seo.mjs` |

## Cloudflare Access note for headless import

The production `/api/v1/admin` edge application correctly blocks unauthenticated
requests. To run the reviewed content import through the same domain API, a
24-hour Access **service token** was created and attached only to the
`Foilbury Admin API` app with a `non_identity` policy. The Worker still required a
scoped Foilbury agent token and re-validated the represented Super Admin and
scopes. The policy/token were removed after the import:

- `scripts/provision-access-service-token.mjs --apply`
- `scripts/provision-production-agent.mjs --apply`
- `node scripts/content/provision.mjs` with `FOILBURY_URL`, `FOILBURY_AGENT_TOKEN`,
  `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
- `scripts/provision-access-service-token.mjs --cleanup`

This is a temporary machine-admission path, not a new human role. Access still
never grants a Foilbury role, and gifts/platform administration still require a
human with recent strong authentication.

## Final production release

- Migrations `0008` and `0009` applied to production D1 after a JSON backup.
- Worker deployed as `099b878f-1f79-4132-ac7c-b1c15e8ae77c`.
- Catalogue release `3`.
- 17 launch collections / 140 cards / 560 launch variants / 560 backs /
  1,280 derivatives imported through the scoped API.
- Signed-out API returns 4 public collections; member/agent context returns 21.
- Public engine remains free: 800 welcome, 480 daily, 80 standard opening;
  finish weights Plain 45 / Silver 30 / Gold 18 / Holographic 7.

## 2026-11-03 corrective art pass

| Skill | Provenance / version | Loaded location | Actual work | Findings | Evidence |
|---|---|---|---|---|---|
| Impeccable | User-installed `~/.agents/skills/impeccable`; `context.mjs --target art/collection-art.mjs` run this session | Harness skill | Re-reviewed the rendered fronts/backs after replacing monograms with sourced subjects. Corrected the back layout after the first render showed overlapping bio/attributes and low contrast. | The original monogram fallback produced an unintended "HH" reading for Hajime Hinata. Sourced images fixed recognition but exposed a wide-image crop problem, wrong season images for Total Drama, a multi-figure Junko source, and a back layout that could not hold real biographies. | `art/collection-art.mjs`, `art/subject-sources.mjs`, `scripts/content/source-art.mjs`; contact sheets under `.foilbury/tmp/review/` (gitignored) |
| Playwright / image review | `@playwright/test` `1.64.1`; `sharp` 0.35.5 | Project dependency | Generated and visually inspected all 17 collection sheets, four-finish front/back sheets and the small-size contact sheets; inspected source candidates before choosing final files. | Contact-sheet review caught several bad sources that automated dimensions alone would have passed: Chef's food close-up, Maggie's house-wide screenshot, Chris's distant shot, Light's cropped torso, Junko's three-figure sheet, Shai's clipped head and Jaylen Brown's back view. Each was replaced or cropped. | `.foilbury/tmp/review/*.jpg`, `.foilbury/tmp/finishes/*.jpg`, `.foilbury/tmp/special/sheet.jpg`, `.foilbury/tmp/candidates/sheet.jpg` |
| Cloudflare / Wrangler | Existing project-local skills; Wrangler `4.156.1` | `.agents/skills/wrangler`, `.agents/skills/workers-best-practices` | Added migration `0010_render_source_hash.sql`; inspected production D1 read-only for duplicate editions; prepared the render queue to invalidate stale art without forcing the whole catalogue. | Production has duplicate editions only for the pre-existing public showcase cards (`pippa`, `pepe`, `loftwah`), not for launch cards. The import path created a new edition on every revision, which would duplicate launch variants; changed it to revise the current edition in place and keep variant IDs stable. | `migrations/0010_render_source_hash.sql`, `src/server/modules/imports.ts`, `src/server/modules/assets.ts`; `pnpm check` (81 tests) |
| Source research | Fandom MediaWiki APIs, Wikipedia REST, Wikimedia Commons API, `images.weserv.nl` for Cloudflare-blocked wiki images | `scripts/content/source-art.mjs`, `art/subject-sources.mjs` | Researched and pinned 140/140 subject images, including season-one Total Drama stills, clean Simpsons renders, separate Rin/Len voicebank renders, and context images. Recorded page, file, retrieval time, licence metadata and credit. | Wiki page images are not automatically the right adaptation or a clean solo subject. A curated override list is required; automatic lookup alone is not sufficient. | `.foilbury/sourced/provenance.json` (private), `docs/CONTENT_COVERAGE.md`, `docs/MEDIA.md` |

Production release for this pass: Worker `17e140dc-9652-43cb-9d13-abbdcff9c396`,
catalogue release `4`, 640/640 render jobs succeeded, 560/560 launch variants
bound to the current source hash, 140/140 sourced credits, 0 placeholder
subjects, 0 duplicate launch editions. The temporary content agent grant and
Access service token were revoked/removed after the import. The `/foilbury`
guild command was re-registered with the `achievements` option.

## 2026-11-03 Impeccable 4.8.0 upgrade and Worlds polish

This supersedes the earlier Impeccable 4.0.4 row for future sessions.

| Field | Record |
|---|---|
| Source / version | Upstream `pbakaus/impeccable`, latest release `cli-v4.8.0` (published 2026-10-26); CLI `4.8.0`, detector engine `0.1.18`. Installed with `npx impeccable@latest install --project --providers=agents` and `--providers=opencode`. |
| Installed location | Project-local `.agents/skills/impeccable/` (the path required by `AGENTS.md`) and `.opencode/skills/impeccable/` (harness path). The earlier user-level `~/.agents/skills/impeccable` 4.0.4 is no longer the authority. |
| Context | `node .agents/skills/impeccable/scripts/context.mjs --target src/pages/index.astro` loaded `PRODUCT.md`, `DESIGN.md` and returned no surface brief. |
| Critique method | Dual sub-agent: Assessment A `ses_e60ace9fbffeHo7Vxvc4f6P2Ur` (design review) and Assessment B `ses_e60ace9fbffdFfRUQi248HHIkd` (detector + browser evidence), isolated from each other. Target: `src/pages/play/collections.astro` at `http://localhost:5173/play/collections`, authenticated local owner. |
| Detector | `impeccable detect --json src/pages/play/collections.astro src/layouts/PlayerLayout.astro src/layouts/BaseLayout.astro` → `[]` (0 findings). CSS-only Geist `overused-font` warnings were treated as brief-controlled, not defects. |
| Rendered checks | 34/34 `scripts/test-ui-a11y.mjs` checks PASS; axe WCAG 2 AA had 0 serious/critical findings; no horizontal overflow at 1440, 720, 390 or 320 px; keyboard focus visible; reduced-motion preference applied. |
| Material findings | Desktop CLS 0.435 from the display-font swap plus wrapping KPI; mobile first card started at 696 px and hid the product; no search/filter/sort; 21 nearly-empty progress bars and tiny status text; “1 cards” and invalid 0/0 progress; banned eyebrows above headings; viewer-dependent inventory thumbnails and upscaled portrait covers; double logo on banner art; reduced-motion still applied transforms; no `aria-current` on the active Worlds tab. |
| Changes | Removed the Worlds eyebrow and “Available 24” KPI; added the Worlds H1, collector summary, search, status filter and progress/name sort; added a contextual “Continue with …” link; made progress state readable and complete-state explicit; removed invalid progressbars when total is 0; fixed pluralisation; made cover art deterministic collection art (`cover_url`) with a designed fallback; removed duplicate overlay marks; raised small metadata sizes; fixed overlay contrast; added `aria-current`, a thin visible tab scrollbar, font preloads, and reduced-motion transform removal. |
| Evidence | `docs/evidence/ui-worlds-light.png`, `ui-worlds-dark.png`, `ui-worlds-mobile-light.png`, `ui-worlds-mobile-dark.png`; `docs/evidence/ui-a11y.json`; `/tmp/fb-evidence/` (Assessment B working evidence). |
| Remaining | Mobile first card still begins below the first 844 px because the hero + search controls are substantial; mobile sub-nav remains horizontally scrollable (now with a visible thin scrollbar); the collection progress loop is still N+1 (~one aggregate pair per collection); local proof-world fixtures appear in local screenshots and must not be used as production evidence. |
| Unrelated work left untouched | `src/server/discord/handler.ts`, `src/server/discord/commands.ts` and `tests/workers/discord.test.ts` had uncommitted changes from another pass during this session. One Discord test currently fails (`link?.type` expected 2 but undefined); this is outside the Impeccable UI change and was not overwritten. |
