# Foilbury design direction

## World

A collector's field guide crossed with a signal room. The collection is tactile
and editorial; the interface is crisp, geometric and confident. The reference
is a modern infrastructure product's clarity, not its colours: strong rules,
visible state, honest data, no decorative dashboard fog. Foilbury is not a
Cloudflare clone and never uses Cloudflare orange.

## Type

- Display: **Manrope** — heavy, tight, uppercase where it carries a decision.
  Self-hosted `public/fonts/manrope-latin.woff2`.
- UI: **Geist Sans** — body, controls, labels.
- Data and small labels: **Geist Mono** — serials, IDs, odds, ledger rows.
- Card renders keep their own authored type (Fraunces / Manrope / IBM Plex Mono)
  because the card is a separate printed object.

## Foilbury Signal palette

The signature is **deep current + electric aqua + ice + signal lime**, on warm
bone paper in light mode and near-black green in dark mode.

| Token         | Light                 | Dark                  | Use                                     |
| ------------- | --------------------- | --------------------- | --------------------------------------- |
| Deep current  | `#044e4a`             | `#8af2e5`             | anchors, collection grounds             |
| Electric aqua | `#00a99c` / `#2ce3d3` | `#4fe0d1` / `#7cf6e8` | primary signal, progress, active        |
| Ice           | `#c8f4ee`             | `#0d3b35`             | quiet surfaces, secondary text on dark  |
| Signal lime   | `#c9f25f`             | `#d6ff79`             | one high-energy accent, stamps, mastery |
| Carbon        | `#07110f`             | `#07110f`             | admin band, card back, type             |
| Bone          | `#eff5f1`             | `#e9f5f0`             | paper / light type                      |

Use colour as a second channel. Rarity, progress and state always carry text,
shape or a label as well. Do not use aqua as a generic "success" green; keep
`--green` for positive ledger states.

## Geometry

- Sharp, mostly square surfaces. Radii stop at 3px for controls and 6px for a
  genuinely card-like object.
- Two hard rules the product can rely on: the 4px `signal-rule` strip and the
  3–4px section rule. They are composition, not decoration on every card.
- The brand kit uses the `Signal Fold` mark as the canonical working identity.
  Four reviewed marks exist; do not mix them on one surface.

## Collections and cards

- A collection has a mark, palette, description, source boundary and frozen
  release roster. The card front and designed back carry the collection emblem.
- Fronts are art-led; backs are designed information objects with a concise bio,
  typed context and credits. No wall of wiki text on the printed face.
- Finish is material and effect: Plain, Silver, Gold, Holographic. Holographic
  Gold is Holographic, not a second Gold. Never present a CSS tint as a finish.
- 3D inspection is on-demand, CSS-based, pointer/keyboard operable and stops
  offscreen. Reduced motion gets a static front/back. It never changes ownership.
- Album views show unique subjects, owned copies, duplicates and each core
  finish separately. Roster completion is not finish mastery.
- One web card contract: a 5:7 object with a reserved art window and information
  band. Controls sit outside the object, never over the serial or metadata.
  Type is container-relative. Square opaque avatars may use a medallion; every
  other source is contained, not cropped by an aspect-ratio guess. Member
  surfaces display the saved front/back renders; only the admin composition
  preview re-composes private layers.

## Surfaces

- Player: the cards lead. Progress is legible without turning the album into a
  dashboard. Binder slots make missing subjects obvious; finish bars name the
  next target. Page, panel, raised and card-object surfaces are distinct in both
  themes; a dark panel must not merge into a dark page. Navigation is five
  primary destinations plus a deliberate More menu, not twelve equal tabs.
- Studio: operational, explicit scope, auditable actions. The dark band plus
  aqua signal separates it from the member album without hiding the product.
- Platform Administration: quiet, dense, high-contrast tables. It remains a
  separate Access-protected surface.
- EmDash: editorial only. Foilbury links to it; it does not imitate it.

## Motion and sound

One authored reveal per opening: committed receipt, anticipation, material
reveal, result. Skip and reduced-motion are always available. Replaying is free
and cannot redraw. Sound is opt-in and off by default. No continuous album
renderer, autoplay audio or compulsory cinematic.

## Components and state

- shadcn/ui primitives live in `src/components/ui`, configured through
  `components.json`; do not add a second primitive library.
- Keep `btn`, `badge`, `surface`, `field`, `input`, `table` and `eyebrow`
  compatible with existing screens.
- Empty, loading, error, disabled, expired and preview-only states are designed.
- Focus is visible; icon-only controls have accessible names; target sizes are
  at least 44px where the primary action lives.
- Public and member/private share previews are visually distinct and never use
  the same metadata.

## Verification

Render at desktop, tablet, mobile and Discord thumbnail size. Check light/dark,
200% zoom, reduced motion, keyboard focus and contrast. Run the mechanical
detector, but a clean detector is not acceptance. Record the actual screenshots
and videos under `.foilbury/` or the approved evidence folder; do not commit
private member media.
