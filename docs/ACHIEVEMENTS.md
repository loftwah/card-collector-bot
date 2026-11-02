# Achievements

Achievements are first-class domain records, not a page local to the website.
The same definition, progress and unlock feed the web album, Discord and the
audited reward ledger.

## Model

| Record | Purpose |
|---|---|
| `fb_achievement_definitions` | Versioned name, description, criteria, reward, visibility, badge family and scope |
| `fb_achievement_progress` | Per member, version, progress, target and locked/in-progress/earned state |
| `fb_achievement_unlocks` | Immutable unlock with earned date, source event and reward/notification state |
| `fb_domain_events` | Trusted committed events with a tenant-scoped dedupe key |
| `fb_outbox` | Notification intent, separate from reward entitlement |

Definitions are scoped `platform` or `bot`. A Bot Admin can create Bot-scoped
achievements only; platform definitions require the provisioned Super Admin.
Adding a new version creates a new definition row. An old earned version is never
rewritten or revoked by later content.

## Criteria

- `unique_cards` — lifetime distinct subjects.
- `finish_first` — first copy of a finish family.
- `finish_set` — Plain, Silver, Gold and Holographic for one subject.
- `collection_unique` — lifetime distinct subjects in a fixed collection.
- `collection_complete` — a recorded roster target stored in the version.
- `explore_collections` — distinct authorised collections explored.
- `gift_received` — an administrator gift delivered.

Milestones use lifetime copies (traded or recycled copies still count as "ever
collected"). Completion targets are recorded in the definition version, so a
later roster addition cannot revoke a completed rule. Imports, gifts and trades
count through the same committed inventory facts; recycling does not remove a
lifetime milestone.

## Evaluation and rewards

1. A trusted domain event is recorded with a unique dedupe key.
2. Progress is recomputed from committed inventory and events.
3. The unique unlock constraint is the concurrency boundary; concurrent or
   replayed evaluation can award at most once.
4. The reward is credited with the ledger idempotency key
   `achievement:<definition>:<version>:<user>`.
5. Notification is queued separately. A notification failure cannot lose the
   reward or cause a second payout.
6. Backfills call the same evaluator and are resumable because every step is
   idempotent.

Corrections are new audited rows; unlock history is not deleted.

## Visibility

Achievement definitions carry `public`, `member` or `private` visibility. The
listing combines that with the viewer's collection entitlement, so a badge name,
criterion, progress value or reward cannot reveal a restricted collection or
spoiler to a non-member. Discord responses are ephemeral/private and use the
same service.

## Badge design

Each category has a different silhouette: star (milestone), diamond (finish),
compass (exploration), hex (collection) and parcel (community). Palettes are
specific to the badge family rather than one trophy recoloured. Locked badges
are desaturated; earned badges settle once and respect reduced motion.
