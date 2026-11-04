# Workflow states and failure recovery

The transition tables live in `src/server/state.ts` and are covered by
`tests/unit/state.test.ts`. They are deliberately small typed functions, not a
framework or one giant application machine.

| Machine | States and valid transitions | Recovery |
|---|---|---|
| Collection | draft → published/archived; published → draft/archived; archived → draft | Stale edits use `expectedVersion` and return 409 |
| Membership | invited → active/revoked; active → suspended/revoked; suspended → active/revoked; revoked → active | Suspension/revocation revokes sessions; restoration is audited |
| Gift campaign | previewed → sending/cancelled; sending → completed/partial/failed; partial/failed → sending; completed → completed | Per-recipient awards are idempotent; retry only processes pending/failed |
| Render job | pending → running/cancelled; running → succeeded/failed; failed → pending | Claim is atomic; complete requires `running`; retries never re-roll a draw |
| Draw | ready → submitting → committed/unknown; unknown → committed/failed; committed → revealed | A lost response is retried with the same idempotency key; the recorded receipt is returned |
| Import | previewed → running → complete/partial/failed; partial/failed → running | Source hash + expected version prevent silent overwrites; each item is recorded |

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
