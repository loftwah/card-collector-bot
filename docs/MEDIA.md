# Media, artwork and rendering

## Geometry and delivery sizes

The established card geometry is 5:7. Delivery renders are **750×1050**;
masters and source layers are authored larger where the source supports it
(the deterministic launch art is generated at 1200×1600 subject and 1600×2000
background, then composed down).

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

The deterministic compositor is `art/compose.mjs`; the launch art generator is
`art/collection-art.mjs`. A flattened render is a delivery artefact, not the
only source of truth. Text, serials, labels and facts are always composed in
code, never generated as pixels.

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
- A failed upload or render does not publish a partial asset.
- Reference-aware cleanup must keep assets referenced by historical awards,
  renders, collection marks and covers.
- A catalogue restore restores asset IDs and compatible render references.

## Visual approach

The launch franchise cards use original, clearly labelled Foilbury
interpretations generated from deterministic briefs. They are **not** official
logos, licensed character art or likenesses, and the provenance is retained. No
paid generation provider was run because no bounded ceiling exists in this
build. The chargeable generation step remains blocked pending a reviewed budget.
