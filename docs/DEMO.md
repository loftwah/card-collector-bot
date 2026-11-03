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
- `owner@foilbury.local` for Bot administration.

It creates or refreshes a zero-price `demo-walkthrough` pool containing one
fixed card, so the draw stage is deterministic and does not spend Foil. It also
archives the local `Album Proof` acceptance fixtures so test worlds do not leak
into the demo. Production data is untouched.

## What it covers

1. Public first impression and the four-world showcase.
2. Public cabinet and a public card detail.
3. Passwordless sign-in options.
4. Member cabinet, worlds browser and a launch collection.
5. Draw-room odds and a real zero-price draw with a recorded serial.
6. Card front, designed back, 3D inspection and reduced-motion inspection.
7. Achievements, gift receipts, preferences and account security.
8. Admin overview, catalogue, collections, render studio, achievements and gifts.
9. Privacy boundary: signed-out launch data and renders are denied; member
   renders are `private, no-store`.
10. Mobile worlds and mobile card inspection.

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
- The EmDash native operator console.
- A second guild/creator acceptance matrix.
- Dean's final creative approval of the artwork.
- Production deployment, cache headers or live Discord delivery by themselves.
