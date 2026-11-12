# Foilbury card layer system

Status: **canonical owner direction (2026-11-11).** Layered card composition is
the default card method. A flat whole-card AI image is a comparison output, not
the default production object.

This document exists so the layer model is not re-litigated in every brief.
Read it before designing a card, writing an image prompt, adding a card type,
or changing the Art Lab.

## The rule

A card is a stack of layers, not one generated picture. The layers can be AI
generated, sourced, or authored in code, but they are separate assets with their
own provenance. The card type (border, material, special edition, holographic
finish) is a layer or a layer set, not a different whole card.

The same subject can therefore become a Plain card, a Wedding card, a Neon card
or a Gold card without regenerating the character. A holographic effect is an
overlay, not a CSS tint. A special type is a frame/overlay set, not a new
character image.

## Stack order

Bottom to top. The composer is the single source of truth for geometry.

| #   | Layer key  | What it is                                                                 | Source                                           | Alpha / blend                                                  |
| --- | ---------- | -------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| 1   | `scene`    | Full-bleed environment, key art or paper ground                            | AI or sourced real scene                         | Opaque, fills the canvas/art window                            |
| 2   | `subject`  | The real character cutout                                                  | Real sourced art; AI only for a reviewed variant | Alpha cutout, never cropped by an aspect guess                 |
| 3   | `material` | Paper, silver, gold or holo surface                                        | AI texture or authored material master           | `soft-light` / `overlay` / `screen` at recorded opacity        |
| 4   | `frame`    | Card border, rails, corners, information band, type wells                  | AI frame master or authored livery frame         | Transparent centre/hole; opaque rails; `over`                  |
| 5   | `effect`   | Holographic/prismatic foil, foil stamp, special overlay                    | AI texture or authored effect master             | Alpha; `screen`/`overlay`; confined to the frame/material mask |
| 6   | `type`     | Exact copy: name, role, collection, rarity, finish, print code, provenance | Code only, never AI                              | Opaque, top of stack                                           |
| 7   | `seal`     | Real collection mark, set symbol, finish seal                              | Real supplied mark or authored seal              | Opaque or foil                                                 |
| 8   | `back`     | Designed back record; reuses paper/frame/effect/type layers                | Code + real mark                                 | Opaque                                                         |

The front and back are two compositions of the same layer system. A back is not
a second CMS page and not a wall of wiki text.

## Layers are assets

Every layer is stored with:

- a stable `layer_key` (`scene`, `subject`, `frame`, `effect`, `type`, `seal`);
- the asset id and URL;
- width, height, mime and SHA-256;
- its provenance: model, prompt, references, seed if any, and `official:false`;
- its blend mode, opacity, mask and z-order when it is an overlay;
- whether it was AI generated, sourced, or authored by code.

The composed card records the ordered layer ids and the composer version. A
candidate is not rewritten in place; a new layer set creates a new candidate or
a new revision.

## Card types are layer sets

- **Plain / Silver / Gold / Holographic** are material + frame + effect layers.
  `Holographic` is the finish label; never `Gold · Holographic`.
- **Wedding, Fairy, Gothic, Neon, Broadcast, Street, Atelier, Cinematic,
  Editorial, Archive, Manga, Minimal** are art directions. They change the
  scene, frame ornament and optional special overlay.
- **Special editions** (a convention card, a tournament stamp, a crossover
  ribbon) are an extra frame/effect/seal layer on top of the base card. They do
  not require a new character render.
- The finish and special type must be readable at 128 px from the frame edge,
  seal and label, not only from a colour tint.

## Alpha, holes and masks

The frame layer is the main "hole" mechanism:

- The frame master has an opaque outer rail/corners/information band and a
  fully transparent art window. The scene and subject sit underneath and show
  through the hole.
- The effect layer is masked to the frame rails and/or the material band, or is
  applied at a recorded opacity over the whole card. It must not wash out the
  exact type.
- A special overlay can use a transparent centre, a cut-out ribbon, or an alpha
  mask; it must never cover the name, rarity, finish or print code.
- Masks are authored as alpha PNG/WebP or an SVG mask. Chroma-key masters are
  acceptable only after the key is removed and the alpha edge is inspected.
- Blend modes are allowed (`over`, `screen`, `overlay`, `soft-light`); CSS
  gradients and a flat tint are not a substitute for a material or effect layer.

## AI generation rules

- Generate the scene, subject variant, frame ornament and effect texture as
  **separate images**. Do not ask one model call to invent the whole card.
- Use the real subject art and the real collection mark. The subject's face,
  hair, outfit, props and silhouette must stay consistent; generate a base
  subject and edit that exact base for variants.
- The exact copy is always code-set. Never let the image model author the name,
  rarity, finish, print code, serial or provenance.
- A frame prompt must specify a clean, empty centre for the art window and no
  lettering; the centre is made transparent before composition.
- An effect prompt must describe a material/texture only (holo foil, prismatic
  diffraction, embossed paper), not a card.
- Inspect the composed card at 750×1050, 400×560, 214×300 and 128×179. A layer
  that only looks good at 750 is not finished.
- No invented official logos, fake serials, Japanese filler or gibberish. A
  card with model-authored type is a failed card; regenerate or fix the layer.

## Review and data flow

1. A brief selects the subject, collection, finish, art direction and any
   special type.
2. The runner or operator creates a layer set: scene, subject, frame, effect,
   seal.
3. The composer builds the front and back from the ordered stack and code type.
4. The Art Lab shows the composed card **and** the layer stack: each layer
   thumbnail, label, source, blend/opacity, and a toggle to inspect it.
5. A thumb up/down and optional comment apply to the composed card; a comment
   may name a layer ("frame too heavy", "holo too strong").
6. Approval records the chosen direction and layer set; publish writes the
   saved composed front/back renders. The previous renders are snapshotted for
   rollback.
7. Member surfaces show the saved composed front/back, never a live recompose of
   private source layers.

## Implementation map

- `art/compose.mjs` — the composer: scene → subject → material → frame →
  effect → exact text. Geometry and layer order live here.
- `art/card-v3.mjs` — the worked v3 proof: AI scene + cutout, authored frame and
  type, optional holographic edge, designed back. `V3_FINISH=plain` removes the
  holo layer and records Plain. Use it as the reference for the v3 anatomy, not
  as a second shared renderer.
- `art/proofs/` holds the original v3 proof exports for the operator scripts.
  New proof renders go into `.foilbury/evidence/card-v3/proofs/`. Published
  faces are delivered through the approved card's media routes.
- `art/card-render.mjs` — reference sheets, publishing metadata and comparison;
  not the mandatory final composition.
- `art/layers/` — authored and AI layer masters (frames, materials, effects,
  marks). AI layer sets live under `art/layers/ai/`.
- `public/art/layers/` — served layer assets used by the web preview.
- `src/components/player/LayeredCard.tsx` — the web composition for admin
  preview; member surfaces use saved renders.
- `src/components/cards/CardViewer.tsx` — the one viewer; layer inspection
  belongs here, not a second modal.
- `scripts/art-lab-runner.mjs` — prepares the reference sheet and calls the
  provider; it must return a layer set, not only a flat front.
- `src/server/modules/art-lab.ts` — candidate metadata stores the ordered layer
  ids, blend/mask/opacity, and provenance.

## Acceptance

- The front and back are real 5:7 objects at 750×1050; masters are 1500×2100.
- The frame has a true transparent art window; the subject is visible through
  the hole and is never clipped by an aspect-ratio guess.
- The finish/type is distinguishable at 128 px.
- The layer stack is inspectable in the Art Lab; each layer has a thumbnail and
  provenance.
- The exact copy is correct on both faces; no model-authored type.
- The composed card survives a real Discord 214×300 inline preview.
- The saved member render matches the approved composed render.

## Non-goals and anti-patterns

- A single flat whole-card image as the default production method.
- A CSS tint presented as a finish.
- A special edition that is only a recolour of the same frame.
- Model-authored name, rarity, finish, print code, serial or provenance.
- A second card catalogue outside Foilbury.
- Recomposing private layers on a member surface; use the saved render.
- Inventing an official mark or adding Japanese filler text.
- Treating a reference sheet or renderer comparison as the finished card.
