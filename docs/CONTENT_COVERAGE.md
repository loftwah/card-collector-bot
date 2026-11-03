# Launch content coverage

Source manifests are private (`/.foilbury/content`, gitignored). This page is a
sanitised coverage and review tracker. Every row is members-only at launch.

## Delivery at the corrected revision

- **17 launch collections, 140 cards, 560 variants** (Base/Plain, Silver, Gold,
  Gold · Holographic), 140 designed backs, 34 collection achievements and 11
  platform achievements.
- **140/140 subject images sourced** from the property's public reference wiki
  (or Wikimedia Commons for NBA players) on 2026-11-03. The previous oversized
  initials/monograms are no longer used for launch cards.
- Card text, serials, labels, statistics and the collection frame remain
  programmatic Foilbury design. The sourced image is the subject layer; it is
  not presented as an official Foilbury illustration.
- Production read-back on 2026-11-04: deployed Worker
  `c4581234-fa70-4247-9f89-70a35d5a1ec1` from source `2c133ee`; catalogue
  release 11; **21 published collections, 156 cards, 640 variants, 640 published
  fronts, 640 published backs, 0 pending render jobs**, 21 collection logos and
  17 covers. Every collection has full front/back coverage in the read-back.
- The 560 member launch variants still use the previous renderer design; the
  80 public variants were refreshed through the public publication path. The
  bounded member re-render plan remains approval-gated. A hash column being
  populated is not visual acceptance: 80 public variants have no source hash,
  and every production member render still needs the reconciled compositor.
- A repeatable walkthrough is available with `pnpm demo` / `pnpm demo:show`.
  It covers 26 public, member, inspection, draw, achievement, gift, security,
  admin, privacy and mobile stages and writes a private storyboard. See
  `docs/DEMO.md`.
- Existing Loftwah public showcase content and Dean's inventory/ledger remain
  separate. The corrective import did not change the 10 owned instances, 19
  ledger rows or 1,880 Foil total recorded before the pass.

## Roster and review status

The card count is the **starter roster actually delivered**, not a universal
quota and not a claim of complete franchise coverage. Small casts are not padded.
Larger properties are explicitly starter albums until a researched expansion is
approved.

| Collection | Cards | Reviewed / draft | Source boundary | Subject source |
|---|---:|---:|---|---|
| NBA — Opening Night | 12 | 12 / 0 | 2025/26 season, one player per club, not a full league roster | Wikipedia / Wikimedia Commons |
| Chainsaw Man — Public Safety, Part 1 | 8 | 8 / 0 | Manga Part 1; 2022 anime visual reference; Part 2 out | Chainsaw Man Wiki (Fandom) |
| Madoka Magica — Mitakihara | 8 | 7 / 1 | 2011 TV + 2013 Rebellion; later films out | Puella Magi Wiki (Fandom) |
| Danganronpa — Three Killing Games | 8 | 8 / 0 | Three main games; spin-offs/anime out | Danganronpa Wiki (Fandom) |
| NANA — Two Nanas, One Tokyo | 8 | 8 / 0 | Manga + 2006–07 anime; films out | NANA Wiki (Fandom) |
| Project Sekai — Unit Stage | 8 | 8 / 0 | Unit/game context, not in-game card editions | Project SEKAI Wiki (Fandom) |
| South Park — Town Album | 8 | 8 / 0 | Main/supporting townsfolk; content advisory | South Park Archives (Fandom) |
| Rick and Morty — Portal | 8 | 8 / 0 | Main animated continuity; spin-offs out | Rick and Morty Wiki (Fandom) |
| Vocaloid — Voicebanks | 8 | 8 / 0 | Persona vs software vs voice provider | Vocaloid Wiki (Fandom) |
| The Summer Hikaru Died | 8 | 6 / 2 | Manga; 2025 anime reference; spoiler gates | The Summer Hikaru Died Wiki (Fandom) |
| Total Drama Island — 2007 | 8 | 8 / 0 | First season only; season-one stills, not the 2023 reboot | Total Drama Wiki (Fandom) |
| Doki Doki Literature Club! | 8 | 5 / 3 | Original 2017 VN; early-safe profiles | DDLC Wiki (Fandom) |
| Neon Genesis Evangelion | 8 | 8 / 0 | TV episodes 1–26; Rebuild differences noted | Evangelion Wiki (Fandom) |
| Death Note — The Kira Case | 8 | 8 / 0 | Manga + anime; late identity spoilers gated | Death Note Wiki (Fandom) |
| Alien Stage — Stage Lights | 8 | 0 / 8 | 2022–2025 web/music series; no invented outcomes | Alien Stage Wiki (Fandom) |
| Scott Pilgrim — Six Volumes | 8 | 8 / 0 | Comics + 2010 film distinguished | Scott Pilgrim Wiki (Fandom) |
| The Simpsons — Springfield | 8 | 8 / 0 | Floating timeline; no dated claims | Simpsons Wiki (Fandom) |

## Status counts

These are separate claims. A record existing is not the same as visual acceptance.

| State | Count | Notes |
|---|---:|---|
| Imported | 140 | All 17 manifests validate and import through the supported pipeline. |
| Fact-checked profiles | 126 | 14 cards remain `draft`: Alien Stage (8), DDLC (3), Madoka (1), The Summer Hikaru Died (2). |
| Artwork-ready | 140 | Subject image + background layer + designed back exist for every card. |
| Published / playable | 140 | Production catalogue release 4; all 140 launch cards and 560 variants are published. |
| Agent visual sample reviewed | 17 / 17 collections | One representative card per collection plus all-card contact sheets; flaws found and corrected (wrong adaptation, cropped faces, bad context images, low-contrast backs). |
| Human visual acceptance | 0 / 17 | Dean's final creative approval remains open. |
| Draft or blocked | 14 | The same 14 profiles above; Alien Stage is the largest block. |

## What "complete" means per card

- a stable logical ID and slug;
- a spoiler-safe introduction and fuller reviewed/draft profile;
- collection/source identity and a dated or bounded source context;
- typed attributes with a source label;
- reviewed or explicitly draft provenance;
- a source reference list;
- a sourced subject image with the source page, file, retrieval date, licence
  metadata and credit recorded;
- a designed front, a designed back, and Plain/Silver/Gold/Holographic renders;
- album membership, pool configuration and privacy review.

## Achievement roster boundaries

Collection milestones (`collection_unique` and `collection_complete`) carry a
frozen `roster_card_ids` snapshot in their versioned criteria. The evaluation
counts only owned cards in that release roster. Adding or removing a card in the
live collection cannot move an existing version's completion boundary. The
snapshot was applied in place by migrations `0011` and `0012`, so existing
unlocks and rewards are not duplicated.

## Artwork provenance and permissions

The subject images are publicly published character/player images from the
property reference wikis and Wikimedia Commons. They are third-party works used
inside a private, non-commercial member album. The source page, image URL,
retrieval time, licence metadata, artist where published, and a per-card credit
are recorded in the private provenance file. No official affiliation, licence or
clearance is claimed.

The source images and contact sheets stay under `.foilbury/` and are not
committed. Public Loftwah showcase art remains the only publicly published
artwork. When a source image is missing or unsuitable, the card uses a neutral
"art pending" fallback rather than oversized initials.

## Known content limits

- These are curated starter albums, not complete franchise encyclopedias.
- Alien Stage remains `draft` because its facts are newer and less settled.
- DDLC and Alien Stage include a small number of setting/context cards because
  their named casts are small; no characters were invented to pad the roster.
- No quotations, ages, heights, statistics or relationships were fabricated.
- Asset permission review is separate from the private/non-commercial product
  status. Sourced images do not make Foilbury official or licensed.
- NBA facts are dated to 2025/26; later trades and the 2026/27 season are out.
