# Design review and material studies

## Direction chosen

Foilbury keeps its cabinet/archival identity but adds a warmer public-showcase
layer: parchment, ink, coral, saffron, teal and plum. The player album lets the
cards lead; admin surfaces stay quieter. Geist Serif carries display weight,
Geist Sans carries UI, Geist Mono is reserved for serials, odds and dates.

## Card design options evaluated

| Option | Composition | Best use | Decision |
|---|---|---|---|
| A. Full-art cinematic | Background scene, large subject, minimal top/bottom chrome | Franchise cards where the subject is the main event | Selected for the 17 launch collections |
| B. Framed editorial | Strong frame, set label, name block and metadata rail | Public originals and legacy cards | Preserved for Bubbles / Fighter / Protocol 11 / Shared |
| C. Etched / foil minimal | Dark field, fine material lines, restrained type | Silver and Gold finishes | Used as the material treatment on both A and B |
| D. Prism panel | Masked iridescence over the subject, not the whole card | Holographic finish | Selected; avoids a full-card rainbow wash |
| E. Full-art alternate | Different crop/illustration per finish | Future special editions | Not used for the core four; it would multiply asset work without improving ownership clarity |

The shared renderer keeps a single geometry and text system while collection
covers, palettes, motifs and back layouts vary. Each launch property has its own
cover palette and motif (court lines, stripes, petals, halftone, stars, waves,
skyline, circuit, tape, dots). This is deliberately not one template recoloured
17 times.

## Material treatment review

- **Base / Plain**: full composition, controlled contrast, readable name and
  subtitle; no intentional dulling.
- **Silver**: cool metallic overlay plus silver frame; name and serial remain
  legible.
- **Gold**: warm metallic frame and controlled highlight; not a yellow filter.
- **Holographic**: masked prismatic layer over the subject/field; the card name
  stays readable and the static Discord export still carries the effect.

Contact sheets (private evidence, not committed):
`.foilbury/evidence/contact-sheets/<collection>.jpg`.

## Independent critique findings and fixes

1. **Cover title collision** — long collection names ran into the monogram.
   Fixed by wrapping up to three title lines, reducing size, moving the monogram
   to the lower-right and increasing title contrast.
2. **Cover palette sameness** — the first pass used one default palette/motif for
   every cover. Fixed by adding a reviewed palette and motif per collection.
3. **CJK tofu in source labels** — source-work labels with Japanese characters
   rendered as missing glyphs. Fixed by rendering a Latin-safe source label.
4. **Card name overflow** — long names could overlap the subtitle. Fixed by
   three-line wrapping, size reduction and computed subtitle/meta baselines.
5. **Public cabinet duplication** — two identical collection chip rows. Removed
   the duplicate; collection chips remain above the grid.
6. **3D affordance** — the first 3D mode had no initial tilt, so it looked like
   the flat card. Fixed with an initial controlled tilt and visible edge.
7. **Gift composer key warning** — React list keys fixed; console clean.
8. **Draw-room length** — 22 pool buttons made the page extremely long. Replaced
   with a grouped select and a selected-capsule summary.

## Remaining visual limits

- Franchise cards now use sourced subject images with recorded provenance, not
  oversized initials. The collection framing, backs, typography and finishes
  remain original Foilbury design. The images are third-party works used in a
  private, non-commercial member album, not licensed or official artwork.
- The earlier monogram fallback produced a specific failure: Hajime Hinata's
  oversized "HH" read as an unintended political symbol. The fallback is now a
  neutral silhouette labelled "art pending"; launch cards require a sourced
  subject before publishing.
- A human contact-sheet review on calibrated displays and constrained mobile
  hardware remains a release step; the automated screenshots are not a substitute.
- Pity is disabled and no casino-style motion is used. The reveal is optional and
  skippable.
