# Foilbury Art Lab

The Art Lab is an operator-only surface on `/studio/art` and
`/platform-admin/art`. Layered composition is the default for cards. Flat
whole-card output is available for comparison. See [the card layer system](CARD_LAYER_SYSTEM.md).

## Why this exists

The previous loop sent one card to chat and asked the owner to react. That is
too slow, produces one option, and hides the real differences between methods.
The Art Lab creates a brief, generates several bounded options, shows them at
real sizes, records durable feedback and keeps approval separate from publish.

## Surfaces and authority

| Surface               | Purpose                                                         | Authority                                                                      |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/studio/art`         | Card art for a Bot or assigned global collection                | Bot Owner/Admin or Global Collection Admin, live role checked on every request |
| `/platform-admin/art` | Icons, logo, OG images, shareables, banners and other brand art | Cloudflare Access plus the explicitly provisioned Super Admin                  |

A Global Collection Admin sees only assigned collections and cannot approve a
public direction. A Bot Owner cannot approve public or brand art. Cloudflare
Access admission is authentication, never a Foilbury role.

The Art Lab is never linked from a player surface and has no draw, wallet or
public-route entry point.

## Methods

| Method             | What the provider generates                                                         | How the candidate is shown                                             |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `whole_card`       | A flat 5:7 card from the reference sheet (comparison only)                          | The generated card, scaled to 750×1050 and reviewed at 750/400/214/128 |
| `composed_scene`   | Scene or key art                                                                    | Layered front and back with an inspectable stack                       |
| `composed_texture` | Background or texture plate only                                                    | Comparison: composed card front/back through `art/card-render.mjs`     |
| `raw_art`          | A standalone brand asset                                                            | Raw asset; type, layout and marks stay in code                         |

`composed_scene` is the production default for Cards: the AI generates the
scene, the real subject and the supplied mark are layers, `art/compose.mjs`
stacks the material, frame and effect masters, and exact code-set type sits on
top. A flat `whole_card` is a comparison method only. `composed_texture` is the
same stack with an AI texture plate instead of a scene. GPT Image 2.6 Sunburst is the default model; FAL
`fal-ai/bytedance/seedream/v4/edit` is the reference-guided FAL alternative. FLUX Pro 1.1 Ultra and Seedream v4 Text are
available for scene/comparison methods. The runner prepares a **reference sheet** from the
real subject art, the supplied collection mark, the current live card and the
exact copy (name, role, collection, rarity, finish, print code and provenance).
OpenAI receives it through `/v1/images/edits`; FAL receives it through its image
reference field.

A whole-card candidate is labelled **Whole-card AI · reference-guided**; a
composed candidate is labelled **Composed card · not an AI image**. The review
board never hides which method produced the object. A card with gibberish,
invented text or missing card structure is a failed card, not a stylistic
variant.

## Data

Migration `migrations/0033_art_lab.sql` adds:

- `fb_art_briefs` — category, collection/card/target finish, title, intent,
  references, audience, status, candidate count, provider, model, methods,
  output sizes, notes and per-brief ceiling.
- `fb_art_jobs` — one bounded request per method with estimate, actual spend,
  cost source, claim state and failure reason.
- `fb_art_candidates` — raw asset, front/back/master/preview/thumb assets,
  label, prompt, seed, model, dimensions, SHA-256, audience, `official:false`
  and status.
- `fb_art_feedback` — durable comments, tags and decisions.
- `fb_art_approvals` — a direction approval and, separately, the publication
  target, previous-render snapshot and rollback state.
- `fb_art_spend` — a read-only daily spend view used by the cap.

Bytes reuse `fb_assets` and R2. A candidate is never rewritten in place; a
regeneration creates a new job and new candidates.

## API

All paths are under `/api/v1/studio/art` for the Studio and
`/api/v1/admin/art` for the Access-protected brand surface. The Studio path is
an alias in the main dispatcher; the module performs the live authority check.

- `POST /briefs`
- `GET /briefs/:id`
- `POST /briefs/:id/generate`
- `POST /jobs/claim`
- `POST /jobs/:id/candidates` (multipart; runner only)
- `POST /jobs/:id/complete`
- `POST /jobs/:id/fail`
- `POST /candidates/:id/feedback`
- `POST /candidates/:id/approve`
- `POST /candidates/:id/reject`
- `POST /candidates/:id/publish`
- `POST /candidates/:id/render`
- `GET /candidates/:id/file?side=display|raw|back|master|preview400|thumb128`
- `POST /approvals/:id/rollback`
- `GET /agent` — read-only export of briefs, candidates and feedback for an
  agent grant with `content:read`.

MCP tools: `foilbury_art_briefs`, `foilbury_art_brief` and
`foilbury_art_feedback`.

## Generation runner

The browser never holds provider keys. The worker queues a job; the local runner
claims it, builds the reference sheet, calls exactly the recorded provider/model,
uploads bytes and records what it observed.

```sh
pnpm art:dry            # inspect queued prompts without claiming or spending
pnpm art:run            # process one queued job
pnpm art:run --limit=2
node scripts/art-lab-runner.mjs --job=<job-id>
```

For whole-card card jobs the runner downloads the real subject asset, the
supplied collection mark and the current live card, renders a 5:7 reference sheet
with the exact copy, and sends that sheet to the provider. OpenAI uses
`/v1/images/edits`; FAL Seedream v4 Edit uses `image_urls`; the sheet is also
stored privately on the candidate for review.

The runner parses the project `.env` explicitly and prefers it over an inherited
shell `OPENAI_API_KEY`/`FAL_AI_API_KEY`. A stale shell key must not silently
override the project configuration.

The runner is not deployed with the Worker. To process production jobs, use the
existing trusted production-agent and Cloudflare Access service-token workflow
from `docs/AGENT_GUIDE.md`; point `FOILBURY_URL` at production and supply the
agent token and Access headers through the private runtime environment. Never
put those values in the repository, payloads or logs.

There is no fallback provider. A missing key fails the job before a call; a
provider error fails the job with the provider reason and records the estimated
spend already attempted. The runner never tops up a balance.

## Cost

The price table lives in `src/server/modules/art-lab.ts` and is shown in the
brief form. It is a planning estimate, not an invoice. The queue reserves the
estimate and the runner records the actual observed spend.

- Per brief: default US$2.00, minimum US$0.50, maximum US$20.00.
- Daily: US$10.00 hard stop across the tenant.
- A queued job that would exceed either ceiling is refused before a provider is
  called.
- Failed jobs keep their recorded spend; the index shows estimated and actual
  amounts.

## Review and publication

- The index is an image-first proof wall, not a text dashboard: a Pinterest-like
  masonry of card candidates with a compact board chip rail, small captions and
  progressive disclosure for creation. Studio and platform share the same
  surface.
- Review board: 4–8 candidates by default, 300 px contact sheet, compare at
  750/400/214/128, filters by status, model, method and feedback tag,
  multi-select and keyboard navigation.
- Brief intent, job history and candidate metadata are disclosed only when
  needed. The work leads.
- Feedback tags: `too-busy`, `wrong-palette`, `wrong-face`, `too-generic`,
  `text-unreadable`, `flat-material`, `composition`, `keep`.
- Approve means "this is the direction". It records usage, notes and, for logo,
  a vector source. Publish is a separate action with a typed `PUBLISH`
  confirmation.
- Cards publish through the existing `fb_variant_renders` /
  `fb_variant_back_renders` pipeline. The previous rows are snapshotted and can
  be restored with the rollback action.
- Brand publish copies the approved bytes to a `brand` asset with public
  provenance and records the approval. A logo cannot be approved or published
  without a reviewed vector source.
- Public card/brand publication requires the provisioned Super Admin.

## Local verification (2026-11-10)

- Migration `0033_art_lab.sql` applied to the local D1 database.
- API exercised locally with the owner agent grant: create card brief, queue two
  methods, claim a job, upload a candidate, record feedback, shortlist, approve,
  publish through `fb_variant_renders`, and roll back the publication. The
  variant render and its `preview`/`thumb` derivatives were created.
- Brand surface exercised locally with the owner session: create an icon brief,
  queue raw art, upload a candidate, approve, publish a new public brand asset
  and keep the source asset separate. The brand publish path requires recent
  strong authentication; the local session was upgraded only for verification.
- The player agent grant receives `403 art_read_forbidden`.
- Studio and platform review surfaces were inspected at 1440 and 390 with no
  horizontal overflow. Compare sizes 750/400/214/128 render correctly.
- `pnpm check` and `pnpm build` pass.
- **No paid provider call was made in this verification.** A local fixture image
  was uploaded to exercise the review and publication pipeline. The fixture is
  not presented as generated artwork and is not part of the shipped source.

## First real provider comparison (2026-11-10, local)

A bounded real comparison was run on the local Art Lab, not production:

- Brief: `Aki · real method comparison`; FAL `fal-ai/flux-pro/v1.1-ultra`;
  one `whole_card` candidate and one `composed_scene` candidate; US$0.12 actual
  spend recorded.
- **Whole-card FLUX output:** a moody rain poster with a silhouette. It had no
  card frame, no collection identity, no rarity/finish treatment and its small
  lettering was model-authored gibberish. It was not a finished 5:7 card object
  and should not be published.
- **Composed output:** a real card object with the exact `Aki Hayakawa` name,
  `CHAINSAW MAN · PUBLIC SAFETY`, `RARE`, `PLAIN` and provenance. It remained
  legible at 214×300. This collection still uses the pre-v2 Chainsaw Man livery,
  so the aesthetic is not the v2 proof language.
- Conclusion: whole-card AI is now testable, but FLUX did not honour the card
  contract. The JS renderer is not the only problem; the model did not produce a
  card. GPT Image 2.6 is the default next test for layout/text adherence. The
  first OpenAI attempt used a stale `OPENAI_API_KEY` inherited from the
  developer shell and failed `401 invalid_api_key`; the project `.env` key
  returns 200 and the runner now prefers `.env` over the shell. The failed job
  recorded US$0.05 and made no fallback call.

The Art Lab is deliberately built to keep both methods side by side. The owner
can now judge a model's whole-card output against the composed object instead of
arguing from one chat image.

## Reference-guided GPT Image 2.6 result (2026-11-10, local)

A second bounded real run used the production direction:

- Brief: `Aki · reference-guided whole card`; OpenAI
  `gpt-image-2.6-sunburst`; two `whole_card` candidates; **US$0.10** recorded.
- The runner prepared a 5:7 reference sheet from the real Aki subject art, the
  supplied `CS` collection mark, the current live card and the exact copy
  (name, role, collection, rarity, finish, print code and provenance).
- Both candidates returned as **finished 5:7 card objects** with exact copy and
  no gibberish. Candidate 2 was checked at 214×300: `Aki Hayakawa`, `RARE`,
  `PLAIN`, the collection and the print code remain readable.
- This is the method now selected by default. The remaining judgement is
  aesthetic, not structural: the owner still decides whether the result clears
  the card bar, and no production publish has been made.
- Operational fix: the first OpenAI failure came from a stale
  `OPENAI_API_KEY` inherited from the developer shell. The project `.env` key
  returns 200; the runner now parses `.env` explicitly and prefers it over the
  shell.

A FAL Seedream Edit run also completed two reference-guided cards for US$0.06.
Candidate 1 kept the exact copy and a clean card structure; candidate 2 had
duplicated/malformed small type. This is why the review board requires a
candidate-level decision and why GPT Image 2.6 is the default.

## Production verification (2026-11-10)

- Pre-change D1 JSON backup:
  `.foilbury/backups/d1-2026-11-10T11-32-27-602Z.json` (97 tables, 51,364 rows,
  SHA-256 `571036f6a5f03c7f74ea0b32372991a0fde525809542c073d9b53dd0328ef41c`).
- Migration `0033_art_lab.sql` applied to production D1 after the backup. The
  new tables are empty; no existing card, asset, collection, audience, serial,
  inventory or ledger row was changed.
- Production release source `f6f92eda780b501215057c983f0585d7223c3cae`;
  deployment `7625b6ba-848b-4689-869d-811ded1a756e`; receipt
  `.foilbury/evidence/release-receipt-f6f92eda780b-6071e6fc-9920-48d9-9f5b-f7c6cebb62f2.json`.
- Signed-in `/studio/art` was loaded in the real browser: the page, Art Lab
  component, empty state, New brief control, category rail and bundled pending
  count script all loaded. The live API calls to `/api/v1/studio/art`,
  `/options` and `/count` returned successfully.
- `/platform-admin/art` is Access-protected. The production browser session was
  asked to re-authenticate to the platform Access application; the live
  Access-gated brand journey is therefore **not claimed** here. The shared
  surface and brand controls were exercised locally.
- No production brief, candidate or paid generation was created. The live
  card-publish journey remains to be exercised with a real owner-selected brief.

## Limits

- Whole-card AI can misspell type, invent a mark or produce a weak information
  band. Inspect at 400 and 214 px, and do not treat a clean build or HTTP smoke
  as visual acceptance.
- The FAL balance is treated as bounded. The runner does not auto-top-up.
- The composed methods depend on local `sharp`/`resvg` and the existing card
  renderer; they are a comparison path, not the default.
- The Art Lab is not a second CMS and does not own journal media. EmDash remains
  the editorial surface.

## Named card styles (2026-11-11)

Card styles are art directions, not finishes. Plain, Silver, Gold and
Holographic stay the material finishes of a print. The catalogue is fixed in
`src/lib/card-styles.ts` and shared by the server, the Art Lab and the brand
shelf:

| Key         | Direction                                                          |
| ----------- | ------------------------------------------------------------------ |
| `atelier`   | Art-led portrait on a deep plinth, cream type, foil edge (default) |
| `cinematic` | Subject inside a rain-lit scene, anamorphic light, deep shadow     |
| `editorial` | Bright studio spread, generous paper margin, crisp neutral light   |
| `archive`   | Catalogue record on aged paper, ink rules, sepia tone              |
| `manga`     | High-contrast ink, screentone, dynamic diagonal crop               |
| `minimal`   | Empty warm paper, small figure, one foil-blue rule                 |

- Migration `0034_card_styles_and_brand_selections.sql` adds
  `fb_art_briefs.style_keys_json`, `fb_art_jobs.style_key`,
  `fb_art_candidates.style_key`, `fb_art_approvals.style_key` and
  `fb_variant_renders.style_key`.
- A brief can select one to four styles. `createArtBrief` stores them; the
  default comes from the platform brand selection (Atelier unless changed).
- `queueArtGeneration` splits the candidate count across both methods and
  styles, so a two-style, two-candidate run creates one job per style with one
  candidate each. The cap check uses the same split.
- `addArtCandidate` records the job's style on the candidate and in its
  provenance metadata. The runner's reference sheet prints the chosen style.
- Approval records the style on `fb_art_approvals`; publish passes it through
  `createRenderAsset` to the live `fb_variant_renders` row.
- The Art Lab index and candidate wall show the style on each pin and filter
  by style, including an `Unstyled` state for candidates generated before the
  catalogue existed. The New brief picker shows all twelve directions as
  thumbnails; the rail scrolls horizontally. The brief header names the selected styles, finish,
  model, status and spend without a paragraph.
- Member card queries read `vr.style_key`, so the card detail and shared viewer
  name the style. Ownership and serials do not change.

## One shared card viewer

`src/components/cards/CardViewer.tsx` is the only card dialog. It is used by:

- `/studio/art` candidate pins and the review wall;
- `/studio/prints` print proposals and printed editions;
- `/platform-admin/art` brand files, icons, mascots and card-style previews;
- `/studio/all-art`, the dense all-art shelf;
- `/play/cabinet`, `/play/collection`, `/play/collections` and the card binder;
- `/play/card/[id]` through the inspector's Expand action and variant previews;
- the catalogue saved-render reference, the catalogue table thumbnails and the
  Render Studio card faces under `/admin`.

The card object is the trigger. The dialog shows the saved 750×1050 front and
the saved back where one exists, with a master link, Download as a separate
action, front/back tabs, arrow-key paging, Enter/Space activation, Escape close,
a focus trap, visible focus and a reduced-motion fallback. On phones it is a
full-screen sheet; on desktop a centred viewer with a facts rail. It never
recomposes private source layers.

## Thumbs and comments

Every card candidate is reviewable with a single thumb:

- **Keep** records a durable `like` feedback row and shortlists the candidate.
- **Not this** records a durable `dislike` feedback row and moves it to
  `needs_revision`. A comment is optional; the older `needs_revision` and
  `reject` decisions still require a note.
- The same thumbs are on each candidate tile and in the shared card viewer,
  with a live count and an optional comment box. The viewer saves the comment
  with the thumb, so the next person can read why the direction was kept or
  rejected. The candidate panel's feedback thread renders the saved decision,
  tags, author and comment.
- Approved and published candidates cannot be re-rated; the existing approval,
  rejection and rollback actions stay separate. The server enforces the same
  rule for every surface.

The decision values are `like`, `dislike`, `comment`, `shortlist`,
`needs_revision` and `reject`; the API and the durable `fb_art_feedback` ledger
are the source of truth, not the browser state.

## Art review wall

Open **Studio → Art review wall** at `/studio/all-art` for an image-first view
of scoped card candidates, current collection banners and marks, and the
existing brand and card-style studies. Filter by artwork type, collection or
grade. **Favourites** shows grade 5. The full-size viewer keeps face switching,
copying, and paging within the current view.

Each artwork can carry a private grade (1 to 5) and an optional private note.
The server saves these per account and Bot workspace, separately from shared
candidate feedback. A grade or note does not change an Art Lab decision,
collection, issued copy, or publication. Shared thumbs still go through the
candidate feedback route from the viewer. Use **Open brief** for the full
discussion and existing approval and publication controls.

The platform Art Lab now exposes **Mascots** as a real category alongside
Icons, Logo, OG images, Shareables, Banners and Other art. The six new icon
directions (folded F, Keeper owl, card fan, archive drawer, foil seal, signal
aperture) are selectable as the site icon; the four Keeper concepts are
Wedding, Fairy, Gothic and Neon.

## Brand asset catalogue and selection

`src/lib/brand-catalogue.ts` is a typed view of the files that actually ship
under `public/`. `/platform-admin/art` shows the real favicons, wordmarks, Open
Graph images, banners, shareables, card styles and other brand art; tiles open
the shared viewer and each slot has one explicit action.

- Slots with live consumers: `favicon` (BaseLayout icon links), `og_image`
  (BaseLayout default Open Graph and Twitter image) and `card_style` (Art Lab
  brief default).
- Banners and shareables are browsable, previewable and downloadable; the
  selected banner is recorded as the preferred export. The Discord application
  cover remains a separate Discord endpoint action.
- Selections live in `fb_brand_selections` and are validated against the
  catalogue. The write requires the provisioned Super Admin, a signed-in human
  and recent strong authentication; the read is a normal page dependency.
- The platform page and `/api/v1/admin` are separate Cloudflare Access
  applications. The platform browser therefore uses the page-aligned
  `/platform-admin/art-api/*` transport, which performs the same CSRF check and
  calls the one Art Lab module. It is not a second authority surface; the page
  still requires Access and the module still requires the provisioned Super
  Admin. The Studio surface keeps `/api/v1/studio/art`.
- New Foil Standard Open Graph and banner variants are composed by
  `art/brand-variants.mjs` from the real mark, wordmark, type and palette. The
  historical Signal Fold shareables are not presented as current identity.

## Candidate variation (2026-11-11)

One provider call with the same prompt produced four near-identical cards. The
runner now sends a distinct composition directive and label with each candidate
in a card run: **Centered hero**, **Low angle**, **Close crop**, **Wide scene**,
**Graphic**, **Editorial** for whole-card; **Establishing**, **Low angle**,
**Environmental detail**, **Graphic** for layered scenes. The exact copy,
subject identity, mark and card contract stay unchanged; only composition
changes. The live `Tux · Neon variation study` shows four visibly different
cards and retains the per-candidate thumbs.

The first layered `composed_scene` proof now records its ordered stack in
candidate metadata: AI scene → real subject → material → frame → AI
holographic effect → exact code type. The Art Lab shows the stack with
thumbnails and blend/opacity and opens each layer in the shared viewer. The
proof is intentionally not published yet: the legacy subject cutout, card frame
and information band are weaker than the whole-card comparison, so the layer
masters need the same quality bar before a layered card replaces a live render.

## Production card proof: Tux · Neon signal keeper (2026-11-11)

A real whole-card run was made against production after the twelve-style
release:

- Brief `artb_mwautj8n2q2knsv183qs0z8a`, candidate
  `artc_mwauw3w8vxm8adqdfmqyqqrd`, style `neon`, model
  `gpt-image-2.6-sunburst`, four candidates, **US$0.20** recorded by the
  runner.
- The runner prepared the real Tux subject reference and exact copy. The
  selected front reads `Tux`, `RARE`, `Root access`, `Fighter`, `PLAIN`,
  `FB-F-005` and `PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT`.
- The front was inspected at 750, 400, 214 and 128. Candidate 3 carried a
  `FOILBURY · CARD REFERENCE` artefact and was rejected. Candidate 2 was clean
  and selected. No gibberish, fake serial, invented logo or watermark.
- A separate AI back was generated with the same exact copy and a designed
  record; it was cropped to 5:7 and attached to the candidate through the
  render endpoint. It was inspected at 750, 400, 214 and 128.
- The candidate was approved by Dean and published to the Tux Plain variant
  `var_mvyy31qvaahfz5gc6bcks0dk` with `publishBack: true` through the trusted
  production agent. New front asset `rnd_mwav6i5ovj5fhvmyjc756eda`, new back
  `rnd_mwav6imqxn4r6f39jw3ccz0y`; previous front/back snapshotted for rollback.
- Live `/cabinet/tux` served the new front and back at 1440; the public card
  page's front/back switch worked. Only the Plain variant was replaced; the
  other finishes and prints keep their existing renders.
- The selected Neon frame is prismatic while the variant label is Plain. This
  is the named Neon style frame, not a second finish claim; future Neon
  prompts should keep the requested finish material explicit.

## Layered v3 production card and collection display (2026-11-11)

The flat whole-card proof above is now the comparison, not the production
method. The Tux Plain and Holographic variants were replaced with the layered
v3 object from `art/card-v3.mjs` and `docs/CARD_LAYER_SYSTEM.md`:

- Front: AI Neon scene, AI Tux cutout with a real alpha edge and feet breaking
  into the field-record panel, authored ink/foil frame with a true art window,
  a Neon holographic edge layer on Holographic only, and exact code-set name,
  role, rarity, finish, print code and provenance.
- Back: authored record with header, portrait plate, short bio, field record,
  provenance, credits and the Fighter set mark. It is not a second front.
- Plain brief `artb_mwayl9respjw3neqe27sba1z`, candidate
  `artc_mwayo9rar16j9xddf2qmkb35`, assets `rnd_mwaylpf3pkjskb19qpfwp2sh`
  (front) and `rnd_mwaylpn7b7xhrkkr64aw96at` (back).
- Holographic brief `artb_mwawjmqmm63pac3yhddd5a83`, candidate
  `artc_mwaynqqx1pfqyqrvafj87bsa`, assets
  `rnd_mwaynsqza2kqfxfwbpq2v7c0` (front) and
  `rnd_mwaynszsdkeh5pvyzef5e2ha` (back).
- Both were inspected at 750, 400, 214 and 128. The public page opens on the
  strongest published finish, and the finish chooser names each finish once.
- Source `98f4ac8`, Worker `82e9e6ba-a38c-4b7b-b3b1-8c27b08a65b1`. Receipt
  `.foilbury/evidence/card-v3/publish.json`.

The collection display moved with it:

- Binder is a centred page with a ring gutter and pocket shadows. It is 960px
  wide with three 292px columns at 1440 and two 160px columns at 390; there are
  no per-slot Inspect buttons.
- The pinned cabinet card is 403px at 1440 and 260px centred at 390, with a
  contact shadow and a single-column display.
- The shared viewer adds a paper mat, removes the image border, raises controls
  to 44px, and carries `aria-modal` plus a labelled title.
- The Impeccable detector at 1440 and 390 leaves only the existing Geist Sans
  advisory: no undersized functional text, no orphaned lines.

Remaining: only Tux Plain and Holographic use v3. Silver, Gold and the rest of
the catalogue still use their previous renders until each character gets its
own layered pass.

## Card experience production verification (2026-11-11)

- `pnpm check` passed (types, unit, workers, script, API inventory).
- The Art Lab was inspected at 1440 and 390: style rail, proof wall, compact
  brief header, candidate facts, reference sheet link, exact copy and the
  compare tray. A verification brief stored `atelier + cinematic`; queueing
  created one job per style and both jobs were cancelled without a provider
  call or spend.
- The same viewer opened from an Art Lab pin, a Print Studio proposal and print
  edition, a platform brand file, the cabinet pinned copy, a binder slot, the
  collection copy list and the card detail Expand action. Escape closed it and
  returned focus to the trigger; arrow keys moved between siblings; Tab stayed
  inside the dialog; reduced motion removed the entrance animation.
- No horizontal overflow at 1440 or 390 on `/studio/art`, `/studio/prints`,
  `/platform-admin/art`, `/play/cabinet`, `/play/collection`,
  `/play/collections` or `/play/card/[id]`.
- The brand selection write was exercised locally after a simulated recent
  step-up: selecting `og-ink` changed the layout's Open Graph image; the local
  selection was then restored to the shipped default.
- Pre-change D1 JSON backup:
  `.foilbury/backups/d1-2026-11-10T14-25-51-357Z.json` (102 tables, 51,364
  rows, SHA-256
  `350109033073f83c84d16d99e0a4f0b188112f8a90f8bf701e33bc424be639b3`).
  Migration `0034` was applied to production after the backup; it only added
  the style columns and `fb_brand_selections`.
- First production source `9b16197c974bc1cc9659ce72af751cb95c974f66` (Worker
  `9a008ded-eaab-4aca-9d31-2a36316f59c1`) propagated one polling window after
  the release script's 60-second check; a fresh `test-deployed.mjs` run passed
  for that build afterwards. The final admin-preview coverage is source
  `00bc703d4c422e0d038102f9174119f3901e0945` (Worker
  `8755e52f-91dc-47d3-883c-4ab317575971`), verified by the release script.
- Live signed-in `/platform-admin/art`: the real favicon, wordmark, OG,
  banner, shareable, card-style and other-brand catalogues loaded at 1440 with
  no alert; a fresh Access session selected the already-live mark as the site
  icon through the page-aligned transport (200, no visual change).
- Live signed-in `/studio/art`: the style rail, `Unstyled` state, compact empty
  wall and New brief form loaded at 1440 and 390; the form exposed all six
  style thumbnails with Atelier active. Production has no card briefs or
  candidates, so the live candidate viewer was not exercised with production
  art.
- Live signed-in `/studio/prints`: the Tux proof wall showed four approved
  prints and the shared viewer opened from the wall at 390; `/play/cabinet`,
  `/play/collection` and `/play/card/[id]` opened the same viewer from owned
  cards at 1440 and 390, including the saved back and provenance.
- Live signed-in `/admin/catalogue` and `/admin/design`: the catalogue saved
  render, table thumbnails and Render Studio card faces opened the shared
  viewer at 1440 (four variants paged in the same dialog).
- Final live source for the art shelf and thumbs:
  `1a65fbf782d9dbf731a3d5893b40211b0c593070` (Worker
  `a7badb01-2ea9-4a51-a5c4-3e46d9713b78`). The live Tux brief showed four
  candidate tiles with eight thumb controls; the viewer showed **Your read**
  with Keep/Not this, a comment box and live counts. A real comment and keep
  were saved and read back from the feedback ledger.
- Art expansion spend: US$0.60 actual across the first Tux run, the variation
  study and the layered holographic proof, plus an estimated US$0.20 for the
  icon, mascot, style and back sheets; total about US$0.80 against a declared
  US$2.00 ceiling. No top-up.
- A layered `composed_scene` proof (`Tux · Neon layered holographic proof`,
  Holographic variant) used an AI holo texture at 0.34 screen opacity and exact
  code type. It is in the Art Lab as a proof, not published: the legacy subject,
  frame and information band still look weaker than the whole-card comparison,
  so the layer masters need the same quality bar before layered replaces the
  flat card in production. The default method and labels are now layered; the
  next work is premium scene, subject, frame and effect masters.
- The new production assets are served from `/art/icons/`,
  `/art/mascots/` and `/art/styles/`; the platform catalogue exposes seven
  distinct icon directions and four Keeper mascots, and `/studio/all-art` is
  live with 51 pieces (4 card candidates, 7 icons, 4 mascots, 12 styles, 5
  logos, 5 OG, 4 banners, 4 shareables, 6 other).

## Studio art resources

From Art Lab, open **Resources** to browse credited museum reference prints, find sources on GitHub and Hugging Face, or copy the scene brief into Codex. The resource page and its bundled image responses use the ordinary Studio role gate. Copy image writes a PNG of the selected image or card face. Download remains available alongside it.

| Reference | Institutional record | File source |
| --- | --- | --- |
| Under the Wave off Kanagawa, Katsushika Hokusai, 1830/33 | [Art Institute of Chicago, 24645](https://www.artic.edu/artworks/24645) | [CC0 scan](https://commons.wikimedia.org/wiki/File:The_Great_Wave_off_Kanagawa.png) |
| Water Lilies, Claude Monet, c. 1922 | Toledo Museum of Art | [Public-domain reproduction](https://commons.wikimedia.org/wiki/File:Claude_Monet_-_Water_Lilies_-_Google_Art_Project.jpg) |
| The Child's Bath, Mary Cassatt, 1893 | [Art Institute of Chicago, 111442](https://www.artic.edu/artworks/111442) | [Public-domain reproduction](https://commons.wikimedia.org/wiki/File:Mary_Cassatt_-_The_Child%27s_Bath_-_Google_Art_Project.jpg) |

### After the Tide

- Created 2026-11-12 with the native Codex ImageGen tool. The tool did not expose the exact model version or seed. One native invocation, no separately billed provider API call, no per-image cost reported.
- Reference: the CC0 Hokusai scan above. Reference PNG SHA-256 `47d533bf3b8be3e7d8f11c2aae23fb8089fb2002676e9f6bad6a9829df48b34b`.
- 1536×1024 PNG master, SHA-256 `f619ff52276f6fcffff8d63ad853c652965f6d2d87ce6ea1b283ee33533b2be4`. Studio WebP SHA-256 `6ac5e8532b76e4c7c62c393ae10937ea3614e1efd608cf52882c7a01d224a4c5`.
- Audience: scoped Studio. `official:false`. Status: reference study for a scene layer, outside the published card catalogue.
- Exact generation prompt:

> Generate one original landscape environment plate for Foilbury Studio, title in our catalogue is After the Tide (do not draw the title). Use the supplied Katsushika Hokusai public-domain woodblock scan only as a reference for indigo ink, paper grain, and asymmetrical silhouette. An empty remote basalt coast at first light: steep dark ink cliffs anchor the left edge, successive tidal terraces sweep diagonally to the lower right, and a tiny copper dawn opens above still water in the upper right. Open low-contrast midground across the centre for a separately composited character. Striking strong masses, actual woodblock ink registration, restrained midnight navy, oxidised slate and warm paper highlights. Atmospheric original composition. No large breaking wave, no Fuji, no boats, no people, no frame or card mockup, no border, no lettering, no characters, no signature, no seal. Wide landscape 3:2, edge-to-edge. Scene layer only.
