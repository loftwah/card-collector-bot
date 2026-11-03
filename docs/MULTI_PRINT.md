# Multi-print catalogue and review foundation

Status: **foundation only**. Source baseline `a39e2bf`, 2026-11-04. This page
documents the additive domain model introduced by `migrations/0020_multi_print.sql`
and `src/server/modules/prints.ts`. It does not claim that artwork, admin UI,
routes, generation jobs or production data exist yet.

## What this layer does

- Adds print **proposals** and an append-only review history for existing
  subjects.
- Enforces the rule that a print is a genuinely different artwork edition, not a
  finish or a renamed copy of the same image.
- Lets an approved proposal link to one existing artwork edition without
  rewriting that edition, its variants, its renders, its awards or its copies.
- Provides one bounded original-IP vertical slice: three distinct print roles
  for one existing subject.
- Provides a tracked collection-by-collection rollout plan with explicit gates.

It deliberately does **not** create a second card catalogue, edit
`fb_card_definitions`, create `fb_variants`, own `fb_card_instances`, mint
serials, move wallets, run image generation or publish anything.

## Domain hierarchy mapped onto existing D1

| Product concept                 | Existing authority                         | New proposal layer                                                         |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| Collection                      | `fb_collections`, `fb_collection_cards`    | Read only                                                                  |
| Subject/profile                 | `fb_card_definitions`                      | `card_id` foreign key                                                      |
| Approved source artwork         | `fb_assets` + provenance columns           | `source_asset_id`; provenance snapshot in `provenance_json`                |
| Proposed print artwork          | `fb_assets`                                | `artwork_asset_id`; source/rights snapshot                                 |
| Collectable print / art edition | `fb_artwork_editions`                      | `approved_edition_id` link only                                            |
| Finish variant                  | `fb_variants` (material + effect)          | `finish_keys_json` is a proposed availability list, never a print identity |
| Issued copy                     | `fb_card_instances`, `fb_instance_history` | **No representation by design**                                            |

A proposal records the subject, role, stable number/key, title, creative
direction, source and artwork provenance, finish intent, status, reviewer,
revision and timestamps. It is a review record, not a catalogue record.

### Stable identity

- `print_number` is normalised (`1` → `01`, `2a` → `02A`) and unique per
  subject. Numbers are never recycled.
- `print_key` is `<card.logical_id>:<print_number>`, for example
  `test:one:01`. It is unique per Bot and stable across web, API, CLI and MCP.
- The proposal ID is stable for the proposal. Edition IDs and print keys are
  separate: linking an approved proposal does not renumber or replace an
  existing edition.

Card merges are a follow-up integration point: the existing `mergeCards`
workflow moves editions, variants, instances and aliases, but it does not yet
reassign `fb_print_proposals` or recompute their `print_key`. Do not merge a
card that has open print proposals until the reassignment is implemented and
tested; the archived source card otherwise leaves those proposals inaccessible
without deleting review history.

## Print, finish and revision rules

### A new print

A new print must have all of the following:

1. A different artwork asset from every other print of the subject. Asset
   identity is the image SHA-256, so re-uploading the same image under a new ID
   still fails.
2. Its own role and title. Role examples are Portrait, Action/Scene, Alternate
   Art, Special release, Ensemble, Location and Object; they are examples, not a
   universal template.
3. A distinct creative direction: different pose, scene, composition, medium,
   colour story or narrative moment, not a finish/filter change.
4. A stable print number and print key.

### A finish is not a print

Plain, Silver, Gold and Holographic are treatments of one print. Changing only
`finish_keys` on the same artwork, role, title and direction fails with
`finish_is_not_a_print`. A title that is only a finish label (`Gold`,
`Holographic`) is rejected for the same reason. Finish availability belongs to
the eventual edition/variant release, not to print identity.

### Revision versus new print

| Change                                                                                                    | Result                                                           |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Crop, zoom, focal point, typo, frame/back layout, re-render of the same approved artwork and print number | Revision of the same print; keep its ID/number and issued copies |
| New artwork with a different scene, pose, medium or composition                                           | New print proposal; new number and key                           |
| Plain → Gold, extra Holographic availability                                                              | Finish variant of the existing print; not a new print            |
| Rename the same image                                                                                     | Rejected: duplicate artwork                                      |
| Reuse an existing edition's artwork for another "print"                                                   | Rejected: duplicate of the existing edition                      |

The current module supports a rejected proposal being revised in place and
resubmitted. Existing editions already use `parent_edition_id` and
`composition_json` for non-destructive artwork revisions; this layer does not
replace that lifecycle.

## Lifecycle and authority

```text
draft -> proposed -> approved
                  -> rejected -> revised (draft) -> proposed -> ...
```

- `draft` may be incomplete except for a source/identity asset and the core
  fields. It cannot be linked or published.
- `proposed` requires ready, non-rejected artwork plus a source reference, rights
  note or artwork credit.
- `approved` records the human reviewer, review note, timestamp and revision.
- `rejected` requires a review note so the next revision is deliberate. The
  record is revised in place; its print number and key are not recycled.
- Every submission, revision, approval, rejection and edition link appends to
  `fb_print_proposal_reviews` with the proposal revision.

Authority:

- Content managers (Bot Owner, editor, or an agent with `content:write`) may
  create, submit and revise proposals. Players cannot read the review workflow.
- Only a human Bot Owner or platform administrator may approve/reject or link an
  edition. Agents cannot be the reviewer of record.
- Global Collection Admin scoping is not inferred by this foundation. The
  route/UI layer must map assigned collections before enabling review for a
  scoped curator; it must not treat shared-collection curation as platform root.
- The route layer must still enforce recent strong authentication for sensitive
  mutations; the module records the acting user but is not a substitute for the
  session policy.

## Validation and conflict rules

Implemented in `src/server/modules/prints.ts`; covered by
`tests/workers/prints.test.ts`.

| Check                                                 | Failure                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Unknown print role                                    | `422 print_role_invalid`                                 |
| Unparseable print number                              | `422 print_number_invalid`                               |
| Finish-only title                                     | `422 finish_is_not_a_print`                              |
| Creative direction shorter than 40 characters         | `422 print_direction_too_short`                          |
| Missing subject asset / wrong tenant / archived asset | `422 print_source_asset_invalid`                         |
| Invalid source reference scheme                       | `422 print_source_ref_invalid`                           |
| Proposed without usable artwork                       | `422 print_artwork_required`                             |
| Artwork rejected/placeholder/not ready                | `422 print_artwork_rejected` / `print_artwork_not_ready` |
| No source reference, rights note or credit on submit  | `422 print_provenance_required`                          |
| Repeated print number/key                             | `409 print_number_in_use`                                |
| Same artwork under another role/title                 | `409 print_duplicate`                                    |
| Same role/title or near-identical title/direction     | `409 print_duplicate` / `print_near_duplicate`           |
| Finish-only variation                                 | `409 finish_is_not_a_print`                              |
| Reuse of an existing edition's artwork                | `409 print_duplicate`                                    |
| Published/retired edition duplicates approved artwork | `409 print_duplicate`                                    |
| Non-owner reviewer                                    | `403 print_review_forbidden`                             |
| Agent reviewer                                        | `403 print_review_human_required`                        |
| Stale revision                                        | `409 stale_print_proposal_revision`                      |
| Link before approval                                  | `409 print_not_approved`                                 |
| Edition artwork differs from approved artwork         | `422 print_edition_artwork_mismatch`                     |
| Proposal already linked to another edition            | `409 print_edition_already_linked`                       |

Near-duplicate comparison uses finish-stripped tokens, stop-word filtering and
Jaccard similarity. It is a guardrail, not a visual judgement: a human must
still compare the actual artwork. The tests include deliberate negative cases,
including a finish-only restrike.

## Additive edition linkage

`linkApprovedEdition(ctx, proposalId, editionId)`:

1. Requires an approved proposal and a human reviewer.
2. Requires a live edition for the same subject and the exact approved artwork
   asset.
3. Sets only `fb_print_proposals.approved_edition_id` and increments the
   proposal revision.
4. Never updates `fb_artwork_editions`, `fb_variants`, renders, awards or
   instances.
5. Is idempotent for the same edition and refuses a second edition.

A partial unique index prevents one edition from being linked to two proposals.
The additive compatibility test snapshots the original edition, variant count
and instance count before and after linking and asserts they are unchanged.

At approval, published and retired editions are re-checked for duplicate
artwork. A draft edition may be created for composition preview; it is allowed
to remain the intended link target after approval, provided it uses exactly the
approved artwork.

## Original-IP vertical slice

The slice is a plan and a bounded function, not generated art. It uses an
existing original-IP subject and the existing source asset. No official, canon,
licensed or fabricated third-party artwork is implied.

Chosen slice: the first reviewed subject from the existing **Bubbles** original
collection. The actual subject/card is selected from the live catalogue before
running the function; no new identity or lore is invented.

| #   | Role           | Creative direction                                                                       | Proposed finishes                | Artwork status       |
| --- | -------------- | ---------------------------------------------------------------------------------------- | -------------------------------- | -------------------- |
| 01  | Portrait       | Deliberate three-quarter portrait, restrained graphic ground, clear thumbnail silhouette | Plain, Silver, Gold, Holographic | New artwork required |
| 02  | Action / Scene | Different narrative moment, diagonal composition, environmental depth and motion cues    | Plain, Silver, Gold              | New artwork required |
| 03  | Alternate Art  | Full-bleed illustrative alternate with a different medium and colour story               | Plain, Gold, Holographic         | New artwork required |

Flow:

1. Confirm the subject, source asset and identity/likeness pack.
2. Run `originalIpVerticalSlicePlan()` to produce the three working briefs.
3. Source/compose three genuinely different approved artwork assets. This is
   unpaid in the foundation and must not be done without a recorded budget
   ceiling and owner approval.
4. Run `createOriginalIpVerticalSlice()` to persist three `draft` proposals. It
   creates no editions, variants, instances, serials or awards.
5. Review each proposal against the source and the existing prints. Approve,
   reject with a reason, or revise.
6. Create the edition through the existing artwork pipeline and link it with
   `linkApprovedEdition()`. The existing renderer remains authoritative for
   front/back composition.
7. Publish through the existing catalogue/release workflow. This module does not
   publish.

The plan returns explicit review gates for identity/likeness, rights and
provenance, print-versus-finish, 5:7 front/back composition, human approval and
budget control.

## Tracked collection rollout

This is a plan, not a claim of delivered prints. This change ships no print
data: the tracker starts at **0 approved print proposals**. The live subject
census comes from `fb_card_definitions`/`fb_collection_cards`; it is not
duplicated here.

Stages per collection:

1. `CENSUS` — count included subjects and existing editions.
2. `PLAN` — 2–3 genuinely different print proposals per included subject.
3. `ART` — approved original/composed artwork within a recorded budget.
4. `QA` — identity/likeness, rights/provenance, anti-slop and print-vs-finish.
5. `REVIEW` — human approve/reject/revise.
6. `LINK` — approved proposal linked to an edition without touching issued
   copies.
7. `RELEASE` — existing catalogue/pool publication; future work.

| Collection                           | Audience                 | Planned coverage                                             | Status   | Gate / exception                                                               |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------ |
| Bubbles (original IP)                | Public showcase eligible | 3 prints on the first reviewed subject, then 2–3 per subject | **NEXT** | Vertical slice; new artwork and human likeness review required                 |
| Fighter (original IP)                | Public showcase eligible | 2–3 per subject                                              | PLANNED  | After Bubbles; new artwork required                                            |
| Protocol 11 (original IP)            | Public showcase eligible | 2–3 per subject                                              | PLANNED  | After Bubbles; new artwork required                                            |
| Shared Characters (original IP)      | Public showcase eligible | 2–3 per subject                                              | PLANNED  | Shared identity across collections needs explicit source/adaptation notes      |
| NBA — Opening Night                  | Members only             | 2–3 per subject                                              | PLANNED  | Rights/accuracy review; dated 2025/26 facts; no invented endorsement           |
| Chainsaw Man — Public Safety, Part 1 | Members only             | 2–3 per subject                                              | PLANNED  | Part 1 boundary; no later-part spoilers; no copied official art                |
| Madoka Magica — Mitakihara           | Members only             | 2–3 per subject                                              | PLANNED  | TV/Rebellion boundary; one draft profile must stay draft until verified        |
| Danganronpa — Three Killing Games    | Members only             | 2–3 per subject                                              | PLANNED  | Game boundary; spoiler review                                                  |
| NANA — Two Nanas, One Tokyo          | Members only             | 2–3 per subject                                              | PLANNED  | Manga/anime boundary; no invented relationships                                |
| Project Sekai — Unit Stage           | Members only             | 2–3 per subject                                              | PLANNED  | Unit/game context only; do not imitate in-game card editions                   |
| South Park — Town Album              | Members only             | 2–3 per subject                                              | PLANNED  | Content advisory; age-appropriate treatment                                    |
| Rick and Morty — Portal              | Members only             | 2–3 per subject                                              | PLANNED  | Main animated continuity; spin-offs out                                        |
| Vocaloid — Voicebanks                | Members only             | 2–3 per subject                                              | PLANNED  | Distinguish persona, software and voice provider                               |
| The Summer Hikaru Died               | Members only             | 2–3 per subject                                              | PLANNED  | Spoiler gates; two draft profiles stay draft until verified                    |
| Total Drama Island — 2007            | Members only             | 2–3 per subject                                              | PLANNED  | First season only; 2023 reboot out                                             |
| Doki Doki Literature Club!           | Members only             | 2–3 per subject                                              | PLANNED  | Original 2017 VN; early-safe profiles; three drafts need verification          |
| Neon Genesis Evangelion              | Members only             | 2–3 per subject                                              | PLANNED  | TV episodes 1–26; Rebuild differences noted                                    |
| Death Note — The Kira Case           | Members only             | 2–3 per subject                                              | PLANNED  | Late identity spoilers gated                                                   |
| Alien Stage — Stage Lights           | Members only             | 2–3 per subject                                              | BLOCKED  | All eight profiles are draft; no invented outcomes; rights/source review first |
| Scott Pilgrim — Six Volumes          | Members only             | 2–3 per subject                                              | PLANNED  | Comics and 2010 film distinguished                                             |
| The Simpsons — Springfield           | Members only             | 2–3 per subject                                              | PLANNED  | Floating timeline; no dated claims                                             |

### Rollout rules

- A single approved print is **not** a completed multi-print subject. Coverage
  reports `single_print_requires_exception`; the reason and reviewed decision
  must be recorded before the subject is treated as an exception.
- A subject blocked by rights, canon, source availability, quality or content
  constraints gets an explicit `rejected` proposal with a review note and a row
  in this tracker. It is never silently marked complete.
- Do not multiply the catalogue with placeholders, recolours, renamed images or
  finish-only restrikes. The duplicate checks exist to make that fail.
- Do not generate or publish all collections at once. The order is original IP
  vertical slice, remaining original IP, then launch collections by rights and
  source readiness.
- The release print count is not the number of rendered finishes. Two prints
  with four finishes each are two prints and eight finish renders.
- Existing achievements, roster snapshots, serials, receipts and issued copies
  are not recalculated by adding a print.

### Coverage reporting

`printCoverageForCard(ctx, cardId)` returns:

- proposals by status;
- approved prints;
- distinct approved artwork;
- linked editions;
- `minimum_met` (at least two approved prints with two distinct artworks);
- `recommended_third`;
- a label: `not_started`, `planning`, `in_review`,
  `single_print_requires_exception` or `minimum_met`.

A collection-level roll-up is future work; this page remains the human tracker
until it exists. Coverage reports the proposal layer; editions that predate this
layer are not counted as approved proposals. Read it together with the live
edition count when judging whether a subject already has one print.

## Rights, budget and content gates

- Original-IP art is Foilbury original work and must still record the source
  asset, creator/model/tool disclosure where applicable, and the human reviewer.
- Third-party collections are members-only. Sourced references keep their
  attributed provenance. No official affiliation, licence or endorsement is
  claimed. No watermark stripping, scraped unlicensed media or counterfeit
  trading-card design.
- No paid generation was run for this change. Any generation batch requires a
  recorded bounded ceiling, owner approval and cost evidence. fal.ai is the
  preferred provider; OpenAI remains an optional fallback, not a silent retry.
- Never depict minors in sexualised or age-inappropriate themes. Use content
  advisories and family-friendly options where relevant.
- Unreviewed, rejected, placeholder or source-unverified artwork cannot be
  approved or published.

## Verification

Local, against the source baseline:

```sh
pnpm exec vitest run --config vitest.workers.config.ts tests/workers/prints.test.ts
# 1 file passed, 7 tests passed

pnpm exec astro check
# 0 errors (pre-existing hints only; no new type errors)
```

The tests cover proposal creation validation, duplicate/near-duplicate and
existing-edition rejection, human approval/rejection/revision, stale revisions,
additive edition linkage, finish-only rejection, the original-IP vertical slice,
coverage labels (including the single-print exception), and the absence of
inventory ownership in the proposal layer. They use local Workers D1; no
production or provider call was made.

## What remains

- **API/route integration**: `src/server/api/router.ts` is untouched. REST
  routes, OpenAPI, scoped Studio endpoints, CLI and MCP tools still need
  explicit contracts.
- **Admin UI**: collection → subject → prints comparison queue, contact sheets,
  side-by-side source/candidate views, approve/reject/revise controls, cost and
  queue state, mobile/keyboard/accessibility work.
- **Agent-assisted sourcing/production**: fal-first adapter registry, reference
  conditioning, identity/likeness packs, candidate jobs, budgets, retries,
  cancellation, provider diagnostics and private media handling.
- **Artwork and render pipeline**: real distinct art for the vertical slice,
  front/back composition, 5:7 crop validation, Discord thumbnail checks and
  finish variants.
- **Edition/release workflow**: create/link editions through the existing
  pipeline, publish/release rules, rollback and retirement.
- **Card merge/alias migration**: reassign proposals and recompute or preserve
  stable print keys when two subjects are merged; do not delete review history.
- **Collection rollout tooling**: collection-level coverage roll-up, exception
  register and budget evidence beyond this manual tracker.
- **Quality gates**: real browser journeys, Playwright/axe, mobile/200% zoom,
  render and thumbnail inspection, performance and privacy checks.
- **Production**: inspect live state, take a D1 JSON backup, apply the additive
  migration, smoke-test, and obtain deployment approval. A local pass is not a
  deployed revision.
