# Foilbury agent workflow

## Routine change-to-production service target — current owner direction

**Default target: 3 minutes; maximum normal target: 5 minutes from the first relevant code change to verified production.** This is the expected end-to-end delivery time for routine, low-risk, independently releasable changes, **not** five minutes each for tests, review, merge, build and deploy. The integrating agent owns the whole elapsed interval and cannot reset the clock by creating a PR, changing workers, handing off, rebasing or splitting a change. Measure elapsed time honestly; do not promise an actual release deadline that external systems cannot guarantee.

- Deliver the requested product outcome first. Do not expand a straightforward change into a new audit, qualification campaign, evidence framework or unrelated follow-up. Run the relevant checks once, fix real failures, ship and verify.
- Use only the smallest checks justified by the changed behaviour while implementing; re-use valid checks and build outputs. For routine changes, keep all automated validation within the same 3–5-minute end-to-end budget. Do not perform comprehensive browser matrices, repeated full builds, multi-agent review cycles or general audits as default release ceremony.
- Integrate, publish to the existing production environment and verify the affected real behaviour without waiting for another prompt. A draft PR, worktree, passed test or merged code is **not** completion.
- **Exceptions must be real and specific:** a failing security or privacy guard, possible loss/corruption of saves or financial/collectible data, gameplay or device-safety invariants, an incompatible migration, branch protection, explicit owner hold, unavailable production credentials/provider, or a genuinely large or dependent change may require more than five minutes. Never bypass a real safeguard or conceal a failure to hit the target.
- At the moment a delivery exceeds five minutes, report the concrete reason, elapsed time, stage consuming time, and next executable action in the existing task/PR; continue resolving it or deliver other genuinely independent work without flooding the integration queue. No generic 'testing', 'review', 'qualification' or 'awaiting acceptance' explanation is sufficient.
- If an existing mandatory gate makes normal low-risk delivery consistently exceed five minutes, treat the **gate itself as a performance defect**: measure the costly stages and safely simplify, cache or scope it without deleting assertions protecting actual risk. Do not keep growing a draft backlog behind it.
- For a change that does not affect the deployed runtime (documentation, tests or internal tooling), completion is integration into `main` and the relevant focused check, not a pointless production redeploy. Do not game delivery metrics by turning one coherent change into dozens of tiny PRs.
- Preserve all uncommitted, branch-only and worktree-only changes before any cleanup. No deletion or retirement based on the assumption that a draft was already delivered.


## Delivery contract — current owner direction

This section supersedes older routine approval/checkpoint and blanket testing defaults. Explicit task-specific owner holds, security/privacy, wallet and inventory integrity, credentials, spending, destructive operations and final-art approval remain binding.

A draft PR is unfinished work. The delivery owner carries authorised runtime changes through implementation, review, merge, existing-target deployment and a focused live check. A worker hand-off, green test or merged runtime change is not delivery. Report `IN_PROGRESS`, `BLOCKED` or `PRODUCTION_VERIFIED`; documentation/tooling-only changes finish on the default branch with their relevant check, without redeploying an unchanged application.

A current implementation/delivery request authorises routine commit, push, review, merge and existing-target deployment within that scope. Do not request the same permission again at each checkpoint. Respect actual branch protections and specific holds. New paid work, public showcase approval, private-content publication, irreversible changes and production data operations retain their separate safeguards.

Recover existing PRs first. One parent/integrator owns worker changes until delivered. Finish the oldest executable delivery before opening unrelated work; stop spawning branches when integration/release is the bottleneck. A blocked draft remains unfinished, not a completed worker slot. Keep related fixes in a coherent delivery unit rather than creating one PR per review finding or receipt.

During implementation run focused tests and relevant static checks. Docs-only edits need diff/link/contract checks, not all product suites. A UI change needs its affected real journey and representative phone/desktop inspection; auth, privacy, wallets, trades, inventory and migrations require their relevant negative and integrity tests. Run integrated release checks once per coherent candidate, not per worker, commit or hand-off. Reuse evidence only while its source, configuration and dependencies remain valid. Fix real failures; never forge receipts, report skips as passes or delete useful assertions to get green. A redundant executable gate must be corrected with its focused regression, not silently bypassed.

Keep review and evidence proportional. Report an actual blocker immediately in the existing PR/issue with the failing step, risk and next action. Do not create repeated audit cycles, evidence-only PRs or fresh human acceptance gates for routine reversible fixes. A missing physical device does not block unrelated software delivery. Preserve active agents' changes, reread current instructions and use one integration writer.

Read `PRODUCT.md`, `DESIGN.md`, `docs/AGENT_GUIDE.md` and `docs/DISCORD_ACCEPTANCE.md` when their scope is affected. The production origin is `https://foilbury.loftwah.com`; the canonical local origin is `http://localhost:5173`.

## Required skills

Use the installed project skills under `.agents/skills/` through the harness, not by copying files into prompts. Load only skills relevant to the changed outcome; do not rerun their entire workflow for every follow-up edit:

- `impeccable` for UI/UX work: inspect the rendered result, correct concrete defects and check the affected journey. A clean detector is not design acceptance.
- `shadcn` for component work. Inspect `components.json` and the resolved UI alias before adding components. Use the project token palette; do not introduce a second primitive library or palette.
- `cloudflare-one`, `wrangler` and `workers-best-practices` for affected Access, Worker, D1, R2 or deployment work.
- `building-emdash-site`, `creating-plugins` and `emdash-cli` for affected EmDash schema, admin, auth or deployment work.
- Playwright for affected real browser journeys, screenshots, network/console inspection and axe checks.

Record a material skill installation/adoption change in `docs/SKILLS.md`; ordinary reuse does not require another provenance report.

## Identity and authority

- One Foilbury account per person. `usr_prod_owner` is Dean; do not create a duplicate because an email changed.
- Discord OAuth, magic links and passkeys resolve the existing account. Never merge accounts on an unverified email string.
- Cloudflare Access authenticates administration; it never grants a Foilbury role. The Worker validates the Access JWT on every administrative request.
- Only the explicitly provisioned Dean account is Super Admin. Never grant it from guild ownership, first registration, email suffix, Access group or an ordinary admin API.
- Bot Owner and Bot Admin are Bot-scoped. Invitations are expiring, single-use and bound to the invitee's email.
- Global Collection Admin is a scoped platform role stored in `fb_platform_role_assignments`. It can curate assigned shared collections and their release state, but cannot approve public showcase content, grant Super Admin, change Access, hold secrets or touch wallets. See `docs/ROLES_AND_PERMISSIONS.md`.
- `/studio` is the normal signed-in scoped workspace. It is not an Access-gated surface and never confers platform root. `/platform-admin` remains Cloudflare Access plus the provisioned Super Admin.
- Sensitive mutations require recent strong authentication (`access`, `passkey` or `mfa`), not just a valid cookie.

## Collections and cards

- Global collections are curated by the Super Admin and enabled/disabled per Bot.
- Bot collections are private to their Bot; a Bot Admin must never see another Bot's private collections.
- Disabling a collection prevents its cards from dropping in that Bot. It does not delete inventory, serials or ledger history.
- Foilbury owns card identity, artwork editions, categories, tags, pools, awards and inventory. EmDash owns journal content/media. Do not create two editable card catalogues.
- The canonical boundary is `docs/EMDASH_BOUNDARY.md`. Foilbury links to EmDash; it does not imitate its workflow.
- Brand assets live under `public/brand/kit` and are generated by `pnpm brand:generate`. The canonical working identity is Signal Fold; do not mix reviewed marks on one surface.
- Public-safe showcase stills/videos live under `public/media/showcase` and are generated by `pnpm export:showcase`. Private opening replays stay in `.foilbury/exports`.

## Safe execution

- Before a production data change: inspect the live state, take a D1 JSON backup (`node scripts/backup-d1-json.mjs`), prepare rollback, then apply an idempotent migration or trusted provisioning script.
- Do not reset, clean or overwrite an active checkout. Preserve `.foilbury/`, `.dev.vars`, `.env` and existing evidence.
- Never rotate the Discord bot token, OAuth secret, application identity or Access policy without a demonstrated need.
- Run `pnpm check` once for an integrated runtime release and select relevant Playwright scripts by the changed behaviour below. Do not repeat the same checks at intermediate hand-offs or count skipped or mocked human steps as passes.
- Keep `.dev.vars` out of the production bundle; `scripts/deploy-production.mjs` removes it.

## Album increment rules (2026-11-03)

- `scope`, `status`, `view_audience` and distribution are separate. Never treat
  global, published or public as synonyms. A card inherits the most restrictive
  audience of every collection it belongs to.
- Only the Super Admin approves public showcase content. New collections default
  to members-only. NBA and the 16 third-party properties are never public.
- Media authorisation is re-checked on every render/back/derivative/asset request.
  Public bytes may be cached; member/private bytes are `private, no-store`.
- Real launch manifests live under `.foilbury/content/` (gitignored). Import them
  with `pnpm content:provision`; validate with `pnpm content:validate`; export a
  metadata snapshot with `pnpm content:export`. Do not commit private rosters,
  member data or private screenshots.
- Do not run paid generation without a recorded bounded ceiling. The launch art
  is a deterministic, clearly labelled original interpretation.
- `pnpm test` includes unit, Workers, achievement, gift and visibility tests.
  Album, inventory or visibility changes require the affected cases in
  `node scripts/test-album-e2e.mjs` and `node scripts/test-privacy.mjs`
  against the local server before deploying. Unrelated copy/docs changes do not
  require rerunning both whole suites.
- Production data changes require a JSON backup first
  (`node scripts/backup-d1-json.mjs`), a reversible migration and a live smoke
  check. Do not seed over live edits.

## Product verification by affected scope

A change is not complete because unit tests pass or a detector is clean. Check
its actual product behaviour. The following are available checks, selected by
risk rather than a mandatory all-suite checklist for every deployment:

- `pnpm test:ui` — affected rendered accessibility, theme, mobile and zoom work.
- `pnpm test:product` — affected public/member journeys, totals, card geometry,
  failure/retry, filters, admin and mobile work; preserve relevant negative controls.
- `pnpm test:artwork` — artwork editor, strong-auth, TOTP recovery, save,
  persisted composition and cleanup when those surfaces change.
- `pnpm perf:local` — meaningful asset, loading or rendering performance changes;
  do not benchmark unchanged pages or treat Vite dev JS as the production bundle.
- Inspect affected screens before and after. A screenshot still containing the
  reported defect is not a pass. Keep private screenshots under `.foilbury/`.

Card contract: one 5:7 object; art and information bands are reserved; controls
live outside the object; type is container-relative; only square opaque avatars
get a medallion crop; tall/wide art is contained. Member surfaces show the saved
front/back renders, not re-composed private source layers.

Routine deployment is covered by the current delivery instruction, not a fresh
blanket approval gate. Production data/render batches, paid generation and public
showcase promotion retain their specific authority and safeguards. A successful
local run is not a deployed revision; confirm the affected live behaviour.
