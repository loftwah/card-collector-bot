# SEO and public discoverability

Foilbury indexes only approved public showcase content. Membership is the privacy
boundary; `noindex`, robots rules and cache headers support it but never replace
authorisation.

## Indexed surface

- `/` — public showcase landing.
- `/cabinet` — public collection browser and filters.
- `/cabinet/:slug` — public card details, only when every collection the card
  belongs to is public-approved.
- `/tour` — public-safe guided tour, real public cards only.
- `/brand-kit` — reviewed identity assets and downloads.
- `/showcase` — public-safe stills, playable trailer/teaser and export manifest.
- `/journal` — existing EmDash editorial index.
- `/sitemap-public.xml` — generated from public collections, public cards and
  the fixed public routes only.
- `/robots.txt` — allows the public surface and disallows administration, play,
  account, API, EmDash, platform administration, invitations, Studio and Bot creation.

## Route contract

| Surface | Audience | Indexable | Canonical | Metadata | Structured data | Cache |
|---|---|---|---|---|---|---|
| `/` | Signed out | Yes | `/` | Showcase title/description | `WebSite` | Public |
| `/cabinet` | Signed out | Yes | `/cabinet` | Public catalogue | `CollectionPage` in page | Public |
| `/cabinet/:slug` | Signed out, public card only | Yes | card path | Card title/description, public render image | `VisualArtwork` + breadcrumbs | Public |
| `/tour` | Signed out | Yes | `/tour` | Tour title/description | None needed | Public |
| `/brand-kit` | Signed out | Yes | `/brand-kit` | Brand kit title/description, OG asset | None needed | Public |
| `/showcase` | Signed out | Yes | `/showcase` | Public media | OG image; no private video | Public |
| `/journal` | Signed out | Yes | `/journal` | Editorial | `Article` on post | Public |
| `/play/*` | Signed in member | No | path | Generic/private | None | `no-store` |
| `/studio/*` | Signed in scoped role | No | path | Generic/private | None | `no-store` |
| `/admin/*`, `/platform-admin/*` | Access + role | No | path | Generic/private | None | `no-store` |
| `/s/:token` | Explicit share, rechecked | No | share path | Generic for non-public; member gate | None | `no-store` |
| `/api/*` | Authorised | No | n/a | JSON | None | `no-store` |

The public sitemap includes only the fixed public routes, approved public
collections and approved public cards. It never includes `/play`, `/studio`,
`/admin`, `/platform-admin`, `/_emdash`, `/s/:token`, member collections, member
cards or personal media.

## Deliberately not indexed

- `/play/*`, `/account/*`, `/admin/*`, `/platform-admin/*`, `/_emdash/*`,
  `/api/*`, `/invite/*`, `/create-bot`.
- Member-only NBA and franchise collections, profiles, variants and media.
- Member profiles, achievement feeds, gift receipts, inventories, ledgers and
  share links.
- Any page whose data is gated by membership. A crawler gets the same
  authorisation decision as any other client; there is no bot bypass.

## Metadata and structured data

- Public card pages emit `VisualArtwork` JSON-LD with a public image URL only.
- The landing page emits `WebSite` with a search action for the public cabinet.
- Canonical URLs use the production origin and the path only.
- Open Graph and Twitter images use the brand social preview, not member media.
- Titles and descriptions are specific to the public page; no franchise roster
  names are used to bait search traffic.

## Review notes

- The public showcase is small by design. It is not a programmatic SEO surface
  for the 16 members-only properties.
- A public-to-members visibility change removes the URL from the next sitemap
  and returns 404 to unauthenticated card and media requests. Search engines may
  retain a cached snippet; there is no reliable recall of already-crawled data.
- No achievement pages, member profiles or inventory pages are public.
