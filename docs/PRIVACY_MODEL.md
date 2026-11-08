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

## Explicit shares

A share link is a snapshot, not a capability grant. `/s/:token` rechecks the
current collection audience and the viewer's membership on every request. A
member-only share shows a generic gate to a signed-out or non-entitled viewer;
it never renders the card, badge, roster or serial. Public-safe shares may show
approved original-IP content, but the page still uses `noindex` and generic
metadata for member material. Revocation stops future requests; it cannot recall
bytes already downloaded or posted to Discord.

## Share lifecycle closure — 2026/11/08 (#15)

### Source and deployment

- Source `ed31255950d601f9c668563be2174b60b1e34365`; production Worker
  `e5bd9fd9-5c7c-4fb0-908d-f6d943bd9f78`.
- `pnpm check`: 46 files, 343 tests, 0 failures.
- Earlier source `89247913e2588e43926f436569fdc108a282cf1c` / Worker
  `46f15618-ba0c-4f3b-b6cb-b9917409aa00` carried the substantive policy repair;
  `ed31255` only makes the off-switch semantics explicit.

### Repair

- A card share inherits the **most restrictive** audience of every live
  collection the card belongs to. A public share is re-evaluated against all
  current collection memberships on every read; adding the card to a private
  or members-only collection closes the public view.
- The owner membership must be `active` **and** have `revoked_at IS NULL` for a
  link to stay active. A status-only inconsistency no longer keeps a link alive.
- A bearer token is resolved across Bot tenants, but membership is checked
  against the link's own tenant. A public share from a second Bot can open for a
  signed-out recipient; a member share still requires membership there.
- An active but unauthorised viewer receives a generic gate and an empty
  snapshot payload. The helper no longer hands private names, collection
  metadata or serials to a future unfurl/API consumer.
- Collection shares require current view authority at creation. Players cannot
  mint a share for a private collection they cannot see.
- The sharing master switch is documented as a creation switch: turning it off
  stops new links; existing links stay live until expiry or explicit
  revocation. The UI says this, and the regression proves it.
- The confirmation panel distinguishes public-safe links from members-only
  links instead of implying that any holder can open every link.

### Regression matrix

- Anonymous, member, cross-Bot and owner views of member shares.
- Public → members and public → private collection audience changes.
- A card filed in a public and a members collection; a later private filing.
- `revoked_at` set while `status` is still active.
- Revoked link, expired link, revoked owner membership and cross-Bot token.
- Inaccessible collection share at creation.
- Off-switch semantics: existing link stays active; new link is refused.

### Live production proof (source `8924791` / Worker `46f15618`)

- Member card share `shr_mw77zoms4xy4d1xgk8wj2d0g`: signed-out HTML returned
  HTTP 200 with the generic members gate, the title `Member share · Foilbury`
  and **no** card name, collection name or serial. The signed-in member browser
  rendered the card front/back with the `Members-only` badge and no serial.
- Public collection share `shr_mw77zoto8c851v7hab9ggezd`: signed-out HTML
  rendered `Bubbles` with `Public-safe`.
- Revoking both through the authenticated share API returned `status: revoked`.
  Both URLs then returned HTTP 404, `Share not found · Foilbury`, with no card
  name or serial, signed out and signed in.
- The retained demo profile share still resolves for a signed-in member as a
  `Members-only` snapshot; it omits wallet, email, account ID and serials.
- Evidence: `.foilbury/evidence/share-live-2026-11-08.json`,
  `.foilbury/evidence/share-member-live-2026-11-08.png`,
  `.foilbury/evidence/share-revoked-live-2026-11-08.png`.

### Not claimed

The issue's underlying UX alignment with #12/#13 is not a substitute for the
independent spectator or physical-mobile checks tracked by #7. Those remain
BLOCKED and are not claimed here.
