# Foilbury card anatomy and display

Status: **canonical design study (2026-11-11).** This file records what makes
the reference collectible cards work and what a Foilbury card must do. It is
subordinate to `docs/CARD_LAYER_SYSTEM.md`; the layer system is the production
contract, this file is the design bar.

## What the references actually do

| Reference | Structural move | Why it works |
| --------- | --------------- | ------------ |
| Pokémon EX / VSTAR (Mewtwo, Gengar, Meowth) | The subject is full-bleed and breaks out of the art window. A nameplate, HP/type capsule, ability/attack panels and a rule box sit over the art. Foil/etched texture runs under and over the frame. | The character is the first read, the frame is a stage, and the data is a designed overlay rather than a white footer. The card feels like an object with depth. |
| Pokémon VSTAR (Mewtwo) | A gold VSTAR crown, a split art/effect area, a large VSTAR Power panel, a clean weakness/resistance/retreat strip and a rule box. | The hierarchy is unmistakable: name → art → attack → rule → housekeeping. The foil is a material, not a tint. |
| NBA Ultra “Double Trouble” | Full-bleed action photography, team colour, a condensed nameplate, a set/insert wordmark, foil and refractor variants. | The photography carries the emotion; the typography is sports-poster loud; the parallel/insert is visible at a glance. |
| Topps Chrome Larry Bird | A gold foil border, a vintage frame, an action portrait, a team wordmark, serial `1/1`, an autograph and a certification strip. | The object reads as valuable before you read a word; the serial and autograph are part of the composition, not metadata appended later. |
| Binder / acrylic stand photos | Cards are shown in a page of nine pockets or standing in clear stands on a shelf, with real reflections and a physical edge. | The display gives scale, protection and ownership. A flat grid of images misses the object. |

## The Foilbury bar

A Foilbury card must be recognisable at 128 px, desirable at 400 px, and
readable at 214×300. It must look like a printed object, not a web card with a
picture.

### Front anatomy (top to bottom)

1. **Class / type capsule** — e.g. `BASIC`, `SIGNAL`, `MYTHIC`; a small
   collection or set code on the opposite side.
2. **Nameplate** — the card name is the largest type on the object, set in the
   card's own display face (Fraunces for Foilbury originals; the collection's
   authored face for licences). Two lines maximum. Never a web UI heading.
3. **Role / evolution / subtitle** — one line, sentence case, directly under the
   name. This is the character's role, not a paragraph.
4. **Full-bleed art** — the subject dominates 55–70% of the object. The subject
   may break the frame, overlap the nameplate or extend past the art window.
   The scene is part of the object; it is not a rectangle pasted onto a white
   card.
5. **Rarity / finish / edition capsule** — top-right or on the nameplate rail.
   Plain, Silver, Gold, Holographic and the print code are readable without
   opening the inspector.
6. **Ability / field note panel** — one short, designed panel: a real character
   trait or a collector's note. No wiki wall, no invented game rules.
7. **Stat / field strip** — three to five compact facts: role, collection,
   rarity, finish, edition or set symbol. Typed, not a table of equal cards.
8. **Footer** — print code, serial (only on the copy inspector, never invented
   on a shared render), provenance line, set symbol and the Foilbury mark.
9. **Material and effect** — foil edge, etched holo, paper grain, embossed
   frame, or a special overlay. The finish is visible in the edge and seal at
   128 px.

The frame is a layer with a transparent art window. A front is never a flat
whole-card image with the type baked in by the model.

### Back anatomy

The back is a designed record, not a second poster and not a wall of text.

1. **Header** — collection mark, card name, role, set/edition and print code.
2. **Portrait / crest** — the real collection mark or a small crop of the
   subject. No new character art is invented for the back.
3. **Short bio** — two to four sentences from the approved copy. The printed
   face is a record, not a wiki.
4. **Field record** — a compact block: rarity, finish, edition, set symbol,
   print code, audience and (where applicable) the copy serial.
5. **Provenance** — `PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT` or
   `MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL`; `official:false` where
   appropriate. This is factual, not decorative.
6. **Collector note / credits** — one line about the art source, the model or
   the print, and the Foilbury mark. No invented illustrator names.
7. **Material edge** — the same finish edge/seal as the front, so the object is
   coherent when flipped.

### Display anatomy

- **Hero / pinned card** — one large card at 750×1050 with a thin physical
  stand or shelf rail. A soft contact shadow, no fake wood/glass. The card is
  the object; the shell is quiet.
- **Binder page** — a 3×3 page of card pockets for a collection, with a page
  edge, ring gutter and consistent gutters. Missing slots are dashed, never
  given a finish frame.
- **Shelf / stand** — a row of cards standing at a slight angle in a thin
  acrylic-like rail or paper slip, with one shadow and one highlight. Do not
  use a glassmorphism panel.
- **Fan** — three to five cards fanned for a collection or launch moment; the
  hero card is readable, the others imply depth.
- **Viewer** — full-size front/back on paper, facts to the side, no recompose
  of private layers. The object remains the hero.

## Our current gaps

- The card object is a rigid art window plus a white information band; the
  subject does not break the frame, so it reads as a template.
- The name is too small relative to the art and the footer is a list of equal
  labels. There is no class capsule, no ability panel and no set-symbol rhythm.
- The back is underdesigned: it needs a header, a short bio, a field record, a
  provenance block and a collector line in a deliberate hierarchy.
- The display is mostly a flat grid. There is no binder page, stand or fan
  treatment for the member cabinet.
- The finish is often a texture overlay rather than a material edge; at 128 px
  the card type is not obvious enough.
- The AI layers exist, but the legacy frame/subject masters let them down. The
  layer contract is correct; the masters need to reach this bar.

## V3 proof acceptance

Status (2026-11-11): the Tux Plain and Holographic variants use this object.

- A front and back built from the layer stack, with the subject breaking the
  frame and the exact type readable at 750, 400, 214 and 128.
- The back has a header, short bio, field record, provenance and credits; it is
  not a second front.
- The card is shown in a binder page and/or stand at 1440 and 390 with no
  horizontal overflow.
- No invented marks, serials, Japanese filler or model-authored type.
- The saved front/back used by members is the same object approved in the Art
  Lab.

The v3 composer is `art/card-v3.mjs`. `V3_FINISH=plain` produces the Plain
object, which removes the holographic layer and changes the finish record; the
default produces the Holographic object. Reproof after a change, inspect the
sizes above, then publish through the Art Lab candidate flow. The publication
receipt is `.foilbury/evidence/card-v3/publish.json`.

## Reference file map

- `docs/CARD_LAYER_SYSTEM.md` — layer contract and production order.
- `docs/CARD_LANGUAGE.md` — historical v2 renderer and livery language.
- `art/card-render.mjs` / `art/compose.mjs` — composition and reference sheets.
- `src/components/player/LayeredCard.tsx` — web card object.
- `src/components/cards/CardViewer.tsx` — one viewer for every surface.
- `src/pages/play/card/[id].astro` — member card detail and back.
- `src/pages/play/collection.astro` — binder and collection display.
