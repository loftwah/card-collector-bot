# Foilbury design direction

## World

A collector's cabinet, not a generic dashboard. Paper, ink, brass, oxblood and bottle green; tactile card edges; archival labels; a quiet editorial voice. The landing page persuades, the player cabinet lets the cards lead, and management surfaces operate with restraint.

## Type

- Display: **Geist Serif** — prominent display headings, card names and collection moments. Self-hosted variable WOFF2 with Georgia/Times fallback; no synthetic bold.
- UI: **Geist Sans** — body, controls and labels.
- Data: **Geist Mono** — serials, IDs, odds and ledger rows.

## Colour and surfaces

Use the CSS tokens in `src/styles/global.css`; do not add a competing palette. The light brass text token is deliberately darker than the decorative foil so small labels meet WCAG AA on paper.

- Paper `#f4f0e6`, ink `#141512`, brass `#7d5a26` (text) / `#c69a58` (bright), green `#245c4b`, oxblood `#6d2b2b`.
- Public showcase energy: coral `#c53a24` / `#e0492f`, saffron `#b8791f` / `#f2b544`, teal `#0e5b53`, plum `#4a1e4d`. These extend the cabinet rather than replacing it; admin surfaces stay quieter.
- Dark mode swaps to ink paper, warm type and brighter brass/green.
- Rarity is conveyed by text **and** colour. Do not rely on colour alone.
- Cards are the visual anchor: layered artwork, generous image area, restrained chrome.

## Collections and cards

- A collection has a mark/logo, name, description, status and explicit card membership. Global and Bot-owned collections share the same visual language.
- Card details show a spoiler-safe intro, opt-in full profile, typed attributes, source context, collection mark, provenance and a real card-back view. The web can flip and inspect; Discord receives the published single-image render and can show front/back/details without another draw.
- Layered artwork is authored from background → subject → material → frame → effect → text. A published render is the Discord-safe single image; the private source layers stay on the web.

## Components and motion

- shadcn/ui primitives are configured through `components.json` and `src/components/ui/`; Tailwind tokens map to the Foilbury palette.
- Existing project classes `btn`, `badge`, `surface-flat`, `table`, `field`, `input` and `eyebrow` remain compatible.
- Do not place a kicker or eyebrow label above a heading. The heading carries its own weight; use a quiet summary line only when the number is decision-useful.
- Capsule reveal is satisfying but short; skip is always available. Respect `prefers-reduced-motion`.
- 3D inspection is on-demand on card detail only: CSS 3D, no canvas per tile, pointer/keyboard tilt, front/back, reduced-motion static fallback, and a flat first paint. It never changes ownership, finish or serial.
- Focus is visible (`--focus`); icon-only controls need an accessible name.
- Empty, loading, error and disabled states are designed, not left blank.
- Admin screens distinguish **Bot administration** from **Platform Administration** in copy and navigation.

## Verification

Rendered checks use Playwright at desktop, tablet and mobile widths, keyboard focus, light/dark presentation, 200% zoom-equivalent and reduced motion. axe WCAG 2 AA checks must have no serious/critical findings. Impeccable's mechanical detector is run over changed UI files; a zero detector result is not design acceptance.
