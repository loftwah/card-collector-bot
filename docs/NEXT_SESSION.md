# Next session handoff

Status: member surfaces slice implemented and released. Read `AGENTS.md`,
`PRODUCT.md`, `DESIGN.md` and the active issue before starting.

## What is in this slice

The signed-in member surfaces now share one page header and one panel vocabulary:

- `/play/missions` — daily missions, claim flow, reset and cap, no decorative kickers.
- `/play/achievements` — earned badges, closest next, searchable/filterable full cabinet,
  collection source names so duplicate badge names are distinguishable.
- `/play/gifts` — compact receipt list, pagination, no administrator-only reason text.
- `/play/wishlist` — 5:7 saved renders, exact finish label, acquisition paths, remove control
  outside the object.
- `/play/preferences` — compact collection rows, search, unsaved/saved/discard state, sharing
  and revoke controls.
- `/account/security` — moved inside the player shell, passkeys, authenticator, session review
  with a recent-8 default and an explicit "show all" control.

Files: `src/components/player/MemberHeader.astro`,
`src/components/player/DailyMissions.tsx`, `src/components/player/PreferenceForm.tsx`,
`src/components/account/SecurityPanel.tsx`, the six pages, `src/styles/global.css`, and the
achievement view now carries `collection_name` / `collection_slug`.

## Verification on this slice

- `pnpm check` — 113 unit + 318 Worker tests passed.
- `pnpm build` — production build passed.
- `pnpm test:ui` — 54/54 rendered checks, axe 0 serious/critical, light/dark, 390/1440,
  200% zoom, reduced motion.
- `pnpm test:product` — 57/57.
- Impeccable detector — `[]`.
- `pnpm demo:discord:check` — 18 PASS / 0 FAIL / 4 BLOCKED:
  command execution health, pin capability, spectator observation, authenticated actor session.
  These are unperformed, not accepted. Do not run a full Discord walkthrough without Dean's real
  client and a second controlled account.

## Next outcomes, in order

1. **Stitch resume (only if the daily quota has reset).**
   - Keep the single Foilbury project `projects/16492410293987266649` and design system
     `assets/198bcf8d443c4cce927d439f7d02c480`. Do not create a second project.
   - Generate **G04** and **G05** individually, not as a batch.
   - Run **Prompt 15** for Discord boards D01–D05.
   - Run **Prompt 16** for convergence and the missing state variants.
   - Apply the known copy fixes: P08/P09 “vault”, S04 “Physical Run/Bleed”, S05 “mints”,
     S10 printed `G02`.
2. **Storybook** with the actual React components, real fixture states, viewport, light/dark,
   reduced motion and accessibility. Do not rewrite Astro pages as React. Group Foundations,
   Controls, Foilbury components and Screen compositions. Add `pnpm storybook` only after the
   first component batch.
3. **#42 full customiser** — independent portrait/banner/frame/avatar decoration/name/effect,
   featured exact owned copy and finish, ordered favourites/badges, compact/full previews,
   locked/preview-only states, cancel/reset and failed/stale-save recovery.
4. **Remaining shells** — Studio, Platform and Discord still use the older direction.

## Guardrails

- One 5:7 card object; saved front/back renders on member surfaces; controls outside the object.
- Exact-copy language; no invented odds, ownership or private franchise exposure.
- One player shell, five destinations plus More; no duplicate menus or decorative kickers.
- `pnpm check`, `pnpm build`, `pnpm test:ui`, `pnpm test:product`, the Impeccable detector and
  live signed-in checks at 390/1440 before deploying.
- Take a D1 JSON backup before any production data change. A code-only deploy still has to pass
  the release gates.
- Use a one-use magic link for live verification and remove it afterwards.
- Do not claim Discord spectator, pin or authenticated-actor scenarios as passed.

## Next-session prompt

```text
Continue Foilbury from the deployed member-surfaces slice. Read AGENTS.md, PRODUCT.md,
DESIGN.md, docs/NEXT_SESSION.md, issue #92 and the latest #41/#42/#43 comments first. Check the
open drafts #48, #49, #51, #60, #62 and #66 before overlapping work.

The six member surfaces are live. Verify the current production source/version from the release
receipt and the live signed-in pages at 390/1440. Then, if the Stitch quota has reset, generate
G04/G05 individually, run Prompt 15 (Discord D01–D05) and Prompt 16 (convergence) in the one
Foilbury project with the existing design system. After that, set up Storybook with the actual
React components and real states, then continue #42's independent component mixing and curation.

Run pnpm demo:discord:check read-only. The last result was 18 PASS / 0 FAIL / 4 BLOCKED:
command execution health, pin capability, spectator observation and authenticated actor session.
Mark those BLOCKED, not passed. Do not do a full Discord walkthrough without Dean's real client
and a second controlled account.

Before deploying run pnpm check, pnpm build, pnpm test:ui, pnpm test:product, the Impeccable
detector and live signed-in checks at 390/1440. Take a D1 JSON backup before any production data
change. Use a one-use magic link for live verification and remove it afterwards.
```
