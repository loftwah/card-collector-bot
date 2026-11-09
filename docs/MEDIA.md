# Media, artwork and rendering

## Geometry and delivery sizes

The established card geometry is 5:7. Delivery renders are **750×1050**;
masters and source layers are authored larger where the source supports it
(subject layers are prepared at 1200×1600 and backgrounds at 1600×2000, then
composed down).

| Use | Size | Format | Target |
|---|---|---|---|
| Album thumbnail | 300×420 | WebP | ~80 KB |
| Medium preview | 600×840 | WebP | ~200 KB |
| Card detail / Discord | 750×1050 | WebP | under 1 MB |
| Collection mark | 512×512 | PNG | small |
| Collection cover | 1600×900 | PNG | under 400 KB |
| Card back | 750×1050 | WebP | under 1 MB |

The launch renders measured 31–53 KB per side in local acceptance, well inside
the targets. No upscale is used to claim detail the source does not have.

## Layers and recipes

A card is composed from retained source layers:

1. background / scene
2. subject or cutout
3. material
4. frame
5. effect
6. exact text, labels, serial

The deterministic compositor is `art/compose.mjs`; the collection frame/back
generator is `art/collection-art.mjs`; the sourced-subject resolver is
`scripts/content/source-art.mjs` with the curated source list in
`art/subject-sources.mjs`. A flattened render is a delivery artefact, not the
only source of truth. Text, serials, labels and facts are always composed in
code, never generated as pixels.

## Subject image sourcing

Launch cards use real, publicly published character/player images rather than
generated monograms. Each source record carries the wiki/page/file, original
image URL, retrieval time, licence metadata, artist where published, and a
credit. The resolver downloads through an image proxy where the wiki blocks
direct fetches, validates dimensions and format, prepares an editable subject
layer and derives a toned collection background. The source list is explicit so
the same card can be re-fetched and reviewed.

The wiki's current page image is not always the right one. The source list pins
specific files for the Total Drama 2007 season (not the 2023 reboot), clean
Simpsons character renders, individual Rin/Len voicebank renders, and context
cards. A missing or unsuitable source produces a neutral "art pending" layer;
it never falls back to oversized initials.

These are third-party images used in a private, non-commercial member album.
They are not official Foilbury artwork, licensed character art or a claim of
affiliation. The public showcase remains Loftwah-owned original work.

## Access classification

Every asset records:

- `access_classification` — `public`, `member` or `private`;
- `role` — subject, background, material, frame, effect, logo, cover, render;
- `processing_state` — staged, processing, ready, failed, quarantined;
- MIME, dimensions, bytes, SHA-256, provenance and review status;
- source repository/path/commit/logical ID and credit.

Source layers stay private. Renders inherit the card's effective audience. The
delivery route is `/media/render/:asset`; backs use `/media/back/:asset`;
derivatives use `/media/derivative/:id`. `/media/public/:asset` remains as a
legacy compatibility route but re-checks that the card is still public.

## Derivatives and cache identity

`fb_asset_derivatives` records the source render, size key, dimensions, bytes,
checksum and R2 key. Cache identity is the complete render checksum, not just a
card ID. Authorisation is independent of content addressing: a derivative is
authorised by its source card's current effective audience on every request.

## Upload and failure handling

- Uploads are validated by magic bytes, not the declared MIME.
- Maximum upload is 8 MB and 5,000 px per side.
- A render job is `pending → running → succeeded|failed|cancelled`; retrying
  never re-rolls a draw or creates another instance.
- Render-job publication is currently held; see the recovery boundary below.
- Reference-aware cleanup must keep assets referenced by historical awards,
  renders, collection marks and covers.
- A catalogue restore restores asset IDs and compatible render references.

### Render-job publication hold

New render-job queueing, claiming and completion return
`render_publication_unavailable`. Existing renders and job rows are preserved;
an in-flight job is not marked successful and neither side is published by the
completion endpoint. Do not repeatedly requeue or cancel old work to clear this
hold. Inspect existing job state and retain source and output evidence.

The current worker reads mutable R2 keys, separately fetched card and collection
metadata, local back files and local renderer layers. Its job payload does not
bind every input or object version, and the old completion path publishes front,
back and job state in separate transactions. A database-only source-hash check
cannot prove the worker used the claimed bytes. Recovery requires a version-bound
input manifest covering every actual renderer input and output, immutable or
verified object versions, and one guarded D1 transaction for both render links,
job transition, audit and outbox. Review how to reconcile old pending/running
jobs without guessing their provenance, then rerun local concurrency, mutation,
rollback and real renderer checks. Production render batches remain separately
approval-gated. Manual back uploads use a different path and are not covered by
this job hold. The separate `renders:publish-public` script is also held for both
dry-run and apply invocations before it reads or writes local or remote state;
existing artifacts and published rows are retained. Its former upload and SQL
path did not establish immutable input provenance or atomic front/back publication.
The unused `readVerifiedRenderInput` helper verifies a recorded R2 version, size
and SHA-256 against returned bytes; it does not establish that a renderer consumed
those bytes or make publication safe on its own.
The separate, unused `render-manifest` prototype commits explicit display,
composition, registered asset and renderer-dependency inputs. Its D1 check is a
point-in-time comparison of references, display/composition/recipe fields and
selected asset state/provenance, not an atomic publication fence or a review
decision. No immutable manifest is persisted and no executor
has proved that it consumed those inputs or produced the submitted output. A
registered card back and collection mark (or explicit absence of the mark) are
required; the legacy worker's local back/mark discovery does not satisfy this
contract. A future executor must use the manifest's explicit collection rather
than independently selecting its first linked collection. The reference check
binds the edition-derived print subtitle; the two legacy worker scripts choose
text differently and cannot be treated as equivalent. Existing jobs cannot be
upgraded by guessing those inputs.

The legacy worker uses a separate temporary directory per job. To inspect
possible leftover directories without changing them, run
`node scripts/content/inspect-render-temp.mjs` from the project root. The
bounded listing identifies names and modification times only: it does not prove
ownership, process liveness, or that any directory is safe to remove. An
incomplete listing is marked `truncated`. All job outputs are retained, including
successful outputs: pathname-based deletion cannot exclude a concurrent swap.
Crash recovery, orphan verification and retention enforcement
remain open; this inspection does not enable rendering or publication.

## Visual approach

The launch franchise cards use sourced subject images with recorded provenance,
set inside original Foilbury collection framing. They are **not** official
logos, licensed character art or a claim of affiliation. The card design,
background treatment, typography, backs and finishes are Foilbury work. No paid
generation provider was run; the sourced-image path does not require a
generation budget. Third-party permission review remains a separate open item.
