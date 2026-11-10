# Collection card language

> **Current owner direction (2026-11-10):** whole-card AI with GPT Image 2.6
> Sunburst or a top-tier FAL model is the primary card production method. The
> v2 renderer and the language below are retained for reference sheets,
> publishing metadata and comparison. They are not the mandatory final card
> composition. See `AGENTS.md` and `docs/ART_LAB.md`.

Status: **card language v2 is production-verified on three proof collections**
(2026-11-10). The Slice 3 rollout below is historical: its frames, flat
material tints and dark-blur backgrounds are superseded. The remaining
sixteen published collections still use their old saved renders; do not roll
v2 across them until this language is accepted at the owner's 9/10 bar.

- Renderer: `art/card-render.mjs` (one shared renderer).
- Data: `src/data/collection-livery.json` (per-collection palette, motif, era,
  plate treatment) and `src/data/collection-themes.json` (family tokens).
- Scene backgrounds: `art/backgrounds/<slug>.webp`, generated and recorded in
  `docs/COLLECTION_ART_PROVENANCE.md`. They are not served from `public/`.
- Proof collections: Doki Doki Literature Club (archive), Project Sekai
  (stage), Scott Pilgrim (manga). All four finishes and both faces were
  rendered; the other 16 published collections still use the old saved renders.

## V2 object contract

- One 5:7 object. The master is **1500×2100**; the web render is **750×1050**
  and is judged at **400×560** before it is accepted. The same saved object is
  attached in Discord; there is no second Discord composition.
- Layers: real scene → composed subject → authored material → family livery
  frame → exact type. No whole-card generation and no CSS tint presented as a
  finish.
- Front hierarchy: scene and subject (about 70% of the object), collection mark,
  name (maximum two lines), role, collection and era, rarity, finish, print
  code, one provenance line. No bio wall. The saved render is shared by every
  copy of a variant, so it carries the **print code** (for example
  `FB-DDLC-003`); the unique **copy serial** (for example `FB-4-DE-341A93`) is
  shown in the inspector and the Discord embed, never invented on the shared
  render.
- Back: a designed record with the real mark, name, role, a concise bio, the
  collection, rarity, edition, provenance, print serial and set symbol. It is
  set as a typographic page with a foil seal and a serial ticket, not a table.
- The subject is the real sourced art. The renderer only removes the white
  cutout matte, un-premultiplies the anti-aliased edge, adds a one-pixel ink
  contour, a contact shadow and a key-light glow. Likeness is not redrawn.
- The card type is authored at 750 and rendered at 2× so the name, rarity,
  finish and print code survive Discord's inline size. Name 92/76/64, rarity
  30, print code 29, finish 25, collection line 15.2, provenance 9.4. Discord
  caps a 5:7 embed image at about 214×300, so the metadata row was raised to
  survive that cap; the real copy serial is in the embed field.

## Materials

- **Plain** — uncoated paper edge, blind-embossed inner rule, no metal, no
  specular band.
- **Silver** — cool brushed metal with a layered bevel and specular sweep.
- **Gold** — warm foil with a dark outer bevel, saturated mid-band and a bright
  inner fillet.
- **Holographic** — prismatic segmented edge, diffraction wash over the scene
  and a prismatic seal; the printed label is `HOLOGRAPHIC`.
- Finish is carried by the object edge, the seal, the finish label and the
  frame fillet. A finish change is visible at 128 px, not only in a tint.

## Family livery

Three strong families share one skeleton; a collection supplies palette, motif,
era and plate treatment. There is no per-collection code.

| Family    | Geometry                                                                                                              | Proof                     |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `archive` | Rounded frame, stitched inner rule, large round collection badge, plum plate, heart/bolt-style set seal               | Doki Doki Literature Club |
| `stage`   | Proscenium valance with bulbs, side curtains, wide wordmark plate, navy plate, star seal, cyan/magenta rules          | Project Sekai             |
| `manga`   | Black gutter inside the finish frame, halftone plate, wide mark on a black plate, condensed uppercase name, bolt seal | Scott Pilgrim             |

The collection identity is the real `logo_url`, the collection's palette and
era, and a motif derived from the collection. No official logo is invented and
no card render is used as collection identity.

## Acceptance for v2

- Name, rarity, finish and print serial are readable at 400 px without zooming.
- The four finishes are distinct at 128 px.
- The frame and set symbol belong to the collection.
- Front and back are both designed; the back is not a table.
- The live signed-in card inspector is checked at 1440 and 390, and the Discord
  `/foilbury open` attachment is checked at its real inline size.

## Direction review (2026-11-10)

Eight directions were rendered as actual cards for Doki Doki Literature Club,
not mood boards, then judged at 750, 400, 214 and 128. The contact sheet is
`.foilbury/evidence/card-language/contact-directions.jpg`.

| Direction            |   Score | Blunt critique                                                                                                                                             |
| -------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Atelier** (chosen) | 8.5 → 9 | Art-led portrait, plum plinth, cream type, large real badge, foil edge. The only direction where the object, the collection and the data all read at once. |
| Foil Minimal         |       7 | Premium restraint and the best first impression, but the plinth is empty and the metadata is too quiet to survive Discord.                                 |
| Reliquary            |     6.5 | Correct hierarchy, but the cream plinth is flat and the first pass read like a magazine layout, not a collectible.                                         |
| Cinema               |       6 | Strong scene and name, but no designed object and the metadata is crammed into a gradient.                                                                 |
| Index card           |       6 | Real collection identity, but it reads as a school notebook rather than a premium card.                                                                    |
| Panel                |       6 | Bold name bar, but a poster, not a printed collectible with a back.                                                                                        |
| Ticket               |     5.5 | The arch is good; the empty band and dotted line read arcade, not archive.                                                                                 |
| Scrapbook            |     5.5 | Charming and on-theme, but fan-scrapbook rather than a card worth posting.                                                                                 |
| Terminal             |       5 | On-theme for DDLC's meta turn, but hacker cosplay and poor type hierarchy.                                                                                 |

### Iterations of the chosen direction

1. **Cream plinth / Reliquary** — clean, but the material read as flat paper and
   the subject had a visible white cutout halo. Failed the "gold looks like
   gold" test.
2. **Plum plinth, bigger badge** — the card gained drama and a real collection
   mark; the subject still floated and the metadata was too small for Discord.
3. **Dusk clubroom + 1000 px portrait** — the subject sat in a lit scene rather
   than on a blur; the de-fringe and ink contour removed the halo. Frame and
   seal became the finish carriers.
4. **30 px metadata row** — a real Discord embed caps a 5:7 image at about
   214×300, so rarity, finish and print code were raised to 30/23/29 px. The
   holographic label was moved left to keep the print code clear.
5. **Back** — the first reverse was a cream facts grid. The final reverse is a
   designed record: mark, name, role, bio, foil set mark, rarity, collection,
   edition, provenance, print ticket and set line.

## V2 production verification (2026-11-10)

- Application source `d363dcc50f4c`; Worker
  `3fc33453-ccfd-4b70-b672-2cd6ef277cc7`. The final card renders were produced
  by renderer `08253ec`; the renderer and documentation follow-ups are tooling
  changes and were not a runtime redeploy.
- Proof collections and variants: Doki Doki Literature Club, Project Sekai and
  Scott Pilgrim; eight cards each, four finishes (**32 published variants per
  collection, 96 fronts and 96 designed backs**). Every front and back rendered
  with no failures.
- Pre-change D1 JSON backup:
  `.foilbury/backups/d1-2026-11-10T05-40-31-472Z.json` (97 tables, 46,550 rows,
  SHA-256 `49ef4db9f2c35624cf0d80d1fd1b2d325f198a90aff1d02e42470b68368a7cae`).
  The render pass only added render assets and pointers; collection status,
  `view_audience`, distribution, inventory and serials were not changed.
- Live signed-in inspector at
  `/play/card/ins_mwa6uszgdnkctw7h12p5ed0n` was checked at **1440** and
  **390**, front and back: the saved 750×1050 object loads, no horizontal
  overflow, the copy serial `FB-4-DE-341A93` is shown outside the object, and
  the finish comparison shows Plain, Silver, Gold and Gold · Holographic.
- A real Discord test-channel message attached the saved 750×1050 Gold render.
  Discord displayed it at **214×300** (the client caps a 5:7 embed image by
  height), so the metadata row was raised to 30/25/29 px on the 750 master.
  At that real inline size the name, `CABINET RARE`, `GOLD` and the print code
  are legible, and the native embed fields show Rarity, Finish, Serial and
  Collection in Discord's own type. No second Discord composition was made.
- Contact review at 750, 400, 214 and 128: the four finishes are distinct at
  128; the name and print code remain legible at the Discord cap.
- Evidence: `.foilbury/evidence/card-language/` (front/back proofs, contact
  sheets, live inspector and Discord captures).
- The temporary production agent and Access service token used for the pass
  were revoked; `.foilbury/production-agent.json` was removed.
- The real `/foilbury open` slash path was invoked and revealed in the test
  channel: sealed draw, `Reveal card`, committed receipt and native fields all
  completed. That draw returned Kyubey — Silver from Madoka Magica, which is
  not one of the three proof collections, so its attachment is still the old
  language. The v2 Gold render was posted to the same channel as a real saved
  render attachment and inspected at the client's **214×300** inline cap. The
  v2 card language in Discord is proven; a v2 draw receipt from a proof
  collection is still a chance outcome, not a controlled test.

## Historical: Slice 3 (superseded)

The Slice 3 record below is kept as history. Its 19-collection rollout, flat
material tints, blurred backgrounds and typographic scale are not current
acceptance.

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

| Collection                                | Theme       | Identity art                      | Roster shelves                                       |
| ----------------------------------------- | ----------- | --------------------------------- | ---------------------------------------------------- |
| Chainsaw Man — Public Safety, Part 1      | `archive`   | sourced banner + real series mark | Public Safety / Division chief / Devils and partners |
| Puella Magi Madoka Magica — Mitakihara    | `stage`     | sourced banner + real series mark | Magical girls / The contract / Mitakihara at home    |
| Total Drama Island — Camp Wawanakwa, 2007 | `broadcast` | sourced banner + real series mark | Campers / Production                                 |

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

| Collection                                | Theme       | Identity art                      | Roster shelves                     |
| ----------------------------------------- | ----------- | --------------------------------- | ---------------------------------- |
| Doki Doki Literature Club! — The Clubroom | `archive`   | sourced banner + real series mark | Club members / The clubroom        |
| Project Sekai — Unit Stage                | `stage`     | sourced banner + real series mark | Unit stages / Virtual Singer       |
| Vocaloid — Voicebanks                     | `stage`     | sourced banner + real series mark | Crypton / Internet Co. / 1st Place |
| South Park — Town Album                   | `broadcast` | sourced banner + real series mark | Main cast / Townsfolk              |
| The Simpsons — Springfield, U.S.A.        | `broadcast` | sourced banner + real series mark | The family / Springfield           |

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

| Collection                                         | Theme       | Identity art                      | Roster shelves                               |
| -------------------------------------------------- | ----------- | --------------------------------- | -------------------------------------------- |
| NANA — Two Nanas, One Tokyo                        | `archive`   | sourced banner + real series mark | Black Stones / Trapnest / Tokyo              |
| Death Note — The Kira Case                         | `archive`   | sourced banner + real series mark | The investigation / Shinigami / The notebook |
| The Summer Hikaru Died — The Village and the Voice | `archive`   | sourced banner + real series mark | The village / Outside authority              |
| Scott Pilgrim — Six Volumes, One City              | `manga`     | sourced banner + real series mark | Sex Bob-omb / The exes / Friends             |
| Rick and Morty — Portal                            | `broadcast` | sourced banner + real series mark | The Smiths / Wider cast                      |

- `manga` is the fourth shared livery: a paper caption panel, an inked
  gutter, a halftone corner and a black subtitle box. It is not a per-collection
  frame.
- Death Note, Summer Hikaru Died, Scott Pilgrim and Rick and Morty use a dark
  mark plate for their light or mid-tone wordmarks; NANA uses the paper plate.
- All five remain member/private, `origin=sourced`, `official:false`. No new art
  was generated and no distribution was widened.

### Batch 4 — the remaining six

| Collection                              | Theme       | Identity art                      | Roster shelves                       |
| --------------------------------------- | ----------- | --------------------------------- | ------------------------------------ |
| Alien Stage — Stage Lights              | `stage`     | sourced banner + real series mark | Contestants / The garden / The stage |
| NBA — Opening Night                     | `broadcast` | sourced banner + real series mark | Backcourt / Wings / Bigs             |
| Neon Genesis Evangelion — Episodes 1–26 | `archive`   | sourced banner + real series mark | NERV / Outside the command           |
| Bubbles                                 | `stage`     | original committed mark           | The cast                             |
| Fighter                                 | `manga`     | original committed mark           | The roster                           |
| Shared Characters                       | `archive`   | original committed mark           | The shared cast                      |

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

## Slice 3 production rollout

The four batches were released separately and each was exercised on the live
signed-in site before the next began.

| Batch | Collections                                                         | Fronts | Backs | Source                | Worker                  |
| ----- | ------------------------------------------------------------------- | -----: | ----: | --------------------- | ----------------------- |
| 1     | Chainsaw Man, Madoka Magica, Total Drama Island                     |     96 |    96 | `545a82e` + `e88afb5` | `da5660f6` / `ab37d44d` |
| 2     | Doki Doki, Project Sekai, Vocaloid, South Park, The Simpsons        |    164 |   164 | `08b4184` + `0bb304a` | `aa72257a` / `2633e889` |
| 3     | NANA, Death Note, Summer Hikaru Died, Scott Pilgrim, Rick and Morty |    160 |   160 | `9526b43`             | `3bad1911`              |
| 4     | Alien Stage, NBA, Evangelion, Bubbles, Fighter, Shared Characters   |    196 |   196 | `b9a3c72`             | `2a57e92b`              |

- Pre-change D1 JSON backup:
  `.foilbury/backups/d1-2026-11-10T00-53-53-721Z.json` (97 tables, 37,016 rows,
  SHA-256 `9c9aabc505cc4cbf7dc418f2e8610de6696ede61960b389fa5b3866a6aac1c01`).
- The render pass only added saved front/back render assets. Collection
  `banner_url`, `logo_url`, `status`, `view_audience` and distribution were not
  changed.
- Every one of the 19 remaining published collections was checked at 1440 and
  390, light and dark: banner-first or real-mark-first hero, loaded mark, grouped
  binder, exact next-opening state, finish odds, and no horizontal overflow.
- The three mark-only originals (Bubbles, Fighter, Shared Characters) use their
  committed original marks; no banner was invented. Their page honestly offers
  the mixed cabinet draw when the collection is not dropping.
- The temporary production agent and Cloudflare Access service token used for
  the render pass were revoked and deleted afterwards.

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
