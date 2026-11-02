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

1. **Ready** — preview shows the live pool, price, eligible entries and effective
   odds after filters.
2. **Submitting** — the client sends one idempotency key and the expected revision.
3. **Committed** — D1 commits debit, draw receipt, instance, serial, history and
   idempotency record in one batch.
4. **Revealed** — the UI shows the subject, finish and duplicate/new-subject
   status. Revealing is optional and never changes the award.

A timeout with an unknown commit state must query/retry with the same key. It
must not start a second draw. The receipt distinguishes new subject, new finish
and another copy.

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
