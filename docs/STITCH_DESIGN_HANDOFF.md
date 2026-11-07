# Stitch design handoff — working record

Status: 7 November 2026. Design exploration in progress; nothing here is
deployed or accepted as the final product.

Prompts 00–15 and platform screens G01–G05 have been generated in the Foilbury
Stitch project. The daily quota reset and G04, G05 and Discord boards D01–D05
were generated. The Prompt 16 copy corrections were applied; the remaining
state variants are outstanding. Exact screen IDs and the resume point are in
[`STITCH_SCREEN_INDEX.md`](./STITCH_SCREEN_INDEX.md).

## Authority and direction

Issue #26 rejects the Signal Fold identity and delegates ordinary Foilbury
design decisions to agents. Issue #12 and #40 define the product as a personal
card scrapbook/library: collection artwork and cards lead, while the Foilbury
shell stays quiet and proportional.

The repository's root `DESIGN.md` still records the old Signal Fold system. It is
historical until the implementation pass replaces it. The Stitch working
direction is the supplied
`.foilbury/stitch/handoff/Foilbury-Stitch-Handoff/DESIGN.md` and uses:

- neutral blue-black dark surfaces and cool off-white light surfaces;
- restrained periwinkle/indigo for actions;
- Manrope for UI type, with tabular figures for balances and quantities;
- 8px controls, 12px panels and 16px large composition surfaces;
- a canonical 5:7 card object with reserved art and information bands;
- five primary phone destinations: Home, Collections, Open, Trades, Profile;
- the Foil balance as a header pill that opens the wallet, not a sixth tab.

Do not describe this direction as personally approved by the owner.

## Stitch workspace

| Item | Value |
| --- | --- |
| Project | `projects/16492410293987266649` — **Foilbury** |
| Project type | `TEXT_TO_UI_PRO` |
| Design system asset | `198bcf8d443c4cce927d439f7d02c480` (from the supplied `DESIGN.md`) |
| Design system source screen | `projects/16492410293987266649/screens/4984011205320850125` |
| Local design system source | `.foilbury/stitch/handoff/Foilbury-Stitch-Handoff/DESIGN.md` |
| Local review renders | `.foilbury/stitch/received/` |

The earlier reconstructed asset `74e0599438cb4eb79757db8615e55158` is
superseded. All later screens must use `198bcf8d443c4cce927d439f7d02c480`.

The generated screens are returned as session outputs with their own screen
IDs. Stitch's current project listing does not yet show them on the canvas, so
each generated screen is downloaded as HTML and rendered locally at 390×844 for
review. The Stitch project remains the single design home.

## Foundation and first batch

### DS01 — Component reference board

- Final screen: `64ca801317934eeb812017e1caa8c151`
- Review render: `.foilbury/stitch/received/ds01b-1440.png`
- Local HTML: `.foilbury/stitch/received/ds01b.html`

The board establishes the shared light/dark tokens, 5:7 card contract,
finish/print selectors, collection tile, Foil balance and ledger, trade protocol,
phone and desktop shells, and the honest async-state matrix. Review fixes:
`48 / 40` changed to `18 / 40`, truncated print labels corrected, and a light
phone shell added.

### Prompt 01 — collector home, collections and albums

Principal phone and desktop frames are complete. Important state variants are
still to do.

| Screen | Phone | Desktop |
| --- | --- | --- |
| C01 Collector home | `d039c3ae5de749f38c9cb414b70201ae` | `1e60167a643c400ab235c7bf2226f42f` |
| C02 Collection library | `ec328a9f6fea40cca2dbac12409a341a` | `e588c331d2e84c8aaa10063b932a166b` |
| C03 Album / full-set binder | `212aaaeee62a4fcab1a3762f4bb4484f` | `af83de81f84e4df1845081abd524b392` |
| C04 My cards | `227018729e874eb4a51df14a06fb8a99` | `493c10590eb946b6b3d61415baeea8a7` |

Local review renders: `c01p-phone.png`, `c02p-phone.png`, `c03p-phone.png`,
`c04f-phone.png`, `c01dfinal.png`, `c02df-desktop.png`, `c03df-desktop.png`,
`c04dc-desktop.png`.

What the batch establishes:

- a consistent shell: Foilbury wordmark, Bot switcher, coin + Foil balance,
  avatar, and the five destinations Home, Collections, Open, Trades, Profile;
- C03 tabs: Album, All cards, About;
- C04 labels total copies, distinct subjects, duplicates and exact-copy actions;
- cards keep 5:7 geometry and controls sit outside the card object.

Defects fixed during review:

- each screen had invented its own navigation (`Library / Binder / Cards`);
- C02 and C04 put the avatar before the wordmark and C04 uppercased it;
- C04 printed its screen ID in the player UI;
- C02's header overflowed the avatar off the 390px edge;
- the balance alternated between `1,240 FOIL`, a pulsing dot and a coin;
- the desktop screens printed route IDs and introduced `vault`, `mints`,
  `protocol credit`, invented odds, a capacity maximum and a physical-print
  milestone. These were replaced with plain collector language.

Known gaps:

- C01-C04 state variants are not yet drawn: fresh account, near-complete,
  failed summary, no eligible opening, changing Bot; loading, no collections,
  no matches, paused collection, permission change; zero/partial/complete set,
  retired release, multiple prints; empty album, many duplicates, reserved copy,
  partial thumbnail failure.
- The generated covers and card art are concept fixtures, not the real Bubbles,
  Fighter or Protocol 11 assets. Stitch's text-to-UI MCP path cannot ingest those
  local assets, so they are explicitly design-only placeholders until the
  implementation pass.
- The light theme is proven on DS01, but not yet on a full product screen.

## Screen batches

The 17 prompts from the handoff pack are the source of the screen-specific
copy. The pack is unpacked under `.foilbury/stitch/handoff/`.

| Batch | Screens | Status |
| --- | --- | --- |
| 00 Foundation | Shared component and state board | Complete (DS01) |
| 01 Collector core | C01, C02, C03, C04 | Phone + desktop complete; states pending |
| 02 Card detail | C05, C06, C07 | Phone + desktop complete; states pending |
| 03 Opening and Foil | O01, O02, O03, E01 | Phone + desktop complete |
| 04 Missions and gifts | E02, E03, E04 | Phone + desktop complete |
| 05 Trades and NPCs | T01, T02, T03, T04 | Phone + desktop complete |
| 06 Identity and sharing | U01–U05 | Phone + desktop complete |
| 07 Public and auth | P01–P05 | Phone + desktop complete |
| 08 Journal and help | P06–P09 | Phone + desktop complete |
| 09 Preferences and Bots | A01–A03 | Phone + desktop complete |
| 10 Studio collections | S01–S05 | Desktop Studio workspace complete; compact variants optional |
| 11 Studio rewards | S06–S09 | Desktop Studio workspace complete |
| 12 Studio people and audit | S10–S13 | Desktop Studio workspace complete |
| 13 Studio supporting | S14–S17 | Desktop Studio workspace complete |
| 14 Platform | G01–G05 | G01–G05 complete |
| 15 Discord boards | D01–D05 | Five desktop boards complete |
| 16 Consistency and prototype | All screens, states and journeys | Copy corrections applied; state variants and compact Studio/Platform boards remain |

## Review protocol

For each batch:

1. Generate against the shared design system in the Foilbury project.
2. Download the HTML and screenshot for each returned screen.
3. Render at 390×844 and at desktop width; check 320px, 200% zoom and reduced
   motion where the screen has motion.
4. Check light and dark, loading/empty/no-match/failure/pending/preview/owned/
   locked/expired states named in the prompt.
5. Record defects before the next batch. A clean Stitch render is not design
   acceptance.
6. Keep only approved screen references in the implementation handoff; keep
   private/member evidence under `.foilbury/`.

## Implementation handoff

Build the agreed components once, then use them throughout Foilbury. The
implementation pass must also replace the stale Signal Fold tokens in the app,
not just add a new palette beside them.

## Storybook

Storybook 10.6.6 is configured with `@storybook/react-vite`, the real
`src/styles/global.css`, the project’s `@` alias, the Tailwind Vite plugin,
`@storybook/addon-a11y`, `@storybook/addon-docs` and dark/light theme support.
The first batch imports actual React components and real fixture states:
Foundations, Controls, PublishedCard, CardInspector, DailyMissions,
ProfileCustomiser, RewardCenter, and member screen compositions. `pnpm
storybook` runs the local catalogue; `pnpm storybook:build` produces the static
build. Astro pages remain Astro.

The handoff’s implementation note sets the boundaries:

- Use a React/Vite integration compatible with the current Astro/React project;
  do not force an unrelated framework upgrade.
- Stories import the actual production components, shared styles/assets and
  deliberate fixture data. The app must never import stories or Storybook
  tooling.
- Group the catalogue into Foundations, Controls, Foilbury components and
  Screen compositions.
- Start with the existing equivalents of Button/FormField/Dialog/Sheet,
  CollectionTile/BinderGrid, CanonicalCard with front/back, print/finish and
  exact-copy selectors, FoilBalance and opening result, TradePanel and
  ProfileComposition.
- Cover default, long names, narrow layout, missing artwork, loading,
  failure/retry, owned/preview and authorised/restricted presentation.
- Add viewport, light/dark theme, reduced-motion and accessibility panels.
- Keep native Astro routes and server integration in the application preview.
  Do not rewrite Astro pages as React just for the catalogue; the community Astro
  adapter cannot rerender native Astro Controls.
- Build and host the catalogue separately, with development dependencies and its
  own output. A normal product deploy does not build every catalogue.
- `pnpm storybook` and `pnpm storybook:build` are now available after the first
  component batch.

Astro page components are not rendered directly by Storybook. Do not add a
second component library or a parallel design system to make them fit.
