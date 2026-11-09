# Foilbury brand kit record

## Selected identity: Foil Standard

Foil Standard is the working Foilbury identity. It replaces the aqua/lime Signal
Fold system and the short-lived neutral/periwinkle Manrope direction.

- **Mark** — an original two-plane card fold: a paper F over a foil-blue plane
  with a chamfered top-right corner. The opaque icon is the app icon; the
  transparent glyph is the product mark.
- **Type** — Geist Serif 500 for display, Geist Sans for interface and body,
  Geist Mono for serials, odds, labels and provenance. All three are self-hosted
  under `public/fonts/geist/` and licensed under the SIL Open Font License 1.1.
- **Colour** — paper `#fafaf8`, ink `#0a0a0a`, graphite `#5b5b57`, rule
  `#e4e4df`, foil blue `#1f5eff`, and a holo edge
  `#8be9ff → #1f5eff → #b18cff → #e9ff8a`.
- **Voice** — a collector's archive, not a game dashboard. Sentence-case serif
  display, hairline rules, honest data and one signal colour.

The palette, type licensing, rationale and every generated rendition are recorded
in `public/brand/kit/manifest.json`. The selection and application state are in
`public/brand/kit/selection.json`.

## Generation

```sh
pnpm brand:generate
# node scripts/brand/generate-identity.mjs
```

The generator is deterministic and local. It renders the vector masters in real
Chromium with the self-hosted Geist faces, then writes the app icons, favicons,
PWA icons, Discord avatar and banner, Open Graph image, brand-kit specimens and
the generic card back. No paid generation, stock imagery or third-party art is
used.

The older `pnpm brand:generate:legacy` script is retained for the historical
Signal Fold, Bastion and Aperture boards. Those assets remain under
`public/brand/kit/` as reference and are not active identities.

## Shipping surfaces

- `public/brand/mark.svg`, `mark.png`, `mark-mono.svg`, `glyph.svg`
- `public/brand/wordmark.png`, `wordmark-reverse.png`, `wordmark.svg`, `lockup.svg`
- `public/brand/favicon-16.png`, `favicon-32.png`, `favicon-48.png`,
  `apple-touch-icon.png`, `icon-192*.png`, `icon-512*.png`
- `public/brand/discord-avatar.png`
- `public/brand/social-preview.jpg` and `public/brand/kit/social/og-1200x630.png`
- `public/brand/kit/banners/foil-standard-960x540.png` and `-1920x1080.png`
- `public/brand/card-back.webp`

The default share image is the Foil Standard Open Graph card. Public card shares
use the saved card render with its real dimensions; member/private shares fall
back to the brand image, never a private render.

Collection identity uses the collection's own `banner_url` or `logo_url`, never
a card render. `cover_url` is a card cover for card contexts only. Collections
without a banner use the designed mark tile.

## Historical note

Signal Fold was selected under delegated authority on 2026-11-04 and applied to
the Discord application at that time. The owner subsequently rejected it and the
periwinkle/Manrope replacement. Foil Standard was selected on 2026-11-09 after
the owner asked for a Vercel-grade monochrome identity using Geist Serif.

The former board recorded the preceding application icon, cover and description
for rollback. The Loftwah guild icon remains unchanged because it belongs to the
wider server identity; the server banner remains blocked by the guild's Boost
entitlement. The bot profile banner is a Developer Portal surface.

## Verification

- `pnpm check` passes (7 gates).
- `pnpm build` produces the production artifact.
- Light/dark desktop and 390px captures are under `.foilbury/brand-audit/`.
- The final application icon, cover and description are applied through Discord's
  official `PATCH /applications/@me` endpoint and recorded in
  `public/brand/kit/selection.json`.
