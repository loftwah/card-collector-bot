# EmDash and Foilbury responsibility boundary

Foilbury has exactly **one** editable card catalogue and exactly **one** editable
journal. They are different products with different authorities, joined by
read-only links and the same D1/R2 bindings.

| Concern | Foilbury administration | EmDash editorial |
|---|---|---|
| Card identity, subject, edition, variant | **Source of truth** | Never edits |
| Card artwork layers, finishes, renders | **Source of truth** | May reference a published render in an article |
| Collections, scope, release roster, audience | **Source of truth** | May link to a public collection page |
| Pools, odds, draws, inventory, serials | **Source of truth** | No access |
| Achievements, criteria, rewards | **Source of truth** | May describe an achievement in editorial copy |
| Permissions, Bot roles, scoped platform roles | **Source of truth** | No access |
| Journal title, body, editorial media, publish state | Read-only handoff at `/admin/editorial` | **Source of truth** |
| Public `/journal` route | Reads EmDash | **Source of truth** |

## Surfaces

- `/studio` and `/admin` — Foilbury operations. Cards, collections, pools,
  inventory, achievements, people and audit.
- `/admin/editorial` — a read-only recent-posts handoff and a link to the native
  EmDash console. It deliberately has no card editor and no second journal form.
- `/_emdash/admin` — the native EmDash operator console with its own Access
  policy and CMS account. Foilbury never auto-provisions a CMS account from an
  Access session.
- `/journal` — the public editorial index and article pages.

## Rules

1. Do not add a card, variant, pool or achievement editor to EmDash. A second
   editable catalogue would drift and could mint unsafe state.
2. Do not add a journal draft/editor/publish workflow to Foilbury. Editorial
   belongs in EmDash's native workflow.
3. Links between systems are stable public or authorised routes, not a two-way
   sync loop.
4. EmDash publication can never mint a card, change a wallet, alter a serial or
   bypass membership. Foilbury reads editorial content; editorial does not
   write gameplay records.
5. The shared database is an implementation detail, not a licence to couple the
   admin surfaces.

## Verification

- `pnpm test:editorial` covers draft → artwork → publish → pool → draw → disable
  through Foilbury only.
- The EmDash console is exercised separately in `pnpm demo` (local dev bypass)
  and, for production, through the Access-protected native console.
- `docs/EMDASH_BOUNDARY.md` is the canonical boundary; `PRODUCT.md` and
  `DESIGN.md` link here rather than restating a conflicting rule.
