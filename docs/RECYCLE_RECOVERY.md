# Recycle recovery and rollout

Recycle requests now reserve the original account, Bot, copy, quoted credit and idempotency key before settlement. A receipt and an explicit cancellation compete in D1: a cancellation that wins is terminal, and a receipt that wins is returned instead. Retrying a cancelled key cannot surrender a copy. Existing receipts and ledger history are retained.

The card detail interface stores the pending key and quote in origin-scoped IndexedDB, separated by Bot, account and copy. It retries the same key after an uncertain response, and cancellation requires a separate confirmation. If browser storage is unavailable, starting a new recycle is held. Clearing browser data or using a different browser or device does not recover that local key; no automatic cross-device recovery is claimed. A confirmed terminal outcome is required before the local key is removed.

Migration `0036_recycle_actor.sql` requires a coordinated rollout. **Drain every old Worker and other unguarded receipt writer before applying it.** Old writers do not create a reservation, so their receipt inserts fail closed after the migration; an old in-flight writer sharing a pending reservation must not overlap the new cancellation protocol. Take the required production backup and prepare rollback before any production migration. This migration has not been applied by these tests.

Rollback is not an online trigger swap: first stop cancellation and drain all recycle writers, preserve request/receipt/ledger history, and verify a restore or a reviewed compatibility migration against a copy. Re-enabling an old unguarded writer while cancellations are active would invalidate the race guarantee. A production rollback procedure has not yet been executed or qualified.

Reservation and receipt history are not automatically deleted. Long-term retention and an operator-supported cross-device recovery interface remain separate work.
