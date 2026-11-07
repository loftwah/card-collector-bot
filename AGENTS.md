# Foilbury agent workflow

## Current execution contract: finish before starting more

The owner requires working product outcomes, not issue volume, drafts, test counts or evidence infrastructure. This contract replaces older whole-backlog-in-one-session, blanket qualification, routine approval and repeated review defaults. Existing product requirements remain in scope; deliver them sequentially rather than treating the entire backlog as one release prerequisite. Current explicit owner decisions supersede historical design selections and procedural instructions. Preserve real security, privacy, data-integrity and spending constraints.

### One outcome, one accountable delivery owner

- Select one coherent, highest-priority user-visible outcome from the existing work. Recover relevant unfinished code before writing replacements. Use its existing issue; do not create a new planning epic or one PR per review finding. A coherent outcome can require several fixes and must not be diluted to a trivial cosmetic change.
- One integrator owns reproduction, implementation, integration, deployment and verification. Use a helper only for bounded work needed by that same outcome. A helper returning code or a draft does not free the integrator to start another feature.
- Use a single active integration/release batch per repository. Do not start unrelated implementation while that batch remains undelivered. Preserve all existing branches, worktrees and uncommitted work; do not confuse pausing new starts with deleting unfinished work.
- Read this file, the active issue and the affected source/domain guidance. Do not repeatedly reload the entire backlog, every historical receipt and every skill. Record a compact current checkpoint in the existing issue/PR, not another parallel tracking system.
- Resolve contradictions in the authoritative instructions and executable checks. Replace stale requirements instead of appending more competing directives. A historical receipt proves what happened then, not current acceptance.

### Complete the delivery loop

1. Reproduce the affected real journey and establish the expected visible result. Identify the relevant production/source difference and existing deployment access before expanding implementation. The owner should not need to enumerate ordinary broken controls.
2. Repair the cause and finish the whole selected journey, including its relevant loading, error and persisted-state behaviour. Review actual rendered output, not only source or test output. Keep unrelated findings in the existing backlog unless they make this delivery unsafe or incorrect.
3. Run the smallest justified checks and integrate the coherent change into `main`. The integrator is the sole merge/release writer during this batch: do not advance `main` underneath a release that requires an unchanged head. Never bypass a deployment-identity or concurrent-deployment guard.
4. Deploy to the existing authorised production target in the same execution, then exercise the affected live behaviour and inspect the result. A successful HTTP response or matching build header is technical release evidence, not proof that signed-in controls, artwork or gameplay work.
5. Only then finish that outcome and select the next. Keep the parent experience issue open until all its actual requirements are delivered. Documentation/tooling-only changes finish on `main` after a focused check; do not redeploy an unchanged application merely to create a release receipt.

A current implementation/delivery request authorises routine commit, push, review, merge and existing-target deployment within scope. Do not ask for that permission again at each checkpoint. Explicit owner holds, branch protection, recent strong authentication, private-content publication, paid work and destructive/data operations retain their actual safeguards.

## Verification and resource discipline

- The existing routine target is 3 minutes, with a 5-minute normal end-to-end target from the first relevant code change to verified production—not a separate allowance for each worker, check, review or deployment. Measure actual elapsed time; never fabricate a deadline guarantee or sacrifice correctness to hit it.
- Stop expanding automated tests and qualification by default. Retain only checks justified by a concrete failure/risk of the changed behaviour. Do not restore removed suites, historical assertions or deleted test infrastructure merely because an older prompt, issue or script mentioned them. Remove demonstrably obsolete requirements; never delete a real safeguard merely to hide a failure.
- UI work needs the affected ordinary journey and a representative phone/desktop visual inspection, not every viewport/browser combination for every edit. Auth, privacy, wallets, inventory, trades and migrations need their relevant denial/integrity checks. A missing physical device does not block unrelated delivery, and emulation must not be labelled a physical-device observation.
- Reuse valid checks/build outputs when relevant source, configuration and dependencies have not changed. Do not run the same broad suite in each worker, PR, handoff and deployment. Review a concrete risk or defect once, fix it, and recheck that change; do not create recursive independent-review campaigns or evidence-only PRs.
- `pnpm check` and the release/CI scripts must be inspected for their actual scope; their names do not make blanket work necessary. Where executable defaults contradict this contract, repair and check those defaults proportionately within the active delivery. Until changed, report the real behaviour rather than pretending the fast path exists. Do not silently bypass enforced safeguards or build a second release framework.
- If the same step fails again without a changed cause, stop blind retries and diagnose it. If routine delivery exceeds the target, state the actual failing step, elapsed time and next repair in the existing task; continue fixing it. Generic 'qualification', 'review' or 'awaiting acceptance' is not an explanation. Do not respond by opening more unrelated drafts.
- Ordinary bugs, integration conflicts and unfinished release tooling are work to resolve, not automatic handoffs back to the owner. A genuinely missing credential, entitlement, explicit approval or unsafe data operation blocks only its actual dependants. Never invent access or claim unperformed verification.

## Reporting

Lead with the behaviour the owner can now use, the integrated source, the deployed version and the affected live journey actually checked. Keep the receipt compact. Mark unfinished runtime work `IN_PROGRESS`, a concrete external impediment `BLOCKED`, and a successfully deployed and exercised outcome `PRODUCTION_VERIFIED`.

Do not turn 'HTTP smoke passed' into product acceptance, a PR body into proof of the current deployment, or a draft into completion. An interrupted session needs an exact resumable checkpoint; work does not continue after the session ends. No percentage-complete claim from issue/test/asset counts.

## Delivery showcase

The owner's Woodhouse Discord channel is the human-facing delivery showcase. It
is configured as `WOODHOUSE_DISCORD_CHANNEL` in `.env` (never commit the URL).
After a coherent outcome reaches production, post one concise update with:

- the exact issue(s) and pull request;
- the source revision and deployed Worker version;
- the live URL or Discord command/share to try;
- one to four visible things to look for;
- an honest `PRODUCTION_VERIFIED`, `IN_PROGRESS` or `BLOCKED` status and the
  real residual.

Use `pnpm showcase:post -- --title ... --summary ...` and the guidance in
`docs/DELIVERY_SHOWCASE.md`. Do not post per commit or per test run. Never post
secrets, private card art, member data or restricted screenshots. The showcase
is not acceptance evidence; the release receipt and the exercised live journey
remain the authority.

## Project context and skills

Production: `https://foilbury.loftwah.com`. Canonical local origin: `http://localhost:5173`; confirm the actual server with the existing setup/doctor commands.

Read `PRODUCT.md`, `DESIGN.md`, `docs/AGENT_GUIDE.md`, `docs/DISCORD_ACCEPTANCE.md` and the relevant domain guidance only when their scope is affected. Use installed `.agents/skills/` through the harness: Impeccable for actual rendered UI critique, shadcn for components, Cloudflare/Wrangler/Workers skills for platform work, EmDash skills for editorial work, and Playwright for affected real browser journeys. Do not rerun complete skill workflows for follow-up edits. Record material skill installation changes in `docs/SKILLS.md`, not a provenance report for ordinary reuse.

Keep production deterministic and headless/API-first. AI belongs in the operator/development/content-production workflow, not a new mandatory production assistant or model service.

## Identity and authority

- One Foilbury account per person. `usr_prod_owner` is Dean; never create a duplicate because an email changed. Discord OAuth, magic links and passkeys resolve the existing account; unverified email strings cannot merge accounts.
- Cloudflare Access authenticates administration but never grants a Foilbury role. Validate its JWT on every administrative request. Only the explicitly provisioned Dean account is Super Admin; guild ownership, first registration, email suffix, Access groups and ordinary APIs cannot grant it.
- Bot Owner/Admin authority is Bot-scoped. Invitations are expiring, single-use and bound to the invitee's email. Global Collection Admin is a scoped platform role in `fb_platform_role_assignments`, limited to assigned collections; it cannot approve public showcase content, grant Super Admin, change Access, hold secrets or touch wallets. See `docs/ROLES_AND_PERMISSIONS.md`.
- `/studio` is the normal signed-in scoped workspace, not an Access-gated or platform-root surface. `/platform-admin` requires Cloudflare Access plus the provisioned Super Admin. Sensitive mutations require recent strong authentication (`access`, `passkey` or `mfa`), not merely a cookie.

## Collections, artwork and product boundaries

- Foilbury is a free, non-commercial collectible-card scrapbook/library. Actual collections, characters and artwork are the content; keep the application shell restrained. No shop, parallel economy, second CMS or whole-app rewrite.
- Global collections are curated under the platform roles and enabled/disabled per Bot. Bot collections remain private to their Bot. Disabling a collection prevents drops; it does not delete inventory, serials or ledger history.
- `scope`, `status`, `view_audience` and distribution are separate. Global/published/public are not synonyms. A card inherits the most restrictive audience of every linked collection. Recheck media authority on every front/back/derivative/asset request; member/private bytes are `private, no-store`.
- Only the Super Admin approves public showcase content. New collections default to members-only. NBA and the 16 third-party properties must not be made public.
- Foilbury owns cards, artwork editions, taxonomy, pools, awards and inventory; EmDash owns journal content/media. Respect `docs/EMDASH_BOUNDARY.md`; do not create two editable catalogues.
- **Signal Fold is rejected under #26.** Historical selections, manifests and screenshots are not current owner approval. Agents choose, critique and ship routine Foilbury-owned design improvements without an owner aesthetic vote. Do not restore rejected branding to satisfy a stale test. Public-audience approval is separate from ordinary design decisions.
- Use good existing artwork and preserve originals/issued copies. Generic procedural covers, monograms or rendered placeholders are not approved finished art. Code may compose actual artwork, typography and effects. Correct provenance is evidence-based; do not guess official/fan/AI origin from appearance.
- Card contract: one 5:7 object; reserved artwork/information bands; controls outside the card; container-relative type; medallion crop only for square opaque avatars; contain tall/wide art. Member surfaces use saved front/back renders, not recomposed private source layers.
- Brand masters/exports remain under `public/brand/kit`; public-safe showcase media under `public/media/showcase`. Private replays, screenshots and launch manifests stay under `.foilbury/`. Keep prior assets as history, not as the current accepted design.

## Safe execution

Before an authorised production data change, inspect live state, take a D1 JSON backup with `node scripts/backup-d1-json.mjs`, establish compatible rollback, and apply an idempotent migration or trusted provisioning script. Do not seed over live edits. Preserve `.foilbury/`, `.dev.vars`, `.env`, original media, local databases and all unique active work. Clean only owned disposable resources.

Keep `.dev.vars` and secrets out of production bundles/logs. Never rotate the Discord token, OAuth secret, application identity or Access policy without a demonstrated need. Paid generation requires a recorded bounded ceiling; no silent top-up or fallback. Do not widen private audiences or alter the unrelated Loftwah guild identity to finish a Foilbury task.
