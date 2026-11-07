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

## 2026-11-07 continuation

- Verified production identity from the release receipt and live headers:
  source `60114b7564cb27d2e554ada8dd60f6812381ed0c`, Worker
  `981b71ba-55f3-42cc-a347-f5fcedf57fc1`.
- Stitch quota reset. Generated **G04** (`14fc3aaafa4045dba2682bb74f0740c6`) and
  **G05** (`eb67da6a2ab5458db37115abe7b8e0ea`) individually, plus **D01–D05**
  (`31746686cff44d2eb039109e8dc60b6a`, `b8fd479d4c714d2abd003c76189c5558`,
  `0d7d3e47515742b782280b3940835620`, `bb72d6bca174449680f7eacda288f916`,
  `019aa2221537424090dd6899154fc0fc`) in the existing Foilbury project and design
  system. Prompt 16 copy corrections were applied to P08, P09, S04, S05, S10 and
  G05. Remaining state variants are listed in `docs/STITCH_SCREEN_INDEX.md`.
- Storybook 10.6.6 is configured with the actual React components, real fixtures,
  light/dark, phone/desktop viewports, reduced-motion preview and axe. Commands:
  `pnpm storybook` and `pnpm storybook:build`. The first batch covers Foundations,
  Controls, PublishedCard, CardInspector, DailyMissions, ProfileCustomiser,
  RewardCenter and two member screen compositions. The built catalogue passed the
  local Chromium/axe check at 390 and 1440.
- #42 independent composition slice: additive migration
  `0029_profile_presentation.sql`; saved portrait/banner/frame/avatar decoration/
  name treatment/effect, exact featured owned copy, ordered favourites and
  ordered earned badges, version-fenced save and stale-tab recovery. The profile
  share snapshot carries the composition and exact featured copy. Focused
  preference/share tests and the real local 390/1440 journey pass.
- **Production verified:** source `2347ee66730f98db9ab5534bed7fc66744125195`,
  Worker `ab245dc5-cad6-44cc-ba6e-d5f887655274`, receipt
  `.foilbury/evidence/release-receipt-2347ee66730f-712c5a92-724d-4560-89f4-2488a84e9261.json`.
  The production D1 JSON backup was taken before the additive migration
  (`.foilbury/backups/d1-2026-11-07T03-34-26-015Z.json`, 94 tables, 32,849 rows).
  A one-use owner magic link exercised the signed-in profile at 390 and 1440,
  saved and reloaded the independent composition and exact serial, passed axe
  with no serious/critical findings, restored the owner's prior preferences and
  favourite flags, and was deleted afterwards.

## Next outcomes, in order

1. **Stitch resume (only if the daily quota has reset).**
   - Keep the single Foilbury project `projects/16492410293987266649` and design system
     `assets/198bcf8d443c4cce927d439f7d02c480`. Do not create a second project.
   - Generate **G04** and **G05** individually, not as a batch.
   - Run **Prompt 15** for Discord boards D01–D05.
   - Run **Prompt 16** for convergence and the missing state variants.
   - Copy fixes: applied to the generated P08/P09, S04, S05, S10 and G05 screens.
2. **Storybook** — first component batch is configured and verified. Extend the catalogue as
   new reviewed components appear; do not rewrite Astro pages as React.
3. **#42 full customiser** — the independent composition, exact featured copy, ordered shelf and
   badges, compact/full preview, cancel/reset and stale-save recovery are in production.
   Remaining: locked/preview-only cosmetics, a dedicated share/export composer, and the final
   keyboard/touch reorder acceptance across the full #40 viewport matrix.
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
