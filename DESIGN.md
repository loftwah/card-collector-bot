# Foilbury design direction

## World

A collector's cabinet, not a generic dashboard. Paper, ink, brass, oxblood and bottle green; tactile card edges; archival labels; a quiet editorial voice. The landing page persuades, the player cabinet lets the cards lead, and management surfaces operate with restraint.

## Type

- Display: **Fraunces Variable** — headlines, card names, editorial titles.
- UI: **Manrope Variable** — body, controls, labels.
- Data: **IBM Plex Mono** — serials, IDs, odds, ledger and API examples.

## Colour and surfaces

Use the CSS tokens in `src/styles/global.css`; do not add a competing palette.

- Paper `#f4f0e6`, ink `#141512`, brass `#9b7238`, green `#245c4b`, oxblood `#6d2b2b`.
- Dark mode swaps to ink paper, warm type and brighter brass/green.
- Rarity is conveyed by text **and** colour. Do not rely on colour alone.
- Cards are the visual anchor: layered artwork, generous image area, restrained chrome.

## Components and motion

- Existing UI primitives in `src/components/ui/` and the project's `btn`, `badge`, `surface-flat`, `table` and `eyebrow` classes.
- Capsule reveal is satisfying but short; skip is always available. Respect `prefers-reduced-motion`.
- Focus is visible (`--focus`); icon-only controls need an accessible name.
- Empty, loading, error and disabled states are designed, not left blank.
- Admin screens distinguish **Bot administration** from **platform administration** in copy and navigation.

## Verification

Rendered checks use Playwright at desktop and mobile widths, keyboard focus, light/dark presentation and reduced motion. Impeccable's mechanical detector is run over changed UI files. A screenshot or design document alone is not acceptance.
