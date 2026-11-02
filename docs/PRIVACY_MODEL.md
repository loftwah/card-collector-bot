# Visibility, membership and media delivery

Foilbury keeps four dimensions separate. A single switch must never silently
change another.

| Dimension | Field / mechanism | What it controls |
|---|---|---|
| Ownership / reuse scope | `fb_collections.scope`, `owner_tenant_id` | Who can edit and reuse the catalogue |
| Lifecycle | `fb_collections.status`, `archived_at` | Draft, published or archived |
| Viewing audience | `fb_collections.view_audience` | Public, members or private |
| Distribution | `fb_bot_collections.enabled`, pools, tags | Whether a card can drop in a Bot |

`public` is not a synonym for `global`, and `published` is not a synonym for
`public`.

## Audience rules

- **Public** — `view_audience = 'public'` and `public_approved_at` is set. Only
  the provisioned Super Admin can approve. Signed-out visitors can read it.
- **Members** — an active membership in the owning album or Bot community. A
  signed-in account without an active membership is still denied.
- **Private** — the owner scope's administrators plus explicit rows in
  `fb_collection_viewers`. Everything else is denied.

An account and a membership are separate records. Magic-link sign-in and a
verified Discord interaction establish ordinary main-album membership through
the normal onboarding path; an operator does not need to edit SQL. Suspending or
revoking membership revokes active sessions for that album and denies further
catalogue and media access.

## Effective card access

A card inherits the **most restrictive** audience of every live collection it
belongs to. Adding a permissive collection link can never widen access. A card
in a public collection and a members collection is members-only. Cards with no
collection are visible only to signed-in members of their owning tenant and are
never public.

## Enforcement surface

The same predicates (`src/server/modules/visibility.ts`) are used by:

- the public showcase, cabinet index, collection detail and card detail;
- search, category/tag filters and taxonomy lists;
- card/variant hydration and collection progress;
- pool previews and draw eligibility;
- achievements, biographies and structured attributes;
- `/media/render/:asset`, `/media/back/:asset`, `/media/derivative/:id`,
  `/media/asset/:id` and the legacy `/media/public/:asset`;
- the REST API and Discord card/details/back components.

Public media is cacheable for a year. Member and private bytes are
`private, no-store`, `Vary: cookie`, and are checked on every request. An
un-guessable URL is not permission.

## Cache and revocation policy

- Public → members/private: the new decision applies to the next request.
  `max-age=31536000` caches may retain previously fetched public bytes at
  third-party caches. There is no reliable recall; the only safe policy is not
  to publish restricted content publicly.
- Members → private: media requests re-check the collection relation each time.
- Membership revocation: sessions are revoked and subsequent authorisation
  fails. Copies already downloaded by a person cannot be recalled.
- Discord attachments are hosted by Discord after delivery. This is a residual
  limitation, not DRM. Reveals use private/ephemeral responses or member-only
  destinations, and card images are attached bytes rather than a public URL.

## Public showcase policy

The public showcase is limited to approved Loftwah-owned project worlds. The
launch manifests for NBA and the 16 third-party properties are **members-only**
and are not used in public HTML, metadata, sitemaps, Open Graph images, sample
grids or marketing copy. `Shared Characters` was reviewed individually because
its cards are the same original cast; it is approved public content.
