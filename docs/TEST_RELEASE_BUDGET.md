# Test and release budget

Target: the pull-request test flow and the production release flow each finish
inside **five minutes (300 seconds)** on a clean machine. The budget is measured,
not estimated.

## What runs, and why

| Gate                                | Runs                                             | Why it is required                                                                                                                   |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                        | Every PR and every release                       | One complete correctness gate: access config, release/contract scripts, acceptance runner, Astro types, unit tests and Worker tests. |
| Production build                    | Every PR and every release                       | Proves the emitted Worker bundle, not only the source tree.                                                                          |
| Browser journeys                    | Only when `scripts/ci-affected.mjs` selects them | Auth, editorial, album and privacy journeys are the expensive checks. Documentation, styling and unrelated paths skip them.          |
| Production deploy + read-only smoke | Release only                                     | Uploads the artifact that was checked and reads back the build SHA and public HTTP boundaries. No draw, grant or content mutation.   |

The complete gate is **not** duplicated: `pnpm check` typechecks, the production
build uses `--skip-typecheck`, and the release script builds once and deploys that
artifact. The release does not run the PR browser suite again; the affected live
journey remains a separate, explicit acceptance step.

## Concurrency, not skipped coverage

`pnpm check` runs these independent gates concurrently:

- access configuration
- release, contract and route-inventory script tests
- assisted-acceptance runner
- Astro typecheck
- unit Vitest suite
- Worker Vitest suite

Every gate still runs in full. Only wall-clock time changes.

The browser journeys run on a **separate runner in parallel** with the
correctness gate. They do not extend the critical path, and they run only when
their behaviour changed. The release and browser jobs use separate checkouts, so
one cannot mutate the other's local database or fixtures.

## Enforcement

- `.github/workflows/check.yml` has four jobs: scope, check, browser and budget.
  The scope job records the start time before checkout. The budget job runs after
  both parallel jobs, fails if either did not pass (a skipped browser job is
  allowed), and fails if the whole flow exceeds 300 seconds.
- `scripts/deploy-production.mjs` refuses to upload when checks and the build
  exceed the 240-second pre-deploy budget. The release receipt records total
  elapsed time, each phase and `within_budget`.
- `scripts/lib/routine-release.mjs` owns the 300-second and 240-second constants
  and the fail-closed budget helpers; `tests/scripts/routine-release.test.mjs`
  covers the boundary.

## Measured evidence

Local, 2026-11-08, warm dependency cache:

| Flow                                             | Time   |
| ------------------------------------------------ | ------ |
| `pnpm check` (sequential, before)                | 65.5s  |
| `pnpm check` (concurrent gates, after, warm)     | 28.9s  |
| `pnpm check` (concurrent gates, after, cold)     | 50.2s  |
| Production release (check, build, upload, smoke) | 123.4s |

GitHub Actions, before parallel jobs:

| Run                                    | Time  | Notes                       |
| -------------------------------------- | ----- | --------------------------- |
| NPC trading, all four browser journeys | 5m24s | `pnpm check` alone was 157s |
| Latest docs-only PR                    | 3m28s | `pnpm check` alone was 160s |

GitHub Actions, after parallel jobs:

| Run                                | Flow time | Notes                                                            |
| ---------------------------------- | --------- | ---------------------------------------------------------------- |
| PR #115, all four browser journeys | **164s**  | Check job 2m04s, browser job 2m27s; 136s inside the 300s budget. |
| PR #115, evidence refresh          | **169s**  | Check job 2m35s, browser job 1m56s; 131s inside the budget.      |

The benchmark selects browser journeys from the **cumulative PR diff**, so this
PR's `package.json` change correctly selects all four. The docs-only skip is
covered by `tests/scripts/ci-affected.test.mjs`, which runs in every
`pnpm check`.

The budget table is written to every CI job summary. The introducing run is
https://github.com/loftwah/card-collector-bot/actions/runs/42444137964.

### Production release, 2026-11-08

Source `08f7eb90d786061969d2de00426e164963d8afa1`, Worker
`5dd329fd-3afc-4edf-bd7f-9157726450e0`, rollback
`e5bd9fd9-5c7c-4fb0-908d-f6d943bd9f78`.

| Phase                  | Time  |
| ---------------------- | ----- |
| Checks                 | 22.7s |
| Production build       | 6.0s  |
| Pre-deploy total       | 35.7s |
| Upload and propagation | 31.2s |
| Read-only live smoke   | 4.3s  |
| **Total**              | 73.6s |

The receipt records `within_budget: true` with 226.4s remaining:
`.foilbury/evidence/release-receipt-08f7eb90d786-6125697f-1495-432b-a8f3-0bc265c713a0.json`.
The pre-deploy D1 backup is
`.foilbury/backups/d1-2026-11-08T03-57-54-302Z.json` (96 tables, 33,990 rows,
SHA-256 `a1069d40d7dee290d518ffd66ed344c2acdea45ca399f2e4275d410e9471d626`).
No migration was applied; the release was code and documentation only.

## Re-measure

```sh
/usr/bin/time -p pnpm check
pnpm release:check
```

`pnpm release:check` performs the full pre-deploy path without uploading.
A real release writes `.foilbury/evidence/release-receipt-<sha>-<id>.json` with
the budget block; inspect `elapsed_seconds` and `within_budget`.
