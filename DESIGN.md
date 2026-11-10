# Foilbury design direction

## World

A collector's archive crossed with a signal room. The public shelf is an
editorial index, not a game dashboard: huge Geist Serif headlines, hairline
rules, honest data and one electric foil edge. The interface is crisp and
monochrome; the cards supply the colour. The reference is a modern
infrastructure product's clarity and confidence, not its marks. Foilbury is not
a Vercel clone and never uses Vercel's symbol.

The working identity is **Foil Standard**. The mark is an original two-plane
card fold: a paper F over a foil-blue plane with a chamfered top-right corner.
The historical Signal Fold, Bastion and Aperture boards remain under
`public/brand/kit/` as reference, not as active identities.

## Type

- Display: **Geist Serif** — 500 weight, sentence case, tight tracking, generous
  scale. This is the editorial voice. Do not set controls or data in it.
- UI: **Geist Sans** — body, navigation, controls and labels.
- Data and small labels: **Geist Mono** — serials, IDs, odds, ledger rows and
  provenance. Mono is for data, not a costume for “technical”.
- Card renders keep their own authored type (Fraunces / Manrope / IBM Plex Mono)
  because the card is a separate printed object.
- All three web faces are self-hosted under `public/fonts/geist/` and licensed
  under the SIL Open Font License 1.1.

## Foil Standard palette

Paper, ink, graphite and a hairline rule carry the surface. Foil blue is the one
signal: links, focus, the mark edge and active state. The holo gradient is a
material edge, never text and never a fill on a large surface.

| Token     | Light                                   | Dark      | Use                                  |
| --------- | --------------------------------------- | --------- | ------------------------------------ |
| Paper     | `#fafaf8`                               | `#0a0a0a` | page ground                          |
| Panel     | `#ffffff`                               | `#111111` | raised panel                         |
| Ink       | `#0a0a0a`                               | `#f5f5f2` | type, feature fields, primary button |
| Graphite  | `#5b5b57`                               | `#a3a39e` | secondary type                       |
| Rule      | `#e4e4df`                               | `#2a2a2a` | hairline structure                   |
| Foil blue | `#1f5eff`                               | `#8fb0ff` | the one signal edge                  |
| Holo edge | `#8be9ff → #1f5eff → #b18cff → #e9ff8a` | same      | 2–4px edge only                      |
| Success   | `#0b7a4b`                               | `#7ee2b8` | positive ledger state                |
| Alert     | `#c42b1c`                               | `#ff9a9a` | destructive and error state          |

Use colour as a second channel. Rarity, progress and state always carry text,
shape or a label as well. Foil blue is not a generic success green and not a
decorative wash. Do not tint card artwork to match the interface.

## Geometry

- Sharp, mostly square surfaces. Panels and card objects stop at 3–6px; pill
  controls are the one deliberate round form.
- Hairline rules do the structural work: 1px section rules, 3px `holo-rule`
  strips and a 2–4px foil edge on the mark or a single hero object.
- The mark is a paper F over a foil plane with a chamfered fold. Use the opaque
  icon where the platform applies its own mask; use the transparent glyph in the
  product shell. Do not add a glow or second palette to the mark.
- The brand kit uses **Foil Standard** as the canonical identity. Do not mix the
  historical marks on one surface.

## Identity avatars

The account avatar is separate from the collector portrait. A member chooses a
Discord avatar (cached privately), a private uploaded photo, or one of the
AI-assisted paper-craft Keeper avatars. The Keeper is the universal fallback;
letter monograms and flat vector portraits are rejected. The header, profile,
share page and Discord profile card all use the same chosen avatar. See
`docs/ACCOUNT_IDENTITY.md`.

## Collections and cards

- A collection has a mark, palette, description, source boundary and frozen
  release roster. The card front and designed back carry the collection emblem.
- A collection is represented by its own `banner_url` or `logo_url`, never by
  one of its card renders. `cover_url` is a card cover for card contexts only;
  the shell must not present it as the collection's identity. Collections
  without a banner use the designed mark tile.
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

## Card browsing and inspection

- One shared viewer serves every signed-in card surface. The card image is the
  trigger; Download, Inspect and Edit stay separate controls. The viewer shows
  the saved front and back, never a recomposed private layer, and carries the
  facts needed to identify the object: name, collection, style, finish, method,
  model, status, dimensions, print code, serial, audience and provenance.
- Browsing surfaces are proof walls: large card images on a 2/3/4-column
  masonry or contact sheet, one title line and one metadata line, with status,
  method and style as small overlays. Creation, intent, job history and long
  provenance are progressive disclosure.
- Six named art directions are the shared vocabulary: Atelier, Cinematic,
  Editorial, Archive, Manga, Minimal. These are directions; Plain, Silver,
  Gold and Holographic remain finishes. A candidate, its brief, its approval
  and the published render all carry the same style key.
- Tool headings use Geist Sans. Display type stays for editorial and hero
  moments, not panel titles, filters or data.
- The viewer is a mobile full-screen sheet and a desktop centred viewer. Focus
  is trapped and visible; Escape closes and returns focus to the card; arrow
  keys page siblings; reduced motion removes the entrance.

## Surfaces

- Public shelf: the cards lead. The landing page is an editorial spread with a
  card fan, a hairline collection index and black feature bands; it is not a
  dashboard and not a wall of equal cards.
- Player: progress is legible without turning the album into a dashboard.
  Binder slots make missing subjects obvious; finish bars name the next target.
  Page, panel, raised and card-object surfaces are distinct in both themes.
- Studio: operational, explicit scope, auditable actions. The dark band plus
  foil-blue signal separates it from the member album without hiding the product.
- Platform Administration: quiet, dense, high-contrast tables. It remains a
  separate Access-protected surface.
- EmDash: editorial only. Foilbury links to it; it does not imitate it.
- Sharing: the default Open Graph image is the Foil Standard card; public card
  shares use the saved card render with its real dimensions. Member/private
  shares fall back to the brand image, never a private render.

## Motion and sound

One authored reveal per opening: committed receipt, anticipation, material
reveal, result. Skip and reduced-motion are always available. Replaying is free
and cannot redraw. Sound is opt-in and off by default. No continuous album
renderer, autoplay audio or compulsory cinematic.

The public landing uses one quiet entrance: the hero cards rise once with a
staggered fade. Hover lifts the card object; it does not spin or glow.

## Components and state

- shadcn/ui primitives live in `src/components/ui`, configured through
  `components.json`; do not add a second primitive library.
- Keep `btn`, `badge`, `surface`, `field`, `input`, `table` and `eyebrow`
  compatible with existing screens. Buttons are pills; the primary button is
  ink on paper, not foil blue.
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
