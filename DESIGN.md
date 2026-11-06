# Foilbury design direction

## World

A personal card library and scrapbook. The collection artwork, the cards and the
collector's own arrangement carry the personality; the app shell is quiet,
precise and contemporary. This replaces the rejected Signal Fold identity and
the muddy paper/brass/olive treatment. Do not reinstate Signal Fold because an
older document calls it selected.

## Type

- **Manrope** for display, headings, body, controls and labels.
- System monospace for serials, odds, ledger figures and small technical
  metadata.
- Card renders keep their own authored typography. The card is a separate
  printed object and does not inherit app type.

Body 16px, secondary labels 14px, desktop headings 32px, phone headings 24px.
Use tabular figures for balances and quantities. Do not scale type with viewport
width.

## Palette

Dark is the member default. Light is a complete equivalent. The artwork supplies
most colour; periwinkle is the only app action accent.

| Role | Dark | Light |
| --- | --- | --- |
| Canvas | `#11141B` | `#F6F7FB` |
| Surface | `#1A1F2A` | `#FFFFFF` |
| Raised | `#242B39` | `#ECEFF6` |
| Text | `#F4F6FC` | `#1C2230` |
| Muted | `#B6BECE` | `#526078` |
| Border | `#65738E` | `#7C879C` |
| Action | `#A8B8FF` | `#4657C8` |
| On action | `#11182F` | `#FFFFFF` |
| Focus | `#C5D0FF` | `#3445A8` |
| Success | `#8FE0BB` | `#176344` |
| Warning | `#F2CB85` | `#765000` |
| Danger | `#FFADB7` | `#AD2540` |

Keep app accent, status, collection identity, rarity and physical finish as
separate semantic channels. A Gold finish never means warning or rarity. Never
use colour alone for state.

## Geometry

Controls 8px, panels 12px, large composition surfaces 16px. Keep touch targets
at least 44px. The collectible object uses the canonical 5:7 frame, not an app
panel radius.

## Shell and navigation

The player shell is one compact top bar and five primary destinations:

1. **Home** — continue collecting, one next action, recent acquisition.
2. **Collections** — library, My cards, Wishlist.
3. **Open** — choose and open a capsule.
4. **Trades** — offers, history, NPC collectors.
5. **Profile** — showcase, customisation, sharing, account.

The Foil balance is a header pill that opens the wallet; it is not a sixth tab.
A deliberate More menu owns missions, achievements, gifts, rewards,
preferences, help and account security. Do not stack a second public header,
a cabinet bar and a page nav on the same viewport.

The implementation lives in `src/layouts/PlayerLayout.astro` and the
`player-*` rules in `src/styles/global.css`.

Studio uses a dark operational band with explicit assigned scope. Platform
Administration remains a separate, denser, Access-protected shell.

## Collections and cards

- A collection has a mark, palette, description, source boundary and frozen
  release roster.
- Fronts are art-led; backs are designed information objects. No wall of wiki
  text on the printed face.
- Finish is material and effect: Plain, Silver, Gold, Holographic. Holographic
  Gold is Holographic, not a second Gold. Never present a CSS tint as a finish.
- 3D inspection is on-demand, CSS-based, pointer/keyboard operable and stops
  offscreen. Reduced motion gets a static front/back. It never changes
  ownership.
- Album views separate unique subjects, owned copies, duplicates and each core
  finish. Roster completion is not finish mastery.
- One web card contract: a 5:7 object with a reserved art window and information
  band. Controls sit outside the object, never over the serial or metadata.
  Type is container-relative. Square opaque avatars may use a medallion; every
  other source is contained, not cropped by an aspect-ratio guess. Member
  surfaces display saved front/back renders; only the admin composition preview
  re-composes private layers.

## Surfaces

- Player: the cards lead. Progress is legible without becoming a dashboard.
  Binder slots make missing subjects obvious; finish bars name the next target.
  Page, panel, raised and card-object surfaces are distinct in both themes.
- Studio: operational, explicit scope, auditable actions.
- Platform Administration: quiet, dense, high-contrast tables.
- EmDash: editorial only. Foilbury links to it; it does not imitate it.

## Motion and sound

One authored reveal per opening: committed receipt, anticipation, material
reveal, result. Skip and reduced motion are always available. Replaying is free
and cannot redraw. Sound is opt-in and off by default. No continuous album
renderer, autoplay audio or compulsory cinematic.

## Components and state

- shadcn/ui primitives live in `src/components/ui`, configured through
  `components.json`; do not add a second primitive library.
- Keep `btn`, `badge`, `surface`, `field`, `input`, `table` and `eyebrow`
  compatible with existing screens.
- Empty, loading, error, disabled, expired and preview-only states are designed.
- Focus is visible; icon-only controls have accessible names; primary targets
  are at least 44px.
- Public and member/private share previews are visually distinct and never use
  the same metadata.

## Current implementation status

The player shell, five-destination navigation, compact header, palette,
typography, radii, home hierarchy and light/dark treatment are implemented. The
remaining member, Studio, Platform and Discord surfaces still need to be
migrated screen by screen from the Stitch reference set. The Stitch artwork is
concept reference, not final collection art.

## Verification

Render at desktop, tablet, mobile and Discord thumbnail size. Check light/dark,
200% zoom, reduced motion, keyboard focus and contrast. Run the mechanical
detector, but a clean detector is not acceptance. Record actual screenshots and
videos under `.foilbury/` or the approved evidence folder; do not commit private
member media.
