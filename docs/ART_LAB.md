# Foilbury Art Lab

Status: implemented as an operator-only surface on `/studio/art` and
`/platform-admin/art`. Current owner decision (2026-11-10): **whole-card AI is a
first-class card method and the default.** The earlier "never generate a whole
card" rule is superseded for this lab. The shared card renderer is retained as a
comparison method, not as a mandatory gate.

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

| Method             | What the provider generates                                | How the candidate is shown                                             |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `whole_card`       | The complete 5:7 card from the real-source reference sheet | The generated card, scaled to 750×1050 and reviewed at 750/400/214/128 |
| `composed_scene`   | Scene or key art only                                      | Comparison: composed card front/back through `art/card-render.mjs`     |
| `composed_texture` | Background or texture plate only                           | Comparison: composed card front/back through `art/card-render.mjs`     |
| `raw_art`          | A standalone brand asset                                   | Raw asset; type, layout and marks stay in code                         |

`whole_card` is the production method and the default for Cards. GPT Image 2.6
Sunburst is the default model; FAL `fal-ai/bytedance/seedream/v4/edit` is the
reference-guided FAL alternative. FLUX Pro 1.1 Ultra and Seedream v4 Text are
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

## All art

`/studio/all-art` is the single visual shelf for every art asset the operator
can inspect: Art Lab card candidates, published card renders where they are
already in the Art Lab, the seven distinct icon directions, four Keeper mascot
concepts, twelve card-style studies, wordmarks, OG, banners, shareables and
other brand files. It is a dense 2/3/4/8-column grid with one title line and
one metadata line; icons use a small 8-column shelf rather than a hero tile.
The same shared viewer opens every item, with arrow-key paging inside the
current filter.

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
- No paid provider call was made for this change.
