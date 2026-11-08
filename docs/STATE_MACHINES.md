# Workflow states and failure recovery

Foilbury has two kinds of workflow state:

- **Explicit** — the typed transition tables in `src/server/state.ts`, covered by
  `tests/unit/state.test.ts`.
- **Implicit** — a status/state column (or a time-derived condition) whose
  transitions live in one or more services, triggers or scheduled jobs. These
  are listed below so a change can find every writer before altering a rule.

The database constraints and idempotency records remain the authority. A
transition helper never replaces a conditional `UPDATE`, a unique index or a
trigger.

## Explicit transition tables

| Machine | States and valid transitions | Recovery |
|---|---|---|
| Card | draft → published; published → draft/retired; retired → draft/published | Restoring clears `archived_at`; draft → retired is rejected |
| Collection | draft → published/archived; published → draft/archived; archived → draft | Stale edits use `expectedVersion` and return 409 |
| Membership | invited → active/revoked; active → suspended/revoked; suspended → active/revoked; revoked → active | Suspension/revocation revokes sessions; restoration is audited |
| Gift campaign | previewed → sending/cancelled; sending → completed/partial/failed; partial/failed → sending; completed → completed | Per-recipient awards are idempotent; retry only processes pending/failed |
| Render job | pending → running/cancelled; running → succeeded/failed; failed → pending | Claim is atomic; complete requires `running`; retries never re-roll a draw |
| Draw | ready → submitting → committed/unknown; unknown → committed/failed; committed → revealed | A lost response is retried with the same idempotency key; the recorded receipt is returned |
| Import | previewed → running → complete/partial/failed; partial/failed → running | Source hash + expected version prevent silent overwrites; each item is recorded |

## Implicit lifecycle inventory

### Catalogue and release

| Field / table | States | Writers and guards |
|---|---|---|
| `fb_card_definitions.status` + `archived_at` | draft, published, retired; `archived_at` is a separate archive marker | `setCardStatus`, `archiveCard`, `mergeCards`, imports. A referenced draft is archived instead of hard-deleted so foreign keys and history survive. A merge carries collection membership, sets, tags, favourites and wishlists to the surviving identity. |
| `fb_artwork_editions.status` | draft, published, retired | `createEditionForCard` chooses the initial state; imports may publish. Editions are not re-statused in place. |
| `fb_variants.status` | draft, published, retired | Created with an edition; imports publish/reset to draft when the source changes. |
| `fb_variant_renders.status`, `fb_variant_back_renders.status` | draft, published, retired | Render completion publishes; media reads require `published` and `archived_at IS NULL`. |
| `fb_sets.status` | draft, published, retired | `changeManagedSet` publishes; a roster change on a published set bumps `version` and returns to draft. Imports do the same. |
| `fb_pools.status` | draft, active, retired | Create → draft, publish → active, edit → draft, retire → retired. A retired pool can currently be edited/republished; treat that as an explicit operator action, not a draw-time state. |
| `fb_catalogue_releases.status` | active, superseded | `publishCatalogue` supersedes the previous active release in the same transaction as the new release. |
| `fb_collections.status` × `view_audience` × `public_approved_at` | draft/published/archived × public/members/private | Explicit collection machine for status; public audience additionally requires Super Admin approval. Dropping out of published clears public approval. |
| `fb_assets.processing_state` | staged, processing, ready, failed, quarantined | Upload inserts `ready`; media/render reads require `ready`. |
| `fb_assets.review_status` | unreviewed, draft, reviewed, approved, rejected, placeholder | Upload/re-upload writes it; print/render/gift publication requires reviewed/approved. |
| `fb_asset_derivatives.status` | ready, failed, stale | Derivative creation writes `ready`; readers require `ready`. |

### Inventory, economy and social

| Field / table | States | Writers and guards |
|---|---|---|
| `fb_card_instances.status` | owned, reserved, surrendered; `traded`/`gifted` are historical-compatible values | Draw/gift insert `owned`; trade insert reserves; trade completion/decline restores `owned`; recycle trigger sets `surrendered`. Never treat `owned` as "never moved". |
| `fb_trades.status` | open, completed, declined, cancelled, expired; `accepted` is retained but unused | Per-revision rows in `fb_trade_acceptances`; completion requires both parties and a trigger validates every reserved card. Expiry is swept by cron; accept also checks time. |
| `fb_gifts.status` | reserved, completed, cancelled, expired | Current player gifts insert `completed` directly and transfer by trigger. The other states are legacy/reserved for a two-phase sender flow. |
| `fb_recycle_receipts` (no status column) | receipt is the terminal record | The recycle guard checks ownership/favourite/lock; the trigger surrenders the copy and credits the wallet. |
| `fb_npc_trade_decisions.decision` | accept, decline | Written once with the trade; the NPC acceptance is recorded in `fb_trade_acceptances` and the human confirmation settles the same trade. |
| `fb_reward_claims` (no status column) | period/cooldown state is derived | Daily claims use a UTC period key + unique index + cooldown trigger; mission claims use a per-day rule key and a daily cap. |
| `fb_mission_assignments` (no status column) | assigned, progress, claimed derived from domain events/claims | The first read selects the whole day's assignment atomically; later inventory changes do not rewrite it. |
| `fb_share_links.status` | active, revoked, expired | Expiry is derived from `expires_at`; revocation is explicit. Every read re-checks status, expiry, owner membership and audience. |
| `fb_outbox.status` | pending, processing, delivered, failed | The local drain processes pending rows and records a notification delivery. |
| `fb_notification_deliveries.status` | pending, sent, failed, suppressed | Written by the outbox drain; external topics are currently suppressed. |

### Identity, authority and sessions

| Field / table | States | Writers and guards |
|---|---|---|
| `fb_bots.status` | active, paused, archived | Platform status endpoint. Active is required for draws, NPCs and Discord authority; paused does not delete data or revoke existing web access. |
| `fb_bot_invitations.status` | pending, accepted, revoked, expired | Acceptance claims the row and grants membership/admin/access-email/audit in one D1 transaction. Expiry is time-derived. |
| `fb_bot_admins.status` | active, invited, revoked | Invitation acceptance upserts active; owner revocation sets revoked. |
| `fb_memberships.status` | invited, active, suspended, revoked | Explicit membership machine; non-active status revokes sessions, restoration clears `revoked_at`. |
| `fb_sessions` | active, revoked, expired | `expires_at` and `revoked_at` are checked on every request; assurance/auth time gate step-up. |
| `fb_agent_grants.status` | active, revoked, expired | Expiry is time-derived; revocation also revokes tokens. Agents cannot create or expand grants. |
| `fb_platform_admins.status` | active, revoked | Provisioning/revocation only; never inferred from Access or Discord. |
| `fb_platform_role_assignments.status` | active, revoked | Scoped `global_collection_admin` only; revocation is idempotent. |
| `fb_access_identities.revoked_at` | active, revoked | Access identity binding; revocation is separate from Foilbury roles. |
| `fb_magic_links` | unused, used, expired | `used_at` is claimed with a conditional update before account/session work. |
| `fb_auth_challenges` | unused, used, expired | `takeChallenge` uses a conditional `used_at` claim; challenge type and user are checked. |
| `fb_webauthn_credentials` | active, removed; counter monotonic | Counter advances on authentication. Removal keeps the last credential invariant inside the delete. |

### Achievements, gifts and jobs

| Field / table | States | Writers and guards |
|---|---|---|
| `fb_achievement_progress.state` | locked, in_progress, earned | Recomputed from committed inventory/events; `earned` is monotonic. |
| `fb_achievement_unlocks.reward_state` | none, pending, granted, failed | Ledger idempotency key is the authority; a lost response reconciles against the ledger. |
| `fb_achievement_unlocks.notification_state` | pending, sent, suppressed, failed | Outbox exists-once; failed outbox rows are retried. |
| `fb_gift_campaigns.status` | previewed, sending, completed, partial, failed, cancelled | Explicit gift-campaign machine. |
| `fb_gift_awards.status` | pending, delivered, failed | Delivered is idempotent. A thrown delivery is left pending for reconciliation rather than guessed failed. |
| `fb_jobs.status` | pending, running, succeeded, failed, cancelled | Explicit render-job machine with attempt fencing; a late worker cannot overwrite a newer attempt. |
| `fb_import_runs.status` / `fb_import_items.status` | previewed/running/complete/partial/failed; discovered/previewed/imported/updated/unchanged/failed | Explicit run machine; each item records its own outcome. |
| `fb_provider_jobs.status` | planned, submitted, succeeded, failed, review, adopted, cancelled | Submit is held until a ceiling and verified adapter exist; review requires a completed result; adopt requires a downloaded output. |
| `fb_npc_collectors.status` | active, paused, retired | Retired is terminal; paused blocks actions but keeps inventory. |
| `fb_npc_actions.status` | planned, completed, skipped, failed | Planned action → draw; completion requires the recorded draw receipt; uncommitted actions reconcile to skipped. |
| `fb_print_proposals.status` | draft, proposed, approved, rejected | Submit requires readiness; review rejects or approves. |
| `fb_discord_interactions.status` | processing, completed, failed | Stale processing rows are closed by a scheduled job; the action receipt remains authoritative. |
| `fb_discord_demo_runs.status` | planned, running, completed, interrupted, failed | Demo/operator bookkeeping; not a player authority. |

## Reserved or currently unreachable states

These values are valid in the schema but do not yet have a product path. Do not
assume a row can reach them, and do not add reporting that depends on them
without first adding the transition.

- `fb_trades.status = 'accepted'` — partial acceptance is represented by the
  per-revision acceptance rows, not this status.
- `fb_gifts.status` other than `completed` — the current player gift flow
  transfers immediately; a two-phase sender flow is not implemented.
- `fb_gift_awards.status = 'failed'` — delivery errors remain `pending` for
  idempotent reconciliation, so campaigns can stay `sending` until resolved.
- `fb_bot_invitations.status = 'revoked'` — invitations expire, but there is no
  operator revoke endpoint yet.
- `fb_share_links.status = 'expired'` — expiry is derived from `expires_at`; the
  stored status remains `active` until an explicit revoke or cleanup.

## Rules for adding or changing a state machine

1. Name the field and every state in this document first.
2. Put a status transition behind one conditional write. Do not read a status,
   decide in application code, then write unconditionally.
3. Make terminal states terminal in SQL, not only in the UI.
4. Give every retry path an idempotency key and a receipt read.
5. Add a regression test for the interleaving that motivated the rule, not only
   for the happy path.
6. Prefer a derived status for time-based expiry; do not require a cron to make
   a link, invitation, session or grant invalid.

## Opening flow

1. **Loading** — the selected capsule and community filter are being compared
   with the live pool. Drawing is disabled.
2. **Ready** — preview shows the live pool, price, eligible entries and effective
   odds after filters.
3. **Submitting** — the client persists one operation key and the exact request
   payload (pool, expected revision, distribution fingerprint, price, channel)
   before sending it. The server checks the same expected revision and
   distribution.
4. **Committed** — D1 commits debit, draw receipt, instance, serial, history and
   idempotency record in one batch.
5. **Revealed** — the UI shows the subject, finish and duplicate/new-subject
   status. Revealing is optional and never changes the award.

A timeout or lost response moves the client to **unknown**, not ready. The
client reconciles by replaying the same operation key and the same canonical
body. If the receipt exists, D1 returns it unchanged; if the request never
arrived, that same approved opening completes once. It cannot reroll the card,
change the price or debit twice. A definitive 409 (`stale_pool_revision`,
`stale_distribution`, `empty_pool`, `insufficient_funds`) proves no receipt was
committed, so the client releases the key after showing the reason.

`src/components/player/draw-studio-state.ts` owns this client contract. It is a
pure reducer plus a small sessionStorage helper, covered by
`tests/unit/draw-studio-state.test.ts`. Persisted records are scoped to
environment, account, Bot and pool, and contain only the operation key, exact
payload, status and timestamps — never the receipt, card or balance. A record
from another environment/account/Bot is removed on mount. A deliberate
"Open another" is the only reset that discards a known receipt.

Refreshing the preview while an operation is unconfirmed never rebinds the
key. If the revision, distribution or price changed, the client keeps the
original payload, shows the old and new values, and requires a new operation
after the receipt is settled. Selecting a different capsule is locked while
`submitting`, `unknown`, `reconciling` or `committed`.

The receipt distinguishes new subject, new finish and another copy.

## Render flow

`createRenderJobs` only queues published variants without a live render (or all
variants with an explicit force). The claim is atomic. `completeRenderJob`
requires a running job, reuses a content-addressed asset if the same bytes were
already uploaded, and writes front/back/derivative records. A retry cannot
create another draw, inventory copy or random outcome.

## Admin forms

Collection and card edits use `expectedVersion`; a stale write returns 409 with
the current version. The UI preserves the form, announces the conflict and asks
the operator to reload. Gift previews are separate from sends; sends require
recent strong authentication and record the actor, scope, reason and campaign ID.

## Render-job fencing — current

- A claim selects `pending` or `failed`, asserts the transition, and updates
  only when the expected status and attempt still match.
- A claim returns the incremented attempt. Complete and fail require that
  attempt; a stale worker cannot overwrite a newer attempt or terminal job.
- Failed → running is an explicit retry edge; succeeded/cancelled are terminal.
- `failRenderJob` and `completeRenderJob` are conditional writes on
  `status='running'` plus the attempt number; a terminal job cannot be reopened
  by a late completion/failure.
