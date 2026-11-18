# Test and release budget

**Routine testing and release share 120 seconds**, including the production
build, upload and live check. Run a focused regression only when the change
warrants it. Time any checks run before deployment together with the release.

- `pnpm check` and `pnpm test` run the same dependency-free release and Access
  checks. The pull-request workflow runs that command only when its inputs
  change. Use the existing targeted Worker or browser test when the affected
  behavior warrants one.
- `pnpm deploy:production` builds once. It verifies the tracked source and
  emitted artifact, checks for schema drift and concurrent releases, and
  records the previous Worker for rollback. It verifies the active version,
  build identity and public access boundaries after upload. It uses one
  deadline for preparation, upload and verification.
- Read the private `.foilbury/evidence/release-receipt-*.json` for the exact
  source, Worker version, rollback target, elapsed time and live results.
  Exercise the affected live behavior within the same budget. If upload status
  is uncertain, reconcile the active Worker before any retry.
- Schema changes use the existing backup and migration workflow. The two-minute
  ceiling does not change its data safeguards.
