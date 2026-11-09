# Pilot card language: Danganronpa and Protocol 11

Status: implemented and deployed in Slice 2 (2026-11-10) for the two pilot
collections only. Source `24a1d67b31dd3db20a0523c5707528b18735c925`; Worker
`302617c7-7fe0-4c2e-9afa-5a08ad8f05d7`. The shared renderer remains the only
card renderer; the other collections keep their current presentation until
Slice 3.

## Shared contract

- The object is 5:7. The master is 750×1050 with a reserved art window above a
  typed information band. Controls stay outside the object.
- Authored layers run background → subject → material → livery frame → effect
  → exact text. `art/compose.mjs` owns the geometry; `art/generate-layers.mjs`
  owns the rasterised frame and material layers.
- Plain, Silver, Gold and Holographic are authored material layers. The finish
  label is `HOLOGRAPHIC` (never `Gold · Holographic`).
- The front is art-led. The back is a designed information object made from the
  card's real name, game/role, short description, rarity, edition and
  provenance. No character art is added to a back.
- Collection identity is still the real `banner_url` first and `logo_url`
  second. A card render is never used as collection identity.

## Danganronpa — Class Trial Archive

- **Language:** a class-trial evidence file. Black binder edge, paper rule, hot
  pink registration edge, angular corner marks and a halftone field.
- **Front:** the sourced character cutout fills the art window. The real
  Danganronpa wordmark is inverted for the dark ground and sits on a small ink
  plate. The title is uppercase Manrope 800; the game and role are separate
  lines; the rarity and `MEMBER ARCHIVE · NOT OFFICIAL` are explicit.
- **Back:** ink ground, pink evidence bar, the real wordmark, the game/role and
  a short sourced description. A class-trial seal fills the middle. Facts name
  the collection, rarity, member edition and third-party provenance.
- **Audience:** member/private. `official:false`; no affiliation or licence is
  claimed. The sourced banner and mark are unchanged.

## Protocol 11 — Table Night

- **Language:** a table-night place card. Deep green baize edge, brass rules,
  four seat pips, cream paper and a brass `XI` seal.
- **Front:** a square table-night portrait is masked to a coaster, mounted on a
  cream matte with a brass ring, and set over the lamplit table scene. Print
  editions stay full-art instead of being cropped to the coaster. The title is
  Fraunces; the role is sentence case; `TABLE NIGHT · role · rarity` is typed in
  mono. The original Protocol 11 mark remains a secondary identifier.
- **Back:** cream place card with the mark, role, short description and a large
  `XI` table seal. Facts name the collection, role, rarity and original Foilbury
  provenance.
- **Audience:** public showcase, as the collection already was. The existing
  geometric mark remains; the new key art is the collection's banner first.
- **Key art:** `public/art/collections/protocol-11-key-art.webp`, generated from
  the five actual table-night portraits and the table scene. See
  `docs/AI_COLLECTION_ART_PROVENANCE.md`.

## Collection page

`src/data/collection-presentations.json` supplies the authored shelf groups,
hero copy, capsule deep link and title split for the pilots.
`src/pages/play/collection.astro` renders a banner-led hero, a compact roster /
finish summary, a server-rendered "what to open next" panel with exact cost,
eligible count and finish odds, and a grouped binder. The pilot shelves show
three cards across at desktop so the card language is actually visible. Missing
slots remain dashed and are never given a finish frame.

## Material states

- Plain: warm paper grain and a paper rule.
- Silver: cool brushed metal and a cool rule.
- Gold: warm metal and a warm rule.
- Holographic: the authored prismatic effect; the card name stays readable.
- The livery frame is material-specific (`frame-trial-*`, `frame-table-*`), so a
  finish change is visible in the object edge, not only in a CSS tint.

## Verification

- Actual fronts and backs inspected at 750×1050 in the card inspector.
- Contact sheet reviewed at 32, 64, 128 and 256 px widths; the card silhouette,
  collection edge and name remain recognisable by 128 px.
- Protocol 11 banner reviewed at 1440, 390 and in a circular Discord crop.
- Production collection pages reviewed at 1440 and 390, light and dark, with no
  horizontal overflow. The cabinet shelf uses the Protocol 11 key art as the
  collection identity, not a card render.
- The card detail facts grid was changed to one column on phones after a real
  390 px overflow (long provenance strings); `pnpm test:product` now passes the
  mobile inspector overflow check.
