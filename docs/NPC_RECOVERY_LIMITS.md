# NPC action recovery

A planned or legacy failed NPC action holds that collector until its outcome is
reconciled. Retrying the **same action key** looks up the original draw receipt;
if the draw committed, the action is completed and its counter advances once.
The retry does not submit a new draw. A different key and scheduled progression
remain blocked while the action is unresolved.

If a current planned draw fails, an atomic no-draw/no-receipt/no-ledger check may record it
as skipped, with an audit event. For a historical planned or failed action, an authorised
manager can explicitly call `POST /api/v1/npcs/:id/reconcile` with the original
`idempotencyKey`. This action may stop an in-flight draw before it commits; an
ordinary play retry never requests that cancellation. If the draw commits first,
the action remains pending until its original key recovers the receipt. The
action, draw and ledger history are retained. An evidence-free legacy failure
also records its previous status, result and completion time; failures with
ambiguous action evidence remain held. Do not delete them or invent an outcome.

This fence relies on every running draw worker checking the planned action in
its D1 commit batch. Older workers without that check must be drained before
enabling the new resolution path. Local tests do not prove a deployed rollout.

Daily NPC admission conservatively counts planned, failed and completed actions.
Ambiguous legacy failures can therefore still require reconciliation even if
they were pre-commit failures. This is an availability limitation.
