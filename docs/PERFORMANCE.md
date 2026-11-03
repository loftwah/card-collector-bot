# Runtime latency check — 2026-11-03

This is a reproducible, read-only sample, not a performance claim. It records the
release source and production origin so a later change can be compared with the
same method.

## Method

```sh
for path in / /api/v1/status /api/v1/collections /cabinet /sitemap-public.xml; do
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w "%{time_total} $path\n" "https://foilbury.loftwah.com$path"
  done
done
```

Sequential requests, no cache priming, `curl time_total` in milliseconds.
Production Worker `821164fd-7590-42b7-8184-b91d9e21755b`, source
`e8a0f196577e9356e5eb6b55980ca3b346b9768b`.

## Results (median of 5, Melbourne edge)

| Route | Median | Min | Max |
|---|---:|---:|---:|
| `/` | 412.6 ms | 343.9 ms | 465.1 ms |
| `/api/v1/status` | 131.6 ms | 119.0 ms | 136.5 ms |
| `/api/v1/collections` | 156.6 ms | 134.3 ms | 171.6 ms |
| `/cabinet` | 373.9 ms | 330.2 ms | 403.2 ms |
| `/sitemap-public.xml` | 285.1 ms | 261.2 ms | 312.5 ms |

## Interpretation

- These are single-region samples from one client. They include network RTT,
  TLS reuse effects and Cloudflare edge scheduling.
- No before/after comparison is claimed. No independent wait was removed in
  this pass, so these numbers are a baseline for issue #3, not evidence of a
  gain.
- The authenticated member and Discord interaction paths are not measured here;
  they require a real session/Interaction and are tracked separately.
- Re-run the same command from the same network after a change and compare
  medians, not a single warm request.

Issue #3 remains open until a confirmed independent waterfall is removed with a
comparable measurement and the permission, ordering, rate-limit and idempotency
behaviour is preserved.

## 2026-11-04 re-measurement after the backlog changes

Same local scenario as the earlier report (headless Chromium, 1440×900,
`pnpm perf:local`). The collection-preference, NPC and wishlist work did not add
a request waterfall to the draw, catalogue or collection hot paths.

| Route | TTFB | LCP | CLS | Images | Long tasks |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/play` | 139 ms | 172 ms | 0.0001 | 963 KB | 0 |
| `/play/collections` | 125 ms | 176 ms | 0.0001 | 620 KB | 0 |
| `/play/collection` | 74 ms | 116 ms | 0.0000 | 1,361 KB | 0 |
| `/play/draw` | 33 ms | 64 ms | 0.0000 | 0 KB | 0 |
| `/play/achievements` | 34 ms | 72 ms | 0.0002 | 220 KB | 0 |
| `/admin` | 34 ms | 60 ms | 0.0000 | 0 KB | 0 |
| `/play/card/:id` | — | 76 ms | 0.0002 | 320 KB | 0 |

Read-only production samples from the same host (three requests per route):
home TTFB 0.25–0.96 s, `/cabinet` 0.22–0.32 s, `/cabinet/tux` 0.29–0.31 s.
These are not field percentiles and do not describe the new source, which is not
deployed. The draw preview now also returns the approved distribution
fingerprint and collection labels; this is one response, not an extra request.

Changes reviewed and dispositioned:

- Collection preference filtering is evaluated inside the existing pool preview
  query/hydration. No per-card extra query was introduced.
- NPC actions call the same preview/draw path; they are bounded to one preview
  and one draw per action, with no fan-out. Scheduled runs cap at ten NPCs per
  Bot per cron invocation.
- Wishlist pages are bounded to the member's own wishes and one pool lookup per
  wish; the list is small by nature and is not on the draw hot path.
- The public draw-preview payload regression was a contract omission, not a
  performance change; it is covered by a route test.

Remaining production measurement: deploy the reconciled source, then repeat the
same scenarios against the built Worker and inspect sampled Cloudflare traces.
