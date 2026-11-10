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

## Slice 3 batch 1 — the language generalises

Status: implemented 2026-11-10. The pilot was not rebuilt; Danganronpa and
Protocol 11 keep their existing output.

The rollout is data-driven. A collection names a `theme` in
`src/data/collection-presentations.json`; the theme tokens live in
`src/data/collection-themes.json` and the renderer's shared
`art/livery.mjs` registry. There is no per-collection branch in the page or
the compositor.

### Batch 1

| Collection | Theme | Identity art | Roster shelves |
| --- | --- | --- | --- |
| Chainsaw Man — Public Safety, Part 1 | `archive` | sourced banner + real series mark | Public Safety / Division chief / Devils and partners |
| Puella Magi Madoka Magica — Mitakihara | `stage` | sourced banner + real series mark | Magical girls / The contract / Mitakihara at home |
| Total Drama Island — Camp Wawanakwa, 2007 | `broadcast` | sourced banner + real series mark | Campers / Production |

- **Archive** is a cream index-card band with an oxblood registration edge, a
  catalogue tab, a wide mark plate and typed record lines. The art canvas stops
  above the band so full-body art is not cut by the information field.
- **Stage** is a dark plum ticket with a spotlight wash, a cream mark plate, a
  marquee rule and a `NOW SHOWING` line. The subject stays contained.
- **Broadcast** is a dark tape with a screen bezel, scanlines, a tally light and
  an amber lower-third. The title is uppercase Manrope; the collection and
  finish are typed as broadcast metadata.
- The front keeps the 5:7 contract and the reserved art window. The back is a
  designed paper/dark record with the real mark, name, role, short bio, rarity,
  edition and provenance. Third-party provenance stays explicit:
  `MEMBER ARCHIVE · NOT OFFICIAL`, `official:false`.
- `cardSetName` supplies a short printed collection line so the card face does
  not truncate a long catalogue name.
- Wide series wordmarks are measured at render time (`markAspect`) and get a
  wide plate rather than a square sticker.

### Audience and art

No new image generation was run for this batch. The three collections keep
their existing sourced 16:9 banners and real series marks; all remain
member/private, `origin=sourced`, `official:false`. No card render is used as
collection identity. The web hero uses the banner first and the real mark
second; the mark is on a paper plate for these wordmark-led collections.

### Verification

- Local render pass: 32 Chainsaw Man fronts, 32 Madoka fronts, 32 Total Drama
  fronts and 96 designed backs; no failures.
- Contact review at 750×1050 for a plain, silver, gold and holographic front,
  and at 32/64/128/256 px for silhouette and name recognition.
- Collection pages reviewed at 1440 and 390, light and dark: no horizontal
  overflow, banner-led hero, mark second, grouped binder, exact next-opening
  panel and finish odds.
- Production data was not widened: `status`, `view_audience` and distribution
  were not changed by this batch.

### Batch 2

| Collection | Theme | Identity art | Roster shelves |
| --- | --- | --- | --- |
| Doki Doki Literature Club! — The Clubroom | `archive` | sourced banner + real series mark | Club members / The clubroom |
| Project Sekai — Unit Stage | `stage` | sourced banner + real series mark | Unit stages / Virtual Singer |
| Vocaloid — Voicebanks | `stage` | sourced banner + real series mark | Crypton / Internet Co. / 1st Place |
| South Park — Town Album | `broadcast` | sourced banner + real series mark | Main cast / Townsfolk |
| The Simpsons — Springfield, U.S.A. | `broadcast` | sourced banner + real series mark | The family / Springfield |

- The same four livery layouts are reused; no new theme, frame or per-collection
  renderer was added.
- `markPlate` records whether a series wordmark is light or dark. A light
  wordmark gets a dark plate (Chainsaw Man, Doki Doki, Project Sekai, The
  Simpsons); a dark wordmark keeps the paper plate (Vocaloid, South Park,
  Madoka, Total Drama).
- The binder groups are authored card-name lists, not substring guesses, so a
  roster with a shared word in two roles cannot fall into the wrong shelf.
- All five collections remain member/private, `origin=sourced`, `official:false`.
  No new art was generated and no distribution was widened.

### Batch 3

| Collection | Theme | Identity art | Roster shelves |
| --- | --- | --- | --- |
| NANA — Two Nanas, One Tokyo | `archive` | sourced banner + real series mark | Black Stones / Trapnest / Tokyo |
| Death Note — The Kira Case | `archive` | sourced banner + real series mark | The investigation / Shinigami / The notebook |
| The Summer Hikaru Died — The Village and the Voice | `archive` | sourced banner + real series mark | The village / Outside authority |
| Scott Pilgrim — Six Volumes, One City | `manga` | sourced banner + real series mark | Sex Bob-omb / The exes / Friends |
| Rick and Morty — Portal | `broadcast` | sourced banner + real series mark | The Smiths / Wider cast |

- `manga` is the fourth shared livery: a paper caption panel, an inked
  gutter, a halftone corner and a black subtitle box. It is not a per-collection
  frame.
- Death Note, Summer Hikaru Died, Scott Pilgrim and Rick and Morty use a dark
  mark plate for their light or mid-tone wordmarks; NANA uses the paper plate.
- All five remain member/private, `origin=sourced`, `official:false`. No new art
  was generated and no distribution was widened.

### Batch 4 — the remaining six

| Collection | Theme | Identity art | Roster shelves |
| --- | --- | --- | --- |
| Alien Stage — Stage Lights | `stage` | sourced banner + real series mark | Contestants / The garden / The stage |
| NBA — Opening Night | `broadcast` | sourced banner + real series mark | Backcourt / Wings / Bigs |
| Neon Genesis Evangelion — Episodes 1–26 | `archive` | sourced banner + real series mark | NERV / Outside the command |
| Bubbles | `stage` | original committed mark | The cast |
| Fighter | `manga` | original committed mark | The roster |
| Shared Characters | `archive` | original committed mark | The shared cast |

- The three Foilbury-owned collections are mark-led because they have no
  banner. The hero uses the real committed mark on a paper plate over the
  theme's authored ground; no invented logo or card render is used.
- `markTreatment` and `markInvert` can be overridden per collection for a
  square original badge. The shared theme still supplies the frame and text
  layout.
- Alien Stage, NBA and Evangelion remain member/private, `origin=sourced`,
  `official:false`. Bubbles, Fighter and Shared Characters are original
  Foilbury projects and remain public.
- This completes the rollout of the shared language to every published
  collection. The two pilots keep their original output.

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
