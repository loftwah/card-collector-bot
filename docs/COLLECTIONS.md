# Collections, cards and card backs

## What a collection is

A collection is a named world with:

- a name and URL slug;
- a short description;
- a logo/mark (local path or HTTPS image) with a monogram fallback;
- an optional banner;
- an accent tone;
- a status (`draft`, `published`, `archived`);
- explicit card membership.

It is not a Discord server role and it is not a category string. Collections are first-class rows in `fb_collections`; their card membership is `fb_collection_cards`.

## Global vs Bot-owned

| Scope | Who manages it | Who sees it | Can a Bot edit it? | Can a Bot turn it on/off? |
|---|---|---|---|---|
| Global | Super Admin | Every active Bot | No | Yes, per Bot |
| Bot | Bot Owner, or Bot Admin with content capability | Only that Bot | Yes | Yes, for that Bot |

- `fb_bot_collections` records the enabled/disabled state per Bot.
- A Bot that has a global collection enabled can use its cards in that Bot's pools. Existing cards, serials and ledger history remain in the Bot that awarded them.
- Disabling a collection affects future drops only. Existing owned copies remain owned and viewable.
- A card can belong to more than one collection. It is eligible while at least one of its collections is enabled for the Bot.
- The draw preview excludes cards from disabled collections and the D1 draw trigger rejects a stale attempt before charging.

## Who can create what

- **Super Admin** can create a global collection or a Bot collection, and can manage global collection details.
- **Bot Owner** can create and manage collections owned by their Bot.
- **Bot Admin** can manage Bot collections only when the invitation includes the `content` capability.
- Ordinary players cannot create or edit collections.

The Foilbury admin page `/admin/collections` shows the global collections and the current Bot's collections together. Global rows are read-only for a Bot Admin; the on/off switch is still available to the Bot.

## Logos and descriptions

- The API accepts `logoUrl` and `bannerUrl` as a local `/...` path or an HTTPS URL.
- Uploaded source art is stored privately in R2 and can be selected in the artwork editor.
- The current curated marks are `/art/collections/bubbles.svg`, `fighter.svg`, `protocol-11.svg` and `shared.svg`. They are geometric marks, not invented artwork.
- If no logo is set, Foilbury renders a monogram using the collection name.

## Card detail and card backs

- Each card detail page shows the bio, an optional quote, rarity, collection, serial, provenance and ownership history.
- The front is the layered composition from private source assets. The back is a real view using the Foilbury card-back artwork plus the collection mark and description.
- The public card page can show the published front render and a card-back view. On a narrow screen the card is still the primary object.
- Discord receives one published image — the front render. Discord does not need a multi-layer composition. The web keeps the interactive flip and private layers.

## Layering and image generation

The authored pipeline is background → subject → material → frame → effect → text. It is deterministic and does not require an image-generation provider. Existing artwork is sufficient; paid FAL/ElevenLabs generation is intentionally not run without a recorded ceiling and approval.

If a creator wants a new collection logo or card artwork, they can upload a licensed asset through the Bot artwork editor or import a curated source through the existing import commands. A global collection logo should be an asset Dean has the right to publish.

## Source of truth

- Foilbury: card identity, artwork editions, variants, categories, tags, collections, pools, awards, inventory and money ledger.
- EmDash: journal drafts, editorial media and the operator publishing workflow.
- Cloudflare Access: administrative authentication boundary.

There is no two-way catalogue sync. An EmDash journal post cannot mint a card or change a wallet.

## 2026-11-03 visibility update

- `scope` (global/bot), `status` (draft/published/archived), `view_audience`
  (public/members/private) and distribution (`fb_bot_collections.enabled`) are
  separate. See `docs/PRIVACY_MODEL.md`.
- New collections default to `members`; only the Super Admin can set `public`
  and that requires a published collection plus an explicit approval timestamp.
- A card inherits the most restrictive audience across every collection it
  belongs to. Adding a public link cannot widen a members-only card.
- Global member collections are reusable by authorised members of a Bot
  community. Global media renders are authorised against the card's effective
  audience, not the caller's current tenant; Bot-private media remains scoped.
- Public showcase approval for the existing Loftwah originals was reviewed
  individually: Bubbles, Fighter, Protocol 11 and Shared Characters. The NBA and
  16 third-party launch collections are members-only.
- The members' album has `/play/collections` browsing, collection progress,
  spoiler-safe profiles, typed attributes, front/back/3D inspection, duplicates,
  provenance and achievement progress.

## EmDash boundary (reconciled)

The older issue sentence that implied EmDash should own card/profile editing is
superseded by the working product boundary:

- **Foilbury D1** is the source of truth for collections, cards, subjects,
  variants, recipes, achievements, pools, awards and inventory.
- **EmDash** remains the editorial CMS for journal posts and media, with its
  existing Access-protected operator workflow.
- A second editable card catalogue was deliberately not added. Editorial card
  fields are validated through the Foilbury import/Admin API, and the public
  journal does not mint cards.
- The real editorial journey is the existing `/journal` + EmDash console; card
  creation remains the Foilbury Admin UI/import path.
