# Foilbury guided walkthrough

`pnpm demo` is the repeatable product walkthrough. It drives the real local app
in Chromium, captures a private storyboard, and checks the screens for broken
images, horizontal overflow and console errors. Use it when you need to see the
whole experience without setting up each screen by hand.

## Run it

```sh
pnpm demo        # headless; writes the storyboard and prints the path
pnpm demo:show   # headed browser; opens the storyboard when finished
```

The storyboard is written to `.foilbury/demo/<timestamp>/index.html` and a
`latest` symlink points at the newest run. Screenshots and `report.json` live
beside it. The directory is private and gitignored.

The demo uses the local development accounts:

- `player@foilbury.local` for the member journey.
- `owner@foilbury.local` for Bot administration, Platform Administration and
  the local EmDash development session.

These are local fixtures, **not production credentials**. They exist only when
`FOILBURY_ENV=local`, `FOILBURY_LOCAL_MODE=true` and `FOILBURY_DEV_LOGIN=true`.
The production service has `dev_login:false` and no equivalent bypass.

It creates or refreshes a zero-price `demo-walkthrough` pool containing one
fixed card, so the draw stage is deterministic and does not spend Foil. It also
archives the local `Album Proof` acceptance fixtures so test worlds do not leak
into the demo. Production data is untouched.

## Populated album demonstration

The local Danganronpa — Three Killing Games album can be prepared with real
administrator grants, not a second economy:

```sh
pnpm demo:album                          # dry run: who, what, how many
pnpm demo:album --mode seven --apply     # 7/8 unique cards
pnpm demo:album --mode complete --apply  # 8/8 and the completion achievement
```

The helper uses the same gift, inventory, ledger and achievement services as the
admin UI. It prints the granted cards, the unique count and the achievement
state. Re-running is idempotent. It never changes odds or fabricates a draw.

To retire only the demo's own grants:

```sh
pnpm demo:album --mode reset --apply
```

This marks only instances acquired by a `Foilbury demo album:` campaign as
surrendered and records a history row. Ledger, serials, unlocks and other
players' cards are preserved.

## What it covers

1. Public first impression and the four-world showcase.
2. Public cabinet and a public card detail.
3. Passwordless sign-in options.
4. Member cabinet, worlds browser and a launch collection.
5. Draw-room odds and a real zero-price draw with a recorded serial.
6. Card front, designed back, 3D inspection and reduced-motion inspection.
7. Achievements, gift receipts, preferences and account security.
8. Bot Admin: overview, catalogue, collections, render studio, achievements and gifts.
9. Platform Administration with the provisioned local Super Admin.
10. The native EmDash editorial console on the same local D1/R2 bindings.
11. Privacy boundary: signed-out launch data and renders are denied; member
    renders are `private, no-store`.
12. Mobile worlds and mobile card inspection.

The EmDash stage uses EmDash's own development-only setup bypass
(`/_emdash/api/setup/dev-bypass`). In production that route is unavailable; the
existing Dean CMS account is mapped through Cloudflare Access with
`autoProvision:false`.

## Reading the storyboard

- Each stage has a caption, a short list of what to notice, the source URL and a
  full-resolution screenshot.
- The header summarises stages, layout notes and console errors.
- Layout notes are not silently ignored. Fix the screen or record why the note is
  expected.
- A clean run is a useful showcase and smoke test, but it is not the same as the
  rigorous acceptance gate. Run `pnpm check`, `pnpm test:album`,
  `node scripts/test-privacy.mjs` and the deployed smoke separately.

## Extending it

Add a `visit` stage for a new page, or a `capture` block after an interaction.
Keep the caption honest about what the screen demonstrates. If the stage creates
data, make it idempotent and local-only.

## What it does not prove

- Cloudflare Access MFA or Dean's authenticated production admin session.
- A real Discord consent/MFA flow or a second human Discord account.
- A live Discord click-through; see `docs/DISCORD_TOUR.md`.
- A second guild/creator acceptance matrix.
- Dean's final creative approval of the artwork.
- Production deployment, cache headers or live Discord delivery by themselves.
