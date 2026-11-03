# Foilbury quality recovery — 2026-11-03 evening

Source commit at the time of this report: `8aa40848f0b453a17d1d8b72f37ab5e272bf6f6c` (`8aa4084`).
Deployed Worker at the time of this report: `c6f0b94a-c2f6-4461-ae59-321db9b7079e`.

**Update 2026/11/04:** this quality-recovery work is now deployed as part of
Worker `23bd6238-e2af-4467-8c9b-53d35b622be7` from source `1947875`, schema
through `0023`. The production catalogue read-back is 672/672 fronts and 672/672
backs, with no pending render jobs; a Monokuma Gold sample shows the full body
inside the new art window. The release also fixed a D1 bound-parameter
regression in catalogue hydration. Keep this document as the historical
before/after record.

Status vocabulary: **PASS**, **FAIL**, **BLOCKED**, **PARTIAL**. A passing test or a
clean axe report is not a substitute for the owner looking at the product.

## 1. What was actually wrong

The owner's rejection was reproduced on the running local app before any change:

| Defect                             | Actual evidence                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dark-on-dark surfaces              | `admin-dark.png`, `play-dark.png`, `studio-dark.png`: page `#07110f`, panels `#0d1b17`, borders `#234039`. The Studio heading was literally `color: var(--paper)` (near-black in dark mode).    |
| Weak hierarchy / endless stack     | `/play` combined hero, featured card, drawer, draw room, collections, sets and achievements in one 3,284px page; mobile `/play` was 5,722px; mobile `/play/collections` was 10,195px.           |
| Wrong totals                       | `/play` labelled `inventory.length` (12) as "Cards kept" and "All 12 cards" while the account had 21 copies.                                                                                    |
| Collection progress exceeded 100%  | `/play/profile` showed `Bubbles 4/3 subjects · 133%` because the owned query counted retired/draft cards while the roster query did not.                                                        |
| Broken achievement art             | `AchievementBadge.astro` interpolated an SVG path string as text, so every badge rendered as an empty circle with a tiny cross.                                                                 |
| Card controls over metadata        | The old `LayeredCard` placed the flip button absolutely over the card and nested it inside the navigation anchor. A tall subject could also be cropped by the `portrait`/`medallion` heuristic. |
| More menu clipped                  | `.cabinet-nav` had `overflow-x: auto`, clipping the absolutely positioned "More" menu to a 6px strip.                                                                                           |
| Error shown as empty / no recovery | Collection and draw failures had no retry path; `getPoolPreview` was swallowed as `null` on the player home.                                                                                    |
| Artwork editor had no artwork      | The "Add artwork" dialog only listed asset names. There was no preview, crop, zoom, placement or persisted composition.                                                                         |
| Renderer clipped tall art          | The deterministic compositor used `fit: cover` for tall/opaque images. The production Monokuma Gold render cut the feet behind the text band.                                                   |

## 2. What changed

### Visual system and hierarchy

- Added explicit page / panel / raised / card-object surfaces. Light mode now
  uses white panels on a tinted page; dark mode uses a deep green page with
  clearly lighter `#0f211c` panels and `#34554b` rules.
- Replaced black primary actions with the aqua Signal action (dark text on aqua;
  AA contrast), stronger focus rings, signal active states and a distinct
  status palette.
- Rebuilt the player cabinet bar: five primary destinations plus a real "More"
  menu, with a longer structural rule instead of twelve equal tabs.
- Tightened page titles (`page-title` / `panel-title`) and removed the giant
  first-viewport hero from the member home.
- Fixed Studio/Platform band text colours and the hard-coded light text on
  `.btn-secondary` in dark mode.
- Fixed the achievement badge SVG (`set:html`), so the family silhouette,
  material and rarity colours actually render.
- Fixed the `Bubbles 4/3` invariant at the domain query, not by clamping the UI.
- Added an explicit `No published render yet` state in the admin edit dialog and
  a visible artwork strip for published editions.

### Member information architecture

- `/play` is now a concise cabinet: a real wallet/claim panel, the latest
  acquisition, a "next best move", real totals, bounded release/badge panels and
  six recent acquisitions. It no longer carries the draw room, full catalogue,
  set list and all achievements in one stack.
- `/play/collections` shows 9 worlds per page with a deliberate pager, real
  total/matching counts and parallel per-collection progress reads.
- `/play/achievements` shows earned and closest badges, then a 24-per-page
  filterable cabinet instead of rendering all 171 badges.
- `/play/collection` now supports server-rendered filters (`?search=&collection=&set=`)
  so the view works without JavaScript, plus a 24-row client page, load-more,
  URL history, a real total and an explicit empty state.
- `/play` reports the true inventory total and separates a failed pool preview
  from an empty pool.

### Card composition contract

- Added `PublishedCard`: the member-facing card is the saved front render and
  saved back render. The same bytes appear in the album, home, inspector and
  Discord.
- Rebuilt `LayeredCard` (used by the admin composition preview) with a reserved
  art window, a reserved information band, container-relative (`cqw`) type,
  two-line title clamp, metadata clamp and controls outside the object.
- A square opaque avatar is the only intentional medallion crop. Every other
  aspect ratio is contained, never cropped by width/height heuristics.
- The inspector stage now computes its maximum width from the available
  viewport height; at 1440×900 the card and its controls are both visible
  (stage bottom 807, controls 851). At 390×844 the card is 331×464 and the
  controls end at 813.
- Fixed the release of full-size source layers on the member home: the home now
  loads the published front/back renders (about 0.5–0.9 MB of images instead of
  ~6.9 MB of source layers + textures).

### Artwork editor (#10)

- Added migration `0015_artwork_composition.sql` (nullable `composition_json` on
  `fb_artwork_editions`).
- The admin artwork dialog now shows a live, real 5:7 card preview using the
  selected subject, background, finish and frame.
- Non-destructive controls: mode (Contain / Fill / Medallion), zoom 0.6–1.6,
  horizontal/vertical placement −20–20%, reset.
- The saved composition is persisted on the edition and passed to the render
  queue. Existing editions keep `NULL` and use the authored default.
- Saving creates a new immutable edition; it never changes the source file or an
  issued copy.
- A missing strong-auth session now explains the problem inside the dialog and
  links to `/account/security`; the editor is not a dead 403.
- The editor journey is covered by `pnpm test:artwork` (11/11), including the
  gate, TOTP recovery, save, reload and persisted composition read-back. It
  removes its temporary local fixture.

### Renderer and media

- `art/compose.mjs` now uses the same safe art window as the web card, normalises
  composition, contains tall/wide sources instead of `fit: cover` and reserves
  the text band. A real production Monokuma source now renders with the full
  body visible (`monokuma-gold-new.webp`).
- The render queue accepts the persisted composition.
- New renders generate 300×420 and 600×840 WebP derivatives. Local backfill
  tested the audited derivative endpoint; the production plan is below.
- Live composition preview textures are half-resolution WebP (about 100 KB
  instead of 2.3 MB for `material-plain`).
- Public showcase videos now use `preload="none"`; the poster remains.

## 3. Verification

### Product QA

`pnpm test:product` — **56/56 PASS** against the running local server. It covers:

- public home → catalogue → card detail → browser back;
- real 5:7 geometry, decoded images, reserved controls, no nested interactive
  elements, title/meta containment and back-face overlap;
- the actual inventory total versus the first page;
- server-rendered no-JS search;
- empty versus failed collection reads, forced 503 and retry;
- forced 502 draw preview and retry;
- odds table exposure;
- inspector geometry at desktop/mobile, flip, 3D mode and Escape;
- artwork preview, zoom, reset, published-artwork strip and cancel;
- ordinary-player denial at `/admin` and `/platform-admin`;
- mobile overflow and flip;
- axe on the repaired routes;
- negative controls: a deliberately broken aspect ratio and hidden card controls
  are both detected.

Reports: `.foilbury/evidence/product-qa/report.json`,
`.foilbury/evidence/artwork-editor/report.json`.

### Accessibility and rendered UI

`pnpm test:ui` — 34/34 PASS. A separate sweep of 22 routes × 2 themes found no
serious/critical axe findings after the fixes (the initial sweep found
`badge-signal` at 4.46:1; it now uses the ice/teal pair). Screenshots are
refreshed under `docs/evidence/ui-*.png`.

### Tests and build

- `pnpm check`: 72 unit + 80 Workers tests, 0 type errors.
- `pnpm build`: PASS.
- New regressions: `tests/workers/collection-progress.test.ts` proves owned
  subjects can never exceed the published roster, including after retirement;
  `tests/workers/render-composition.test.ts` proves the edition composition
  reaches the render job payload.
- New Discord tour journey test: real draw via the tour, attachment metadata,
  serial, ledger −80, private inspection and progress.

### Performance (local, 1440×900, headless Chromium)

| Route                | TTFB   | LCP    | CLS    | Images   | Long tasks |
| -------------------- | ------ | ------ | ------ | -------- | ---------- |
| `/play`              | 119 ms | 152 ms | 0.0001 | 892 KB   | 0          |
| `/play/collections`  | 112 ms | 160 ms | 0.0001 | 620 KB   | 0          |
| `/play/collection`   | 92 ms  | 132 ms | 0      | 1,361 KB | 0          |
| `/play/draw`         | 48 ms  | 80 ms  | 0      | 0 KB     | 0          |
| `/play/achievements` | 51 ms  | 84 ms  | 0.0002 | 212 KB   | 0          |
| `/admin`             | 107 ms | 132 ms | 0      | 0 KB     | 0          |
| `/play/card/:id`     | —      | 116 ms | 0.0002 | 307 KB   | 0          |

Production read-only readings before deployment: home TTFB 1,369 ms, LCP
1,552 ms; catalogue TTFB 883 ms. The Vite dev JS is not included as a production
number. `/play` source layers dropped from ~6.9 MB to ~0.9 MB of images.
The showcase page currently downloads two MP4s under `preload="metadata"`; the
local fix uses `preload="none"` and will be verified after deployment.

## 4. Discord

### What is proven

- Live read-only preflight: **15 PASS, 0 FAIL, 2 BLOCKED** against the production
  Discord API and D1 (application, guild, channel, `/foilbury` registration with
  `tour`, installation, allowlist, selected album, 8/8 roster, 32/32 fronts,
  32/32 backs, `Three schools`, public showcase, identities).
- Workers command-handler journey: welcome → album → free play → open → a real
  draw → private inspection → progress. The draw created a D1 draw and instance,
  spent 80, attached `foilbury-card.webp` at 750×1050 and is replay-safe.
- Local real draw (same domain service, not a fabricated record):
  `Till — Silver`, serial `FB-32-JU-F0C4DD`, 80 Foil, balance 5,880,
  0.40% shown chance; replay returned the same receipt.
- Local completion: the Danganronpa album is 8/8 unique, 18 copies, 10
  duplicates; `Three schools` is earned with a 640 Foil reward and a real
  achievement receipt. This completion was produced by the documented
  administrator demo gift flow, not by a draw. It is labelled as a completion
  demo, not a real pull.
- Website/Discord parity evidence: `album-danganronpa-dark.png`,
  `card-monokuma-front-dark.png`, `card-monokuma-back-dark.png`.

### What is BLOCKED

The live Discord client itself is still **BLOCKED**:

1. Dean opens `#card-collector-test` in the real desktop client and runs
   `/foilbury tour`; press through welcome → album → free play → open (a real
   charged draw) → inspect front/back → progress → share public card.
2. Repeat the tour on a real mobile client and capture the mobile rendering.
3. The channel has no `@everyone` View Channel deny, so the bot correctly keeps
   member-only reveals ephemeral. Channel-visible member art needs a genuinely
   restricted channel and an approved audience policy; do not expose member art
   in the current test channel.
4. A controlled second account is required to prove the spectator view. Do not
   use another person's account.

The smallest safe permission fix is: create or choose a private channel with
`@everyone` **View Channel denied**, add Foilbury with View Channel, Send
Messages and Attach Files, then record that channel audience in Bot Admin. No
permission was changed by this task.

## 5. Production artwork

- Production read-only: 156 cards, 640 published variants, 640 fronts, 640 backs,
  0 pending jobs. 560 member variants still carry the previous renderer; 80
  public variants have no source hash (the older public publish path).
- No ownership, serial, wallet or ledger data is involved.
- `pnpm plan:rerender` emits a 16 × 40-variant bounded plan, approval tokens,
  backup/migration/render/read-back sequence and rollback pointer:
  `.foilbury/evidence/production-rerender-plan.json`.
- A real production Monokuma source was rendered locally with the new contract;
  the full body is visible and the text band is reserved. The production render
  still cuts the feet behind the text.
- Production apply is **BLOCKED pending approval** for: the additive migration,
  a fresh D1 JSON backup, the bounded batches and a Worker deployment.
- Do not copy member renders to a public path. The public showcase remains the
  four approved original-IP collections.

## 6. Deployment

- Source: `8aa4084` (local, clean after this report's docs commit).
- Deployed Worker: `c6f0b94a` (previous build). Production does not yet contain
  this quality pass.
- Deployment command: `pnpm deploy:production` after a fresh backup and owner
  approval. This report does not claim a production visual pass.
- The local dev server and browser contexts used for this work are owned by this
  session and were closed at the end; the dev server is left for review only if
  the operator wants it.

## 7. Residual work

1. Deploy `8aa4084` and re-run the production smoke + visual capture.
2. Approve and run the bounded member render plan in batches; verify every
   front/back and a contact sheet, then publish through the existing audience
   rules.
3. Owner Discord desktop/mobile click-through and a second-account spectator.
4. Human Cloudflare Access session for `/platform-admin` and `/_emdash/admin`.
5. Owner aesthetic acceptance of the new palette; the code no longer treats a
   clean detector as approval.

## 2026-11-04 backlog pass — additional reproduced failures and repairs

| Reproduced failure | Repair | Detecting evidence |
| --- | --- | --- |
| Public pool preview omitted `distribution_fingerprint` and collection labels, so the draw room read `undefined.length` and a real draw could not use the approved distribution. | `publicPoolPreview` now returns both fields; a route test draws immediately from the preview. | `route-contract.test.ts` "exposes the exact approved distribution". |
| Studio collections stacked every world and the create form, recreating the endless-scroll complaint. | Search, status filter and 8-row pagination; totals remain real. | `test:ui` Studio collections at light/dark/mobile; `AdminCollections.tsx`. |
| NPC lounge used a definition list with nested wrappers, failing axe `definition-list`/`dlitem`. | Direct `dt`/`dd` structure per row, labelled NPC/You bars. | `test:ui` NPC lounge light/dark/mobile. |
| The public OG still was the smallest poster, causing copy/footer collision and a stamp hidden behind the card. | Compact OG layout and a raised stamp; regenerated all showcase stills/videos. | `public/media/showcase/og-1200x630.png`. |
| Admin intro read "Bot-scoped authority for cabinet." | "Bot-scoped authority for this cabinet." | `AdminLayout.astro`. |
| Existing artwork editions could not be revised from the editor. | Optional source edition prefill creates a new immutable edition with `parent_edition_id`; originals/copies are untouched. | `render-composition.test.ts`; artwork editor suite. |
