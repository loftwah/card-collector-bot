# Collection artwork review records

The bulk content provisioner is paused for writes. Its dry run inventories
manifests without generating artwork. This validation tool checks retained
review material; it does not publish or grant approval.

A schema 1 selection names one collection and contains `assets` entries for
exactly `mark`, `cover` and `back`. Each entry contains a `path` relative to
the review root and the lowercase `sha256` of its bytes. A `review` contains
`decision: "approved"`, `reviewer_kind: "agent"` or `"human"`, `reviewer_id`,
UTC `reviewed_at`, a substantive `note`, and `evidence` with its own relative
`path` and `sha256`. Use the actual person or agent who made the decision;
never label an agent decision as a human decision.

Run `node scripts/content/check-review-selection.mjs <selection.json> <review-root> <collection-slug>`.
It checks paths, the collection identity, all four file digests and the review
fields without writing files. A changed file invalidates its recorded hash.

This local record does **not** authenticate the reviewer, prove their visual
judgement, prove rights, or authorize publication. It is not connected to a
write path. A future importer must bind the validated bytes to a trusted,
auditable decision and revalidate at publication; reading a file after this
check alone is vulnerable to replacement. Human-only decisions remain human-only.

The undeployed server review ledger accepts a separate, human-only decision via
`POST /api/v1/studio/collections/<id>/art-reviews`. It requires a recent
strong-authenticated session, live collection authority, a decision and note,
and the existing asset ID and SHA-256 for each of `mark`, `cover`, `back` and
`evidence`. The server checks the stored image bytes, records the signed-in
actor, and appends an audit event. It does not consume this local JSON, change a
collection or approve publication. Agent decisions are not yet supported by
this path. This ledger is not an automatic importer authorization: a write to
the same object-storage key after the server reads it cannot be fenced by a D1
transaction. Publication needs an immutable object version or an equivalent
revalidation and fencing strategy.
