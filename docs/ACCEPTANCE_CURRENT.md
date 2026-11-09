# Current acceptance view

The existing machine-readable release matrix is `docs/release-acceptance.json`.
It records an earlier source tree and is validated by `pnpm release:check`; it
does not qualify the present working tree or cover the complete product backlog.
Older hand-written reports remain historical and are not release authority:

- `docs/DISCORD_ACCEPTANCE.md` — archive of earlier deployed-pilot snapshots.
- `docs/LOCAL_ACCEPTANCE.md`, `docs/acceptance-report.json` — original local gate.
- `docs/PASS_HANDOFF.md`, `docs/DISCORD_HANDOFF.md` — historical handoff notes.

## What "pass" means here

- **Domain pass** — the domain invariant is proven by a focused test against
  D1/R2 or a pure service fixture.
- **Production-path pass** — a signed fixture runs through the emitted Worker
  artifact, deferred lifecycle, durable receipt and delivery double.
- **Live API pass** — the current Discord application, command schema, guild,
  channel and effective bot permissions were read back.
- **Authentic interaction pass** — a real authorised person invoked the command
  and the delivered message/receipt was observed.
- **Client/audience pass** — the real desktop/mobile presentation was inspected,
  and an independent authorised spectator observed the same result.

A lower layer never silently passes a higher one. `docs/release-acceptance.json`
marks only the first three as current required evidence; authentic interaction
and spectator observation remain explicitly `blocked` until performed.

## Current residuals

- A real mobile Discord client invocation by the authorisation holder. The
  signed-in desktop client was driven through the retained sequence on
  2026/11/04; mobile is still open.
- An independent authorised spectator observation. A second tab of the same
  account is not a spectator.
- The scoped live grant to the designated Admin requires the owner's recent
  strong-auth step at the time of the change.
- Guild channel/role setup mutations require `MANAGE_CHANNELS` / `MANAGE_ROLES`
  or an owner-applied subset; see `docs/DISCORD_SETUP.md`.
- Sourced official collection logos (wordmarks/icons) are still a content task;
  current marks are reviewed Foilbury interpretations.
- Production import of the two new roster subjects remains separate from the
  local manifest/render proof.
- The current channel is not a durable members-only boundary: `@everyone` can
  view it. A future unauthorised invitee could see retained member artwork.
  The bot lacks the channel/role management permissions needed to repair this;
  a current-member census does not establish future privacy.

## 2026-11-04 evening — server scope, AI provenance and persistent demonstration

- Latest deployed build: source `2ab20a515224606af8ed8cee773a30f88f04afd8`,
  Worker `85d3fb74-d448-4312-958f-5504d31e7d8e`, schema
  `0027_ai_art_provenance_and_scope.sql`. The persistent demo was produced by
  source `a33e4dc` / Worker `dfe306d3`; the later release adds the Studio AI
  preference and the read-back verifier.
- **Persistent demonstration delivered:** twelve ordinary retained messages,
  start `1567443524209872926`, conclusion `1567443613346959481`. Full stage
  table, receipts and residuals: `docs/PERSISTENT_DEMO_2026-11-04.md`.
- **Production API history:** the synthetic demonstration actor made 15 real
  draws, yielding 15 instances, 15 spend rows
  (−1,200 Foil), one `Three schools` unlock, one 640 Foil reward ledger row, one
  mission claim/replay, one share receipt. Reconciled from production D1.
- **Persistent delivery pass:** Discord API read-back 12/12 PASS; every required
  image HTTP 200; signed-in desktop client reloaded and scrolled.
- **Configured-server scope evidence:** one enabled Danganronpa album, scope
  digest `5ee761338552f0e1fbadb3957dc75ca42a3d5519a7b60fc25d6681af23f76e87`;
  six focused scope tests.
  The earlier channel-privacy conclusion is superseded by the current effective
  permission finding above.
- **Independent audience/client pass:** **BLOCKED** — no second-account
  spectator and no real mobile client. The preflight with the recorded desktop
  actor evidence is **19 PASS · 0 FAIL · 3 BLOCKED** (pin, channel visibility,
  spectator).
- **AI provenance/toggle:** typed `origin`, queryable generation records,
  per-Bot `ai_art_enabled` default off, Studio/Admin toggle exercised in
  production `false → true → false`, visible origin label. `pnpm art:audit`.

## 2026-11-04 visible tour and release evidence update

- Final deployed build: source `4a6f04c7d0050679317ea8d83cb835f416e79028`, Worker
  `86d916ce-3e81-4349-830e-9e36fca18682`, schema
  `0026_gift_instance_uniqueness.sql`. Rollback target:
  `d343b9c5-5372-42c8-8228-16d82d9b482b`. The build-bound production smoke passed
  after deployment.

- The persistent **Start the Foilbury tour** entry is live at
  https://discord.com/channels/997734945206313041/1566700752385081355/1567185366014763079
  (message `1567185366014763079`). It has a real `foilbury:tour:welcome`
  component, Claim daily, Packs and three web links. API read-back and the
  Discord preflight pass; the owner's actual click is still unperformed.
- Preflight is **17 PASS, 0 FAIL, 4 BLOCKED**. The new PASS is the tour entry;
  the four blocked items remain pinning, channel visibility, an independent
  spectator and an authenticated actor session.
- The command-execution health gate is `pnpm discord:command-health`. It draws
  only through the emitted Worker against an isolated D1/R2 fixture and writes
  `.foilbury/evidence/discord-command-health.json`. It is not a live draw.
- A real deployed scheduled invocation was captured with `wrangler tail`:
  Worker `91e5c2bf-3451-42e2-887e-d0e5a72d1437`, cron `*/5 * * * *`, outcome
  `ok`, 2026-11-04 03:25 UTC. It proves the scheduled entry ran, not each step's
  side effect.
- Production content read-back is **21 collections, 156 cards, 640 variants,
  640 fronts, 640 backs**. Gonta Gokuhara and Kamui Gakupo are still local-only;
  see `docs/CONTENT_QUALITY_MATRIX.md` for the named omissions and bounded
  import plan.
- Release-gate hardening adds working-tree content identity, a complete
  module/asset digest, a freshly fetched remote ref, a verified previous Worker
  version and an affected-scope evidence check. Negative tests cover each.

## Assisted Discord acceptance runner (2026-11-04)

`scripts/discord/assisted-acceptance.mjs` now writes a bounded acceptance
session before any human step:

```sh
node scripts/discord/assisted-acceptance.mjs --prepare \
  --guild <guild-id> --channel <channel-id> --actor <discord-user-id>
node scripts/discord/assisted-acceptance.mjs --verify <interaction-id> \
  --session .foilbury/evidence/discord-assisted/session-<timestamp>.json
node scripts/discord/assisted-acceptance.mjs --watch --session <file> --minutes 10
node scripts/discord/assisted-acceptance.mjs --spectator <observer.json> --session <file>
```

The session records the environment, origin, `x-foilbury-build` read from
`/api/v1/status`, worker version when discoverable, guild, channel, initiating
account, start/end window, session id and expected cases. Use
`--cases open,daily,share` to bound a smaller run; the default covers all ten
prepared cases. Verification rejects any interaction outside that binding.
`processing` stays pending and `--watch` rechecks the same interaction until
`completed` or `failed`, or reports `timeout_pending` after the bounded window.

Per-command rules are separate. Read-only commands have no draw or ledger
requirement; daily and mission claims require one matching reward claim and
credit; open requires one exact draw debit (`reference_id = draw_id`), one owned
instance with the receipt serial, correct currency and a reconcilable balance;
shares require one durable share row and public delivery. A `failed` interaction
is never a success, even when `receipt_json` parses to `{}`; it must carry a real
ApiError code. Unrelated ledger rows are never counted.

Reports name the layer that established each fact: **API** (status/build),
**database** (D1 interaction, receipt, economics), **actual client** (never
claimed without an observer) and **observer/attestation**. A spectator file is a
hand-authored attestation, not proof: it must name the session, guild, channel,
Discord message id, a different actor, an `observed_at` inside the window,
`observed_intended_share: true` and `private_content_absent: true|false|"unverified"`.
A screenshot or API read-back is not accepted as proof that private content was
absent.

Read-only slash interactions currently store only the top-level `foilbury`
command in D1. The runner therefore requires `--case <case-id>` to bind a
read-only subcommand as an operator attestation. `--watch` reuses a terminal
`--verify` report for the same session, so `--verify --case help` also binds that
interaction during the watch. Economic commands are bound by their durable draw,
claim or share rows, not by a label.

The focused tests are `node --test tests/scripts/assisted-acceptance.test.mjs`.
They are logic and negative-control tests only. A green run does not replace a
real Discord invocation or an independent observer; those remain blocked in this
document.

## 2026/11/04 — Discord retained-media privacy correction (local, not deployed)

The historical member-census finding above is not a durable privacy boundary. A
read-only setup plan observed no `@everyone` View Channel deny and the bot lacks
`MANAGE_CHANNELS` and `MANAGE_ROLES`. Future guild invitees can therefore view
retained member-only attachments. The existing setup plan proposes an
`@everyone` allow and must not be applied as a privacy fix. Channel overwrites,
other roles, Administrator bypass and membership revocation all require review;
existing downloaded bytes cannot be recalled.

Local uncommitted containment makes channel shares public-only, keeps restricted
reveals ephemeral, refuses the member-art persistent publisher, and changes the
preflight to BLOCKED for a configured restricted audience. A signed-interaction
negative control reproduced the former leak before the change. The affected
Discord Workers suites passed 73 tests after the change. These results do not
prove a deployed fix, a durable Discord boundary, an independent spectator or a
native mobile journey. Existing messages and receipts were not changed.

Next: independently verify every direct Discord publishing path and complete
negative controls, implement and verify a revocable viewer-to-membership boundary,
prepare the minimum reversible channel overwrite change with an authorised owner,
run the complete product/release gates, and deploy only a qualified revision. The
bot cannot apply the channel policy with its current permissions. See the
existing release matrix for historical checks; its source binding and incomplete
criterion coverage are not current full-product acceptance.

Checkpoint: local `main` began at `1be8e08` with a clean tracked tree; the
containment and this correction are uncommitted. `pnpm check` passed: 104 unit
and 246 Workers tests, plus Access, release-gate and acceptance-runner checks;
Astro reported zero errors and 116 hints. The focused Discord tests passed 73.
No full browser/product/artwork gates, deployment, live smoke, content import,
channel permission change or complete issue-by-issue acceptance was performed.
Next commands include `git diff`, `pnpm test:ui`, `pnpm test:product`,
`pnpm test:artwork`, `pnpm perf:local`, and the repository release checks after
finishing and reviewing the remaining work. Do not deploy from this checkpoint.

### Continuation — local integration in progress

The per-installation editor is implemented locally with inheritance, explicit
selection (including empty), revision fencing and scoped authorization; the
Workers fixtures cover stale writes and revocation. Independent Chromium review
at 375 px checked selection and reload controls. Mocked response checks verified
success and conflict messages; they do not establish browser persistence.

The real local `test-product-qa.mjs` completed 56/56 checks with its artifacts
under `.foilbury/tmp/product-check-20261104/`. An initial `test-ui-a11y.mjs`
run failed during an axe scan after its execution context navigated while the
dev tree was changing; it is not a pass and its evidence is retained separately.

Local draw filtering now examines recorded subject/background ancestry, including
AI and indeterminate derived inputs, with bounded graph traversal. Existing
render/import writers do not consistently record all inputs; saved-render lineage
and cross-surface consistency remain incomplete. A render job can also publish
bytes made from an older edition under a newer source hash; correcting this
requires fencing publication against immutable renderer inputs, including live
logos and unregistered backs. Do not infer provenance or mark the render issue
complete from the new draw tests.

The settled-tree local rerun passed `pnpm check` (104 unit and 267 Workers
tests), the rendered UI/a11y script, and `test-product-qa.mjs` (56/56).
Evidence is retained under `.foilbury/tmp/ui-check-20261104-settled/` and
`.foilbury/tmp/product-check-20261104-integrated/`; previous failed UI runs
remain preserved. A development-server performance sample is under
`.foilbury/tmp/perf-integrated-20261104/`; it is not a production bundle result.
These checks do not qualify the full issue backlog or a production deployment.

Draw recovery now reads achievement credits from ledger entries and marks an
unpaid unlock or absent completion marker pending; a regression test preserves
stale cached receipts, checks no phantom credit, and checks subsequent credited
recovery. The persisted settled marker is not a complete repair of the wider
asynchronous recovery workflow. The renderer no longer uses its front image as a
back derivative, but the independent reviewer found that derivative retries and
the shared atomic render-publication race remain unresolved.

### Further local work — 2026/11/04

Local migrations 0028 and 0029 were applied only after the SQLite backup
`.foilbury/backups/local-pre-alias-art-review-20261104.sqlite`. Neither was
applied to production. Name aliases, the scoped server settings editor, the
human-only art-review evidence ledger, media containment, and wallet/NPC
transaction work are uncommitted. The collection-art importer is deliberately
paused: the local selection validator is not publication authority, the review
ledger cannot fence a same-key R2 overwrite, and agent review is not yet enabled.

The latest completed local gates before subsequent Discord logging edits were
`pnpm check` (298 Workers tests), rendered UI 54/54, product QA 56/56 and artwork
editor 11/11. The UI and product results are browser-emulated, not native-device
or screen-reader acceptance. The artwork test's temporary card was removed and
its separate evidence is under `.foilbury/tmp/artwork-gate-20261104/`.

Wallet adjustments now use a single guarded local D1 batch for balance, ledger,
receipt and audit; the 13 focused tests include grant/session/owner races and
rollback. Access validation was fixture-based and actual Access login recency
remains unproven. Unbound Discord and agent grant paths are intentionally denied.
NPC recovery prevents new draws while outcomes remain unresolved. A local
candidate adds explicit planned-action reconciliation and a guarded automatic
resolution after a failed attempt; ambiguous legacy failures remain held and rollout
requires older unguarded workers to be drained. Its quota and pause checks are
fenced at commit in local tests. See `docs/NPC_RECOVERY_LIMITS.md` and
`docs/GRANT_ACCEPTANCE_LIMITS.md`.

Shared-media authorization remains conservative: over-limit or uncertain
lineage can deny legitimate access, and production-scale timing and full
media-route acceptance are unproven. The real production channel is still not a
durable member-only boundary, and no production containment was deployed.
The render-publication race, full catalogue/visual review, production additions
for Gonta/Gakupo, authentic Discord journeys, native mobile and independent
spectator evidence remain open. Do not treat this checkpoint as a completed
backlog or release qualification.

### Continuing audit — local work, 2026/11/04

The 0028/0029 local migrations are applied; production is still unchanged.
Migration 0030 is a prepared, guarded Nora metadata correction based on Protocol
11's owning source, not applied; existing rendered pixels still need a separate
qualified re-render. The alternate Drop Bear image candidates and critiques are
private under `.foilbury/generated/review-candidates/`; neither is approved or
imported.

`pnpm check` passed 303 Workers tests before the newest wishlist/share and
logging edits. UI a11y passed 54/54 after the no-JavaScript control fix; product
QA passed 56/56 after the short-screen inspector repair. Further changes need a
fresh integrated run. Unknown-suffix API mutations and an unrelated-scope pool
preview were reproduced and locally fixed with focused fixtures, but the router
as a whole is not audited. Discord recovery fixtures assert a private delivery,
no public follow-up and historical rather than current balance; they use mocked
transport and do not prove an authentic Discord client journey.

Wishlist read and shared-snapshot reauthorization are still being implemented;
legacy links and effective multi-collection audience must be verified on every
read without deleting wishes. The art-review ledger is evidence only, does not
bind immutable R2 versions, and does not authorize the paused importer. Media
graph limits can deny legitimate assets and need production-scale qualification.

Local-only follow-through: the guarded Nora copy migration 0030 was applied
after `.foilbury/backups/local-pre-nora-copy-20261104.sqlite`; local metadata
now identifies her as “Retired chaos manager”. Saved image pixels still need a
qualified re-render. Existing local Gonta and Gakupo identities were retained;
after `.foilbury/backups/local-pre-name-aliases-20261104.sqlite`, aliases were
added through the authenticated local API. Authorized `/api/v1/catalogue`
read-back resolved Gonta, Camui Gackpo, Gackpoid and 神威がくぽ to their expected
single identities. Read-only local pool previews listed Gonta in one and Gakupo
in two eligible pools. This is local eligibility, not a draw, art approval or
production delivery. The initial probe mistakenly used `/api/v1/cards` without
an ID and returned 404; the subsequent catalogue endpoint is the valid test.

### Backlog status snapshot — 2026/11/05 Australia/Melbourne

GitHub read-back lists #2–#4 and #7–#40 as open, except that there are no
issues #5, #6 or #38 in that read-back. The groups below are an index to the
existing issues, not a substitute for their individual criteria. Nothing in
this local checkpoint closes an issue or qualifies this working tree for
release. The source-bound release matrix above is historical for this tree.

| Open issues | Current local evidence | Remaining verdict |
| --- | --- | --- |
| #2, #27–#29, #39 | Partial visual audit and local subject aliases; see `docs/CONTENT_QUALITY_MATRIX.md`. | Full roster, artwork, rights/provenance and multi-surface acceptance **not complete**; Gonta and Gakupo are not production additions. |
| #8, #10–#13, #40 | Local card geometry, short-screen navigation, editor and selected copy/layout fixes; earlier rendered tests and private evidence are recorded above. | Full route, device, artwork and independent visual acceptance **not complete**; the latest working tree still requires integrated checks. |
| #14–#18, #21, #36–#37 | Local privacy, share, visibility, route and scope regression work; production channel policy was read back separately. | Full route/abuse audit, durable Discord audience boundary and qualified deployment **not complete**. |
| #9, #23, #30–#32 | Local wallet, draw recovery and NPC concurrency fixtures; see `docs/NPC_RECOVERY_LIMITS.md` and `docs/GRANT_ACCEPTANCE_LIMITS.md`. | Full NPC reconciliation, live Admin journey, mission/economy and authentic client acceptance **not complete**. |
| #7, #22, #24–#26 | Historical retained Discord demo and local delivery/privacy fixes; existing receipts are preserved. | Ordinary-user slash journey, durable channel privacy, independent spectator, mobile and presentation acceptance **not complete**. |
| #3–#4, #19–#20, #33–#35 | Local performance samples, logging and lifecycle fixes; previous release evidence is source-bound. | Production bundle/performance, EmDash lifecycle, correlated alert delivery, state-machine/Effect adoption and a current qualified release **not complete**. |

All individual acceptance criteria, exact tested environments and review
verdicts still need reconciliation against their issue bodies. This index is
explicitly incomplete; local passing tests must not be promoted to a deployed
or human-client verdict.

### Local continuation — 2026/11/05

A provisional `pnpm check` completed with 344 Workers tests while the shared
tree was still changing; it is not a final source-bound gate. The isolated
product journey passed 58/58, including no-JavaScript public search and its
negative controls, at `.foilbury/tmp/product-20261105-xvePOO/`. The isolated
rendered UI run reported 54 passes at `.foilbury/tmp/ui-20261105-4K6pBA/`;
subsequent edits require a settled-tree rerun. A local development-server
performance sample is at `.foilbury/tmp/perf-20261105-mutWLa/`, not a
production-bundle benchmark.

Public and member set release migrations 0031 and 0032 remain unapplied to the
active local database and production. The local pre-migration backup
`.foilbury/backups/local-pre-set-releases-20261105.sqlite` passed
`integrity_check`; direct read-only SQLite access to the active database later
failed while the development Worker held it. No migration was attempted after
that failure. No set review or approval was created.

During a Discord browser fixture setup, three existing ignored files under
`.foilbury/tmp/discord-editor-fixture/` (`index.html`, `main.tsx`, and
`vite.config.mjs`) were overwritten without first checking the directory.
No verified copy of the originals was found. The current files and separate
review evidence are preserved; the originals are not claimed recovered. No
production or application data was affected by that fixture error.

The active local Worker was subsequently observed with the local D1 SQLite
WAL/SHM files open in its process while their recorded paths were absent from the
directory; direct SQLite access returned `SQLITE_CANTOPEN`. The site still
responded, but the cause and durability of any later local writes are not
established. Preserve the running Worker and database files; do not restart,
reset, migrate or run write-heavy local journeys until this is safely
investigated. The earlier 0030 backup passed integrity checking, but predates
this observation and is not proof of recovery for later writes.

### Continuing source work — 2026/11/05, not release evidence

- Scoped draws now use the 0033 epoch/principal/installation candidate in the
  real source path; missing epoch schema fails closed while authorised existing
  receipt recovery remains available. An independent isolated run passed
  134/134 focused draw/Discord/Effect tests before subsequent edits; current
  full-tree gates and production contention are not established. 0033 is not
  applied to the active or production database.
- Scoped Studio gifting, current gift receipt visibility, collection
  create/update recovery and exact API dispatch received local fixes and
  isolated tests. Cross-Bot named print gifting and immutable render approval
  are still incomplete. New brand uploads remain held while 0034 and its
  object-version, collection approval and recovery paths are reviewed.
- The latest broad isolated Worker run, taken mid-edit, failed 59/420; its
  sessionless fixtures, draw hold and trigger-count integration findings were
  being addressed. Do not use the earlier 344-test provisional pass as the
  current gate. Run a fresh `pnpm check` after the working tree settles.
- The active local D1 and Worker are preserved. Its journal paths were observed
  appearing/disappearing after an earlier direct read failed; this is not proof
  of either corruption or safety. No subsequent active-DB migration was run.
  Separate network-isolated Linux dependency and backup staging exists under
  `.foilbury/isolated/`, but has incomplete media and is not a current-state
  proof; it has not yet run the real EmDash lifecycle.
- Permanent Discord content remains exposed to future unauthorised channel
  viewers until its actual policy is corrected; no production containment or
  new Discord messages were deployed in this continuation. The requested full
  art, roster, user/admin/Discord/mobile and release acceptance remain open.

### Later isolated evidence — 2026/11/05, not release evidence

The earlier incomplete-media staging limitation above was subsequently addressed
in a separate network-isolated container. Its database came from the historical
0030 backup, not a current snapshot of the active Worker. Copies of 7,739 asset
objects were independently matched to that backup by SHA-256; migrations 0031
through 0034 were applied only to the disposable database. The preserved source
and results are under `.foilbury/isolated/foilbury-fresh-e9329d6f/`. On that
snapshot, rendered UI passed 54/54, product journeys 58/58, privacy 9/9,
artwork-editor journeys 11/11 and the native EmDash lifecycle 11/11. The local
performance samples use Vite development assets and do not establish production
bundle performance. The album end-to-end script was not run: it queues actual
render jobs, and the renderer replacement remains in progress. Offline font
warnings and the absence of real human, native-device and production evidence
remain limitations.

A later `pnpm check` passed 107 unit and 520 Worker tests; its log is
`.foilbury/tmp/full-check-post-media-20261105.log`. Source has changed since
that run, including NPC reconciliation and an unfinished renderer protocol, so
this is not a final integrated gate. Earlier independent browser fixtures
passed 20/20 and direct script checks 25/25, also before those changes. Repeat
the required checks against a settled, identified source and fresh disposable
environment before release. No active or production migration was applied.

The 0034 staged brand-upload path was subsequently enabled in local source
after isolated tests and review; production and Cloudflare edge behaviour are
not established. NPC reconciliation was implemented for Studio, API and MCP
with explicit confirmation and an atomic absence check, including safely
resolvable legacy failures. Independent review inspected the transaction and
authority fences; the focused suite later passed 26/26, including in-flight
token rotation and session revocation. Ambiguous history remains pending.
Draining older workers is a rollout dependency for its state guard. The
previous statements that brand
uploads were held and NPC reconciliation was absent describe earlier points
in time, not the latest local source.

Renderer replacement is still in progress under migration 0035. Private
paired output staging and an isolated executor have focused tests, but review,
publication, routing and end-to-end integration are incomplete. Existing
rendering remains held; no new rendered asset or review has been published.
The artwork audit found all 16 inspected catalogue fronts require rework. A
reference-conditioned Drop Bear candidate was also inspected on the actual
Astro page in a network-isolated container, with private intercepted media at
`.foilbury/isolated/drop-bear-astro-T8VuwA/`. Its small phone metadata, weak
finish differentiation and back layout need rework. This is a private study,
not an approved full design slice or catalogue replacement.
Retain all original assets, render jobs, local evidence and the active Worker.

The subsequent magic-link rate-limit candidate uses one D1 batch to bound
client, service and address bucket admission. Focused isolated authentication
and rate tests passed 22/22; an independent rerun of the storage subset passed
5/5. Provider delivery and mixed-version or deployed ingress behaviour remain
unverified. A separate request-reference and error-logging change removes raw
unexpected exception messages and bounds request IDs. Unit and targeted Worker
tests passed, and an instrumented full Foilbury local Worker in a network-none
container verified consistent IDs across middleware, context and 404 responses
for absent, hostile and valid Ray headers. Evidence is preserved at
`.foilbury/evidence/request-ref-O47qyd/`; this is not deployed edge evidence.

Active continuation at this checkpoint: the 0035 renderer candidate now has
isolated tests for an exact-credential operator, verified inputs, paired private
staging, delegated or Super Admin review as appropriate, and atomic publication
records. Route/executor integration, pinned derivatives and Discord attachment
paths, independent review and full end-to-end tests remain unfinished; do not
lift the renderer hold or apply 0035 to the active database on this evidence.
An isolated mission test also reproduced collection GET creating an exploration
event and lifetime deduplication preventing later-day progress. Local source
now uses explicit card flips and collection visits, live authority checks and
database UTC-day deduplication. Focused suites passed 59/59 and a mocked mobile
keyboard/axe fixture passed, including a skewed device clock. Independent
privacy review caught malformed capability records, which were fixed and
re-reviewed; real cross-surface integration remains outstanding.

The renderer candidate subsequently gained pinned derivative and Discord
attachment paths; combined isolated manifest/media/Discord tests passed 55/55.
The job HTTP routes, worker manifest assembly and review UI are not yet wired.
Private-audience fences have focused coverage, but source-lineage review found
that retained superseded outputs can make the conservative graph reject a new
render; active-use handling and inherited source restrictions remain under
development. The hold remains.
An achievement reward test separately reproduced a credit committed before a
lost response being reported as failed. The local candidate reconciles exact
ledger entries, leaves unknown outcomes pending and guards the notification
insert against duplicate races and malformed historical payloads. Focused
achievement/mission/draw suites passed 53/53; independent review and integrated
checks were pending at that point. A further delivered-notification race was
fixed and independently re-reviewed; the achievement suite passed 16/16.
Integrated checks remain outstanding. Wishlist preview concurrency was bounded
to four per invocation, independently rerunning 2/2 targeted tests; total pool
work remains unbounded and production latency is not established.

Local favourite/lock and Wishlist mutation candidates now fence live ownership,
audience and exact session or agent credential at the write, including no-op
favourites and target-finish revocation. Independent review and the focused
instance/Wishlist/share/route suites passed 42/42. A separate Wishlist read
race was reproduced and a live result-query fence added with focused tests.
Agent Wishlist shares now require both profile write and inventory read. A
transaction fence for authority changes during share creation is under active
development; its first candidate exceeded SQLite's expression-depth limit and
was replaced with a reviewed 0033-epoch and exact-row fence. Targeted suites
passed; named finish text is neutralised for both new and historical shares,
with original records preserved. A separate share resolution race was then
reproduced: revoking a private viewer grant between visibility queries could
expose the saved card name. The local resolver candidate now rechecks the link,
live viewer and scope epochs before return; focused race tests and an explicitly
scoped agent path pass. Independent review caught an achievement-definition
race, which was fixed and re-reviewed with 29/29 isolated share/privacy tests.
No integrated release is implied.

Recycle fixtures reproduced stale session, disabled-setting and changed-rate
settlement. The local candidate fences the quote and current authority at the
receipt transaction and recovers same-key committed results; focused tests
also cover lock/favourite changes, rollback and token rotation. The UI can
retry its saved key after reload in the same tab; cross-tab/closed-tab recovery
and safe cancellation of a stale request are in progress. Migration 0036 adds
actor attribution for new recycle entries without editing old ledger rows;
it is not applied, needs old workers drained, and requires independent review.

Later recycle work uses a same-browser IndexedDB reservation to retain the exact
request across tab closure and serialize competing tabs; three mocked browser
fixtures passed. Migration 0036 now includes durable cancellation and receipt
reservation; commit and cancel race atomically. The expanded protocol and a
subsequent exact card/variant fence were independently reviewed in isolated
tests. Missing schema rejects new attempts while authorised old receipts can
still replay. The migration remains unapplied and older workers must be drained.

Renderer lineage now has isolated controls through queue, input, review,
publication and pinned media reads, including shared-source revocation. A
separate Studio review screen exists with digest/decode checks, but bounded
discovery and exact-decision recovery are still being implemented; the real
operator journey and independent review remain open. The renderer route is
still held. Current working tree is actively being edited in those areas; a
settled-source full check and the required isolated album, product, privacy,
artwork and release gates have not yet been run on this revision.

### Resumed after agent usage limit — 2026/11/05

All three delegated agent turns stopped on the reported usage limit. Their
working-tree changes and private evidence remain in place. A fresh `pnpm check`
initially exposed six failures: two real daily-allowance authority/settings
races, one recovery test expecting a raw error, and three print-review failures
from trigger-inclusive D1 change counts. The local allowance transaction now
checks the live session or exact scoped agent credential and the quoted settings;
print review uses the row returned by the update; the recovery test checks that
the raw storage error is not exposed while retaining receipt assertions. The
three focused suites passed 21/21, then the full `pnpm check` passed 110 unit
and 606 Worker tests. This is local evidence, not independent review, a current
production identity or release qualification. The renderer remains held, and
the visual, Discord, album and full-release criteria above remain open.
Additional tests confirmed that rotating an agent token prevents the daily
claim, a lost response recovers the original credit, and concurrent retries
return complete receipts. A subsequent full `pnpm check` passed 110 unit and
609 Worker tests; its private log is
`.foilbury/tmp/check-resume-kGkTbR/check.log`. This does not qualify deployment.
Subsequent trade-discovery tests exposed revoked members still appearing and a
revoked requester still receiving the partner list. The trade-inventory endpoint
also returned private source fields and did not enforce inherited collection
visibility. The local candidate now checks current membership, viewer access
and exact agent credential at the result query and returns only fields used by
trade selection. Focused tests cover public and private cards, source-field
omission, target and requester revocation, and token rotation. A fresh full
`pnpm check` then passed 110 unit and 614 Worker tests; its private log is
`.foilbury/tmp/check-trade-9jPZ2I/check.log`. Independent privacy review and
real browser/deployed trade acceptance remain open.
After that full run the trade response was narrowed further to the four fields
the selection screen uses, withholding the other member's favourite and lock
flags. The focused trade/social suites passed 8/8 and type checking passed;
the full suite has not been rerun after that last change. Renderer executor,
composition and finish script checks separately passed 9/9, which does not
constitute creative approval or an integrated render journey.

The renderer review screen subsequently gained same-browser durable recovery:
an exact pending decision is reserved before submission, scoped to environment,
account and Bot. The mocked mobile browser fixture covers reload, a second tab,
an ambiguous conflict on retry, blocked storage and successful receipt recovery;
axe passed and the recovered state was inspected at
`.foilbury/evidence/bound-render-review-EkWdDR/mobile-recovered.png`.
This does not qualify the held renderer route or the actual operator journey.
After the UI changes, `pnpm check` passed 110 unit and 614 Worker tests in
`.foilbury/tmp/check-finalstate-E4jRbq/check.log`. A subsequent mocked browser
test also confirmed that a different account in the same browser does not see
the pending decision; its private evidence is
`.foilbury/evidence/bound-render-review-u8RymN/`.

The daily allowance transaction now also rejects a request whose quoted UTC
day differs from the database transaction day; an isolated clock-mismatch
fixture verifies no claim or credit. The latest full `pnpm check` passed 110
unit and 615 Worker tests, with private log
`.foilbury/tmp/check-daily-BIw3G3/check.log`. This does not establish real
midnight device behaviour or qualify a release.

The trade selection list now also excludes locked copies, and its explanatory
copy was updated. The focused Worker suites passed 8/8. A subsequent full
`pnpm check` passed 110 unit and 615 Worker tests; the private log is
`.foilbury/tmp/check-latest-k6JyuR/check.log`. Browser and independent privacy
acceptance for the trade changes remain outstanding.
The mocked 320px trade-dialog fixture subsequently passed with axe and an
inspected screenshot at `.foilbury/evidence/trade-dialog-VbFF07/mobile.png`.
An earlier run timed out opening the dialog; that intermittency is unresolved.
The focus-restoration assertion now waits for the actual focus transition rather
than checking synchronously. This fixture is not a real-device acceptance.

The held renderer's final media check now evaluates session and agent-grant
expiry using database time instead of a previously captured application time.
The isolated renderer fixture expires each credential just before the final
query and receives no bytes. The latest full `pnpm check` passed 110 unit and
615 Worker tests; private log `.foilbury/tmp/check-media-expiry-NPaBCh/check.log`.
This is local evidence only; renderer integration and independent review remain
open.

Legacy fronts, backs, derivatives and generic assets now re-evaluate access
after reading their object and check the live principal before returning
restricted bytes. Isolated tests inject membership, session and audience
revocation during those reads, including a public-to-members cache transition.
The latest full `pnpm check` passed 110 unit and 622 Worker tests; private log
`.foilbury/tmp/check-media-recheck-fSr8yh/check.log`. These rechecks use multiple
queries: changes between the last audience query and final principal/row check
still require an atomic graph-policy fence, and the added query cost has not
been qualified in production. Generic and legacy object keys also retain their
existing version-binding limitations. Do not treat this as complete media or
release acceptance.
The local candidate subsequently added an epoch fence when both 0033 and 0035
are installed and intact. Isolated front/back/derivative and generic-asset
fixtures reject audience changes at the final query and missing installed
triggers or epoch tables. Older schemas deliberately retain the earlier
compatibility path without that atomic fence; do not deploy or accept this as a
complete privacy boundary without the migrations and review. A local synthetic
shared-asset test measured 47 statements for a small graph and 187 for 16
linked cards (13 ms and 41 ms respectively in that local run). These are not
production latency or cost measurements; query cost and independent review are
release blockers. Privileged drop/write/recreate of identical triggers remains
subject to the documented trusted-DDL and repair assumption.
The local candidate then batched card visibility using the existing predicate.
In a comparable isolated fixture the 16-card case used 35 statements rather
than 187 (13 ms in that run); 256 authorised uses also returned in 35
statements (18 ms). A private 17th use and a 257th use both fail closed. These
are fixture measurements, not production qualification. Unfiled draft source
and render fixtures now deny an ordinary member while allowing an authorised
owner. The latest local `pnpm check` passed 110 unit and 629 Worker tests;
private log `.foilbury/tmp/check-media-draft-TFs0nt/check.log`. Broader draft
visibility callers and independent privacy review remain open.
Collection-use checks were subsequently batched too, with a separate 256-use
bound. Isolated controls allow 256 authorised collection uses, withhold a
private use and fail closed at 257; the 256-use query count is bounded in the
fixture. A full local `pnpm check` passed 110 unit and 630 Worker tests at that
point in `.foilbury/tmp/check-media-uses-qTIKQS/check.log`; the query-count
assertion was added afterwards and its focused suite passed 2/2. Independent
review and production performance remain open.
An additional archived-collection negative was added to that fixture. A later
full local `pnpm check` passed 110 unit and 630 Worker tests, with private log
`.foilbury/tmp/check-media-audience-un7FWv/check.log`.
The local epoch candidate checks the migration record when a table is absent:
an older schema remains on the compatibility path, while a missing table after
the corresponding migration fails closed. A full `pnpm check` passed 110 unit
and 627 Worker tests in `.foilbury/tmp/check-media-epoch-OJUaFK/check.log`;
the compatibility-path fixture was added afterwards and the focused asset suite
passed 22/22. No schema was applied to the active or production database.
An additional focused fixture then verified that a generic member asset returns
no bytes when the session is revoked at the final principal query; that focused
suite passed 17/17. A subsequent full local `pnpm check` passed 110 unit and
623 Worker tests; its private log is `.foilbury/tmp/check-after-asset-L7TsCA/check.log`.

The renderer review recovery subsequently gained an explicit distinction for
`render_review_receipt_pending`: a 409 reporting a possibly committed decision
retains the exact saved request. The mocked browser fixture passed through that
response, a second ambiguous conflict, reloads and the matching receipt; see
`.foilbury/evidence/bound-render-review-qiOSYs/`. The latest full local
`pnpm check` passed 110 unit and 615 Worker tests. A later mocked mobile fixture
also checked the recovered decision's note and digests, with screenshot
`.foilbury/evidence/bound-render-review-NxF9Ht/mobile-recovered.png`; the latest
full check passed 110 unit and 615 Worker tests with private log
`.foilbury/tmp/check-review-details-7QtnRV/check.log`. The route remains held,
and independent review and the real operator journey remain outstanding.

Resume without touching the active local D1 or retained Discord messages:

1. Inspect the current dirty tree and this checkpoint; preserve `.foilbury/`,
   `.dev.vars`, the active Worker and all retained evidence.
2. Independently review the daily, trade and legacy-media changes. Complete the
   atomic media graph fence, renderer lineage/discovery, operator integration
   and Studio review journey before enabling the held route.
3. On the settled source, run `pnpm check`,
   `node --test tests/browser/bound-render-review.test.mjs`, and the relevant
   media/trade fixtures. Run the required product, UI, artwork, privacy and
   album gates only against a freshly verified disposable environment; the
   album script must not consume active render jobs.
4. Finish the outstanding catalogue/design/Discord criteria and obtain the
   exact independent reviews and owner/device actions required by the existing
   issue bodies. Follow the backup, migration, rollback and release-receipt
   gates before any production mutation. No deployment is implied here.

On 2026/11/05, an isolated Worker fixture reproduced creation of a card share
for an unfiled draft. Card/latest share creation now requires a published,
unarchived card and variant, and its insert rechecks the live principal,
sharing preference, 0033 policy epochs, ownership and exact saved back image.
The focused share suite passed 33/33, including changes immediately before
commit. Card previews also read the current account name. The final full
`pnpm check` passed 110 unit and 639 Worker tests in
`.foilbury/tmp/check-share-final.log`. This requires migration 0033;
without that schema card sharing fails closed. Collection shares now also
recheck the principal, preference and 0033 epochs at insertion, including
scoped agent credentials. The focused privacy suite passed 41/41, including
revocation races. The subsequent full `pnpm check` passed 110 unit and 645
Worker tests, with log `.foilbury/tmp/check-collection-share.log`. Profile
shares now recheck their saved pinned-copy ownership and favourite state, and
achievement shares recheck their saved unlock and definition. Both also use
the principal and policy-epoch fence. Focused share suites passed 52/52;
the subsequent full `pnpm check` passed 110 unit and 653 Worker tests, with log
`.foilbury/tmp/check-all-share-kinds.log`. Account names are now read from the
current account for all share types; the subsequent focused suites passed
55/55 and `pnpm check` passed 110 unit and 656 Worker tests in
`.foilbury/tmp/check-sharing-current.log`. These changes need independent review.
No migration was applied to the active or production database.

The mocked 320px trade-dialog fixture subsequently passed ten consecutive
runs (logs `.foilbury/tmp/trade-repeat-1.log` through `trade-repeat-10.log`).
Earlier intermittent failures remain unexplained; these passes do not establish
that the opening race is fixed or substitute for a real-device journey.

Discord card-share continuation, 2026/11/05: isolated signed interaction
fixtures reproduced sharing a draft card/variant and a public follow-up after
the collection became private between the private receipt and the POST. Local
source now rejects draft cards and variants and carries an internal proof to a
final pre-POST check of 0033 epochs, live installation and identity, membership,
copy, serial, published state and render reference. Missing 0033 fails closed;
the immediate response strips the proof. Seven injected delivery changes and
the ordinary positive path are covered by the mocked transport. The full
`pnpm check` passed 110 unit and 666 Worker tests, with log
`.foilbury/tmp/check-discord-delivery.log`.

The subsequent local candidate checks card-share attachment bytes against the
captured asset hash and length for both private and public delivery, and checks
the same asset metadata again immediately before the public POST. A mocked
same-key replacement withheld its bytes while an unchanged object attached;
this is not an R2 version pin. The next full `pnpm check` passed 110 unit and
668 Worker tests, with log `.foilbury/tmp/check-discord-pinned-bytes.log`.

Local migration 0037 and the card-share path now preserve each delivery attempt
separately. A confirmed pre-POST refusal is retryable; concurrent retries admit
one attempt. A possibly sent or historical share remains held. Signed mocked
fixtures exercise those paths, the ordinary share and retained historical row.
The subsequent full `pnpm check` passed 110 unit and 671 Worker tests, with log
`.foilbury/tmp/check-discord-share-recovery.log`. The final authorisation and
transition to an uncertain send are now one guarded D1 write; a fixture
changes audience at that exact write. A newer full `pnpm check` passed 110 unit
and 672 Worker tests, with log `.foilbury/tmp/check-discord-atomic-share.log`.
The follow-up checks distinguish a missing attempt schema, confirmed delivery,
and an uncertain or historical share; missing schema fails closed without
leaving a share row. The next full `pnpm check` passed 110 unit and 673 Worker
tests, with log `.foilbury/tmp/check-discord-recovery-current.log`. Migration 0037 has not been
applied to active or production D1; rollback must hold sharing and retain the
attempt table/history. A release also needs old delivery workers drained.

This is not a complete Discord delivery solution: other attachment and public
result types need separate delivery-boundary review, and interrupted reserved
attempts and uncertain sends need an authorised reconciliation workflow.
Independent security review and an integrated real-client journey are required.
No Discord message, active database or production configuration was changed
by these fixtures.

Card typography study, 2026/11/05: `art/compose.mjs` now uses larger front
header, finish, subtitle and footer type. Short-, long- and maximum-label
renders, together with intercepted 390px product-page screenshots, are under
`.foilbury/isolated/card-type-study-20261105/`. Safe-area and finish tests
passed 8/8; `pnpm check` passed 110 unit and 673 Worker tests in
`.foilbury/tmp/check-card-type-study.log`. The rendered example is a private
unapproved study and the doubled background remains a visible defect; it is
not the required finished design slice. The active local page returned HTTP 404
for `/@id/@astrojs/react/client.js` despite the package resolving on disk;
finish controls did not hydrate without intervention. A separate browser-only
interception supplied the installed, Vite-transformed React module and the
private candidate image; finish selection then worked and the selected mobile
page had zero axe violations with reduced motion. Intercepted before/after
screenshots are `phone-hydrated-before.png` and `phone-hydrated-after.png` in
the study directory. A first axe run during the colour transition reported four
contrast violations; the reduced-motion rerun passed. This is not a healthy
server or real-device pass. The running server and its database were not
restarted or changed. Actual back/finish work, independent creative review and
qualified re-render remain necessary.

## Live Discord retest, 2026/11/05

Dean's signed-in Discord account ran three real openings in
`#card-collector-test`: Hajime Hinata (Plain), Nagito Komaeda (Plain), and
Chiaki Nanami (Silver). Each bot-authored card share is retained between the
[start](https://discord.com/channels/997734945206313041/1566700752385081355/1567724148665360475)
and [end](https://discord.com/channels/997734945206313041/1566700752385081355/1567728532686241866).
The start message was pinned through Dean's signed-in Discord account; the
channel displayed the resulting pin notice.
The three openings cost 240 earned Foil; the last credited the 260-Foil First
trial achievement. The signed-in web cabinet displayed the silver card as the
latest acquisition and 18 cards kept. This is a real owner interaction, not
independent ordinary-user or native-mobile acceptance.

Before these openings, D1 JSON backup
`.foilbury/backups/d1-2026-11-05T02-18-08-100Z.json` was taken. The actual
Discord channel was made private: `@everyone` was denied View Channel; the
existing Admin role retains Administrator access and Foilbury has an explicit
channel allow. The channel no longer inherits its category permissions. This
supersedes earlier statements describing the channel as public, but does not
prove independent spectator behaviour or recall already downloaded copies.
A subsequent read-only preflight confirms the explicit `@everyone` deny but
still marks durable viewer-to-membership authorisation and restricted-share
enforcement blocked; the existing Admin role can bypass channel denies. The
three retained member-art shares were delivered in the restricted channel,
but must not be represented as a passed end-to-end privacy boundary.

The live `/foilbury packs` response incorrectly treated this channel as public;
the collection button incorrectly reported zero cards. The deployed command
dispatch passed the installation's nullable topic-policy key in place of the
actual Discord channel ID. Local fixes and regression tests cover slash and
button actions, both member and public audiences; they are not deployed. The
signed-in Studio also failed to fetch because its inline context flag was
blocked by CSP; a local path-based routing fix is likewise not deployed. A clean
release candidate is in `.foilbury/isolated/discord-channel-scope-20261105`,
branch `codex/discord-channel-scope-20261105`; it must pass the release gates
and real client retest before those defects can be marked resolved. The real
channel demonstrates actual cards, but presentation quality and the complete
ordinary-user Discord journey remain open.

The isolated candidate is now `f77d5d3` (routing fix `db1b4b3`, the album
test's loading-label correction, and an explicit Discord health-test fixture);
`pnpm check` passed 106 unit
and 246 Worker tests, and `pnpm test:production-path` passed two tests. An
isolated browser using a local owner fixture loaded `/studio/collections`, made
the scoped `/api/v1/studio/collections` request, and had no page errors or
failed-fetch message. The first isolated `pnpm check` failed because no local
Discord application ID was configured; adding a non-secret fixture ID allowed
the complete run to pass. The local `test:ui` run failed because the fresh
isolated database contained no owned card for the inspection audit; the
`test:product` run was stopped after repeated fixture-dependent failures and
timeouts, and `test:artwork` failed because its local TOTP fixture was absent.
The isolated server was on port 5187; the existing port-5173 process and its
database were not reset or modified. These failures are not release evidence.
The checked-in CI fixture script requires port 5173 and disabled external
providers, so it was not redirected into the existing active checkout. Run
the required gates against a properly populated isolated environment before
any deploy. Subsequently, a separate container with its own port 5173,
database and synthetic CI fixtures passed `test:ui`, all 56 `test:product`
checks, all 11 `test:artwork` checks, the complete album journey after the
loading-label fix, and `test:privacy`. Local performance was recorded for
synthetic content; it is not a production-bundle measurement. The first album
run failed because the button is labelled “Loading odds” while its preview is
pending; the corrected locator retains the disabled-state assertion. Logs and
synthetic evidence are under the candidate worktree's
`.foilbury/evidence/container-20261105/`. The source-bound release recording
completed the five automated checks at `f77d5d3`; independent review remains
open. The generated manifest was preserved as local evidence but not committed:
the recorder also stamps historical live/content claims that it does not
rerun as part of those five checks. A fresh read-only Discord preflight did
pass the historical tour-entry check, but reported the restricted-channel
authorisation and reveal policy blocked. GitHub CI initially failed the
health test because it inherited no Discord application ID; the test now
explicitly exercises both configured and unconfigured states without relying
on credentials. The updated branch in draft PR #47 passed its GitHub CI run.
The separate private-manifest validator subsequently reported 142 cards,
34 achievements, no errors and one duplicate-slug warning. This is schema
validation only; it does not newly prove the recorder's claimed artwork
dimensions, visual quality or production import.

An independent bounded review found no concrete new member-content exposure in
the changed command paths, but identified that the original public-packs
negative asserted absence of a card name the picker does not display. Draft
PR #47 now includes the corrected pool assertion and reviewer-authored signed
interaction tests for member, public, unmapped and malformed channel policies
across card front/back/details, achievements and profile. The scope suite
passed 7/7 at head `7f1bb72`; its GitHub CI and five automated release checks
passed. Review of a further uncommitted public-only share clamp found that
completion and profile summaries can still expose restricted progress, and
that public card eligibility remains vulnerable to a delivery-time policy
race. The clamp is therefore held and is not part of the PR head. This review
does not establish acceptance of the broader privacy work or visual product.

Following that review, the main checkout has an uncommitted containment change
that withholds completion/profile channel-share controls and refuses stale
summary-share buttons, with an explicit private error. It is a temporary hold,
not completion of those features. The signed-interaction Discord,
presentation and scope suites passed 96/96
(`.foilbury/tmp/check-discord-summary-hold.log`); independent review and
delivery-boundary qualification remain open. The 501-copy aggregate is also
held: review found that installation or Bot policy can change between scope
capture and the inventory queries. A local statement-level epoch and
installation-snapshot fence plus a post-read assertion has since been added;
60 Discord tests and type checking pass. Signed-interaction tests now inject
installation allowlist, Bot collection, channel-audience and AI-policy changes
between scope capture and inventory reads; they also check missing epoch
schema. The full scope suite passes 18/18
(`.foilbury/tmp/check-discord-inventory-races.log`), and `pnpm check` passes
112 unit and 681 Worker tests
(`.foilbury/tmp/check-discord-fenced-totals.log`). Independent review,
then identified an identity-revocation window after the inventory read. The
local post-read fence now also checks the live principal in its final SQL
statement. The 24-test Discord scope suite passes, including deliberate
post-read identity revoke/relink and subject-origin races
(`.foilbury/tmp/check-discord-final-races.log`). An independent bounded review
found no further concrete bypass in this aggregate path. Items and totals are
still separate reads and may briefly disagree during a concurrent acquisition;
privileged schema changes remain a limitation. Integration and real-client
verification are still required.

Discord reveal presentation has a separate uncommitted local refinement in the
original checkout: repeated balance information is consolidated and odds are
inline so the saved artwork appears sooner, while price, serial, reward and
settled balance remain visible. The presentation, recovery and Discord Worker
tests passed 95/95 (`.foilbury/tmp/check-discord-reveal-layout.log`). It has
not been independently reviewed, rendered in the real Discord client, included
in PR #47, or deployed; it is not accepted as the requested finished visual
experience.

A further regression check found that Discord counted the number of
subjects with duplicates instead of the number of extra copies: three copies
were shown as one duplicate. The local implementation now counts two extra
copies and the full Discord scope suite passes 10/10. This fix is included in
draft PR #47 at `0d65012`; its five source-bound automated release checks and
GitHub CI passed, but it remains undeployed. Discord collection and profile reads also capped the
input at 500 copies. A separate local, undeployed implementation now obtains
scope- and AI-filtered totals from the database and fetches only the displayed
rows. A signed-interaction fixture with 501 copies verifies the collection and
profile totals, duplicate count, and AI exclusion; the empty message also
explains that out-of-scope historical copies remain owned. The full `pnpm
check` passed 112 unit and 673 Worker tests, logged at
`.foilbury/tmp/check-discord-complete-totals.log`. Independent review,
integration and release qualification remain necessary.

An independent bounded review of the unmerged 0037 delivery candidate found a
release-blocking gap: policy can change after the D1 eligibility/reservation
write and before the Discord POST. Existing tests inject changes before or
during reservation, not in that interval. The private original is also sent
before the final live check, leaving a separate revocation window. Interrupted
`reserved` and ambiguous `uncertain` attempts conservatively block duplicates
but lack an operator reconciliation path. D1 and Discord do not share a
transaction, so a last-moment recheck alone cannot prove atomic delivery. Do
not deploy or describe 0037 as solving the delivery race until an enforceable
policy/delivery boundary and recovery workflow have been designed, tested and
independently reviewed.
The follow-up review identified that serialising a send requires every
relevant policy, ownership, identity, asset and R2 writer to respect the same
durable reservation. A timeout cannot safely release that reservation: the
Discord POST may still arrive. Holding ambiguous sends could in turn block
revocation indefinitely. A neutral, non-previewing link to a reauthorised
Foilbury page is a possible containment, but has not been implemented or
reviewed and does not satisfy the requested rich Discord reveal by itself.

Release-evidence review also found that the recorder could stamp skipped
checks as passes, assert historical live/content facts without rerunning them,
and bind browser results to the source hash without proving the server or its
database. The artwork test independently locates and mutates a checkout-local
SQLite database, so merely using a loopback port does not establish isolation.
Local hardening now rejects explicit skipped/reused checks and includes tests
for stale/ambiguous tour evidence and a mismatched build header, but the
independent review correctly found that a runtime header does not prove served
bytes or disposable storage and that preflight message provenance is
insufficient. Both the recorder and deployment entry point are now explicitly
held before network or browser work until a managed, artifact-bound,
disposable-database harness is implemented and verified; the deployment hold
also prevents a hand-written manifest from bypassing the recorder. These local
changes are uncommitted and not a qualified release gate.

On 2026-11-05, the draft PR candidate
`79d910e46b23e2b3d8df75be134e8e2b82c83879` was built and exercised in a
network-disabled Docker prototype with disposable D1/R2/KV, generated local
credentials and synthetic content. This used the built Worker and client
assets, not a Vite development server. Artifact manifest verification before
and after the journeys matched SHA-256
`1ef65d9ec4ca6b43a27eaf027b7c66765cb94a3b7452b58fee0aff2e44d5900c`
across 1,675 files. `test:ui`, `test:product` (59/59), `test:artwork` (11/11),
`test-album-e2e`, `test-privacy`, and `perf:local` passed. An earlier built
run failed because production CSP blocked the site and cabinet inline menu
scripts; the candidate changes process both scripts and restore focus on
Escape. Independent review found no concrete regression, while noting that
programmatic link focus is not proof of complete keyboard traversal or screen
reader announcements. The earlier failure and rerun logs are retained under
`.foilbury/isolated/discord-channel-scope-20261105/.foilbury/evidence/`.
This one-off prototype is not yet an independently reviewed managed release
harness. The deployment hold and the Discord delivery/privacy blockers above
remain in force; this candidate is not deployed.
A subsequent built-Worker browser check also traversed both mobile menus with
Enter, Tab and Escape, and verified focus return and a clean console. It does
not establish screen-reader announcements.
The same candidate's `pnpm check` also passed in that container: the log is
`production-harness-79d910e/check.log` alongside the journey evidence. GitHub
CI was still running at the time of this entry.
GitHub CI subsequently passed for draft PR #47 at `79d910e`; this does not
remove the release or Discord privacy holds.
A subsequent clean-base experiment combined digest-pinned official Node 22 and
Playwright 1.64.1, installed the locked public dependencies without owner
mounts, reconstructed the exact candidate Git tree and built offline. A
network-none, unmounted disposable container applied its own local D1
migrations and served the built Worker with local R2/KV. A 390px browser loaded
an asset whose bytes matched the built CSS and exercised the header menu;
source and full artifact digests remained stable. The offline build reported a
failed EmDash Google-font metadata fetch, so font parity is unproven. This
experiment is not yet a reusable, independently reviewed release harness and
does not remove any hold.
The local evidence validator now owns an explicit baseline of the criteria the
recorder already marks required; a manifest cannot omit one or mark it
optional. It also rejects duplicate criterion IDs, duplicate required-check
records, checks dated more than six hours ahead, and mismatched per-check
working-tree content. Twenty focused release-gate tests pass. This is
uncommitted and pending independent review; it does not authenticate the
recorder's factual claims or remove either release hold.
The later clean install found that candidate `79d910e` did not declare
`@axe-core/playwright`. Its prior UI/product passes inherited that dependency
from a developer installation and are not clean-install qualification. The
clean install failed those suites before browser launch; its manually created
fixtures also did not meet the album/privacy fixture contract and lacked
sqlite3 for artwork. Draft PR #47 now declares the existing required package at
`70b407e`; that new source has not yet passed a clean full run. Preserve and
report both successes and failures; do not reuse the earlier green checks as
proof for the new head.
The independent validator review found an additional optional-pass scope gap.
Locally, optional passing criteria now need the same issue, command, evidence
and tree binding as required criteria. Twenty-one focused tests pass and the
reviewer confirmed that specific gap closed. Self-reported claims remain
unauthenticated, so both release holds remain.
Fresh draft `70b407e8cad70292238553d1f9eebb96eb21968f` subsequently passed
GitHub CI and all six built-Worker suites in a clean, no-mount, network-none
container with locally generated credentials and committed synthetic fixtures:
UI (54), product (59/59), artwork (11/11), album, privacy and local performance.
The full artifact SHA-256 was
`c8e95bc1ad5b58ad4961046d4c3cb85ae53f02b931203026a359071b7246e7c9`
(1,675 files). Logs are in `.foilbury/isolated/pr70-proof-QjFO5K/`. The
offline Google-font metadata warning remains; this is not live or
native-device acceptance, and the managed-harness and sharing holds remain.
The draw-room local work now uses an explicit face-down reveal and reduced-
motion immediate reveal, with Hide/Show and replay preserving focus and the
same committed card. A 390px browser exercised real synthetic draws, replay,
request-count checks, pending wallet refresh and reduced motion; the updated
album journey passed. Local screenshot review still finds this is a generic
Signal Fold back rather than the collection-specific packaging and full Discord
opening required by #24. It is not integrated or deployed.

A synthetic pending receipt exposed another actual defect: the direct response
had debit balance 510, reward total 160 and balance 510 with settlement marked
pending, while the old UI said the balance and reward were settled. The local
UI now labels unconfirmed values as updating, preserves pending operation
recovery, and refreshes the wallet before opening another. Local backend replay
marks unconfirmed receipts pending without inventing a zero; Discord
presentation and recovery also avoid labelling uncertain balances settled or
substituting a current wallet for historical debit. Focused tests and an
independent reviewer identified and corrected several gaps. The underlying
settlement reconciliation can still remain pending, and moving to another
opening does not itself resolve the prior reward; no live acceptance or release
is claimed.
The local settlement cause was traced to existing unlocks being returned again
by achievement evaluation and summed as if newly credited by the draw. The
local repair retains entitlement retries, distinguishes new unlocks, attributes
credits only to matching issued ledger entries for the draw event, and obtains
the historical debit from the atomic draw ledger row (including zero-price
draws). Focused Workers tests cover repeated draws, missing ledger links,
read failures and concurrent wallet movement. A wallet movement that cannot be
attributed remains pending, and durable reconciliation for prior pending
rewards is still unfinished. This change is uncommitted and undeployed.
The web reveal and unconfirmed-balance presentation have been collected into
stacked draft PR #48, based on #47, at
`78cb137fc3e1d97cac86a58b85d60951984913aa`. Focused reveal (5) and state (29)
tests and branch typecheck passed; clean-source browser qualification and
GitHub CI are in progress. The branch is not deployed and does not include the
separate local ledger/recovery repair. Durable follow-up for an earlier
pending reward after another opening remains unresolved.
The earlier PR #48 head `78cb137` passed an exact-source, no-mount,
network-disabled built-Worker run: UI (54), product (59/59), album (14) and
reveal component checks (5), plus a 390px browser journey proving intentional
reveal beyond the former timeout, Hide/Show, one-request replay and immediate
reduced-motion opening. Pending wallet failure/retry used injected responses;
it is not backend settlement proof. Full artifact SHA-256
`e1833d37a49610d841b470daf478de2d3d19bac0774ff15fe8558644be180f2a`
remained unchanged across the run. Evidence is under
`.foilbury/isolated/pr78-proof-qxuHUZ/`; offline font metadata warning remains.
Current head `df68911` additionally corrects the older end-to-end selectors;
its exact-source qualification is in progress. No deployment is claimed.
The older full `test-e2e.mjs` now has corrected reveal selectors locally and
in PR #48 head `df68911`. In the clean ARM64 container it fails before its
assertions because the script specifically requests Chrome, which is not
installed there. Its separate requirements for a larger catalogue and
`pressure-orbit` fixture also remain unfulfilled in that container. This is
not counted as a pass and its assertions were not weakened.
PR #48 head `df689115f6e24005adb09a1fd643f32064a6157b` subsequently passed
GitHub CI and a clean, network-none built-Worker run: UI (54), product (59/59),
album (14), reveal markup (5), and targeted browser reveal/replay and
reduced-motion journeys. Pending wallet failure and retry used injected
responses; they do not prove backend settlement. The complete artifact digest
was `419373a4352b4b36364f1a7a300ae77ed10ab1262bdb2015c6db3a5db313a57b`
for 1,675 files. Logs are in `.foilbury/isolated/prdf-proof-l8oTkS/`. The
legacy Chrome-only end-to-end check failed before its assertions because the
clean ARM64 image has no Chrome; its larger catalogue and other prerequisites
remain unverified. The build's offline font-provider warning remains. The
prior pending reward warning remains transient across later opening/reload.
Neither draft is integrated or deployed.
On 2026/11/05 18:53 AEDT (Australia/Melbourne, UTC+11) / 2026/11/05 07:53 UTC,
a read-only live D1 inspection found that the Bot has one Discord installation
and the public-approved Bubbles, Fighter, Protocol 11 and Shared collections
are disabled, with the last recorded updater `usr_prod_owner`. Active public
Fighter/Protocol base pools reference unknown-origin, unreviewed subject assets;
approved AI-assisted variants exist in another pool but the Bot's AI artwork
setting is off. Enabling a collection would alter Bot-wide web/API and future
draw distribution, not only this channel. The owner's brief explicitly forbids
re-enabling disabled Fighter/original content for demo convenience. No live
configuration or production data was changed by this inspection.
The settlement and Discord receipt changes are collected in stacked draft PR
#49 on top of #48, at `cad70b5908414bef33617a6e2c05e3d1e309ea05`.
The branch's `pnpm check` passed (107 unit and 260 Worker tests plus scripted
checks), and an independent reviewer ran 65 draw/Discord checks and found no
additional concrete regression. A further independent review caught a
historical balance labelled current; that was corrected with a signed Discord
recovery regression. Clean-container qualification is in progress. This branch
does not include the separate unmerged scope/delivery privacy fences, and it
does not resolve historical pending settlement reconciliation. No deployment
is claimed.
PR #49 `cad70b5` subsequently passed GitHub CI and clean, network-disabled
qualification: `pnpm check` (107 unit / 260 Worker tests plus scripted gates),
UI, product (59/59), artwork (11/11), album, privacy and local performance.
Evidence is retained under `.foilbury/isolated/pr49-proof-JUMzFi/`. The built
entry and full dist-file hashes matched before and after the browser journeys.
The UI test overwrote tracked screenshot evidence inside the disposable
container; generated copies were retained and those files restored, so the
whole tracked tree was not unchanged during the run. An initial browser run
used a dev listener and is excluded; the first album run failed on the wrong
WebAuthn host and passed on canonical localhost. The offline build reported a
font-provider warning. This is not production or native-device acceptance,
and neither the Discord delivery fence nor historical settlement
reconciliation is solved by this PR.
An uncommitted Discord-only scoped-inventory extraction is preserved in
`.foilbury/isolated/scoped-inventory-6v5lWI/`, based on PR #49. Its tests
passed 107 unit and 279 Workers tests, including signed scope/identity races,
missing epoch schema or trigger, 501 copies and subject AI exclusion; typecheck
and trigger-definition checks passed. It is not release-ready. Migration 0033
follows locally reserved 0028–0032, and rolling the Worker back to #49 while
leaving 0033 triggers installed reproducibly causes a committed admin update to
be reported as failed. A reviewed migration order and coordinated D1/Worker
rollback are required. This slice checks subject origin only; background and
ancestry, historical render provenance, draw-commit fencing and share-delivery
privacy remain unproven. No production migration or state change was made.
