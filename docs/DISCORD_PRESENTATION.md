# Discord presentation layer

Status: reusable builders are integrated into the primary command/component
router. See **Adoption status — current** at the end. Real Discord desktop/mobile
client review remains a separate observation; this document does not claim it.

Source: `src/server/discord/presentation.ts`
Tests: `tests/workers/discord-presentation.test.ts`

## Boundary

The presentation layer never reads D1, spends Foil, awards a card, checks a
role, or decides whether a share is allowed. The router passes a **committed**
domain result into a builder. The builder returns a Discord callback payload
that the existing HTTP interaction handler already knows how to deliver.

Card art remains the saved published front or back render. There is no
Discord-only card renderer and no re-composition of private source layers.

## Visual vocabulary

The layer uses the Foil Standard tokens from `DESIGN.md`:

| Token   | Value     | Use in embeds                                              |
| ------- | --------- | ---------------------------------------------------------- |
| Canvas  | `#0a0a0a` | dark reference surface                                     |
| Surface | `#121212` | sealed opening, committed receipt, card, profile and share |
| Raised  | `#1a1a1a` | quiet empty states and locked achievement surfaces         |
| Action  | `#1f5eff` | getting started, capsule picker and active progress        |
| Focus   | `#8fb0ff` | cabinet-rare and review emphasis                           |
| Success | `#7ee2b8` | completed album and earned achievement                     |
| Warning | `#f2cb85` | legendary and pending states                               |
| Danger  | `#ff9a9a` | error and denied states                                    |
| Muted   | `#a3a39e` | common rarity and secondary labels                         |

Foil Standard replaced the earlier neutral/periwinkle tokens on 2026-11-09. The
rejected Signal Fold aqua/lime palette is not used. Discord only guarantees a
narrow colour strip for an embed, so the accent is the app's semantic token and
never the only signal.

Colour is therefore a second channel, never the only signal: every rarity,
finish, progress,
completion, error and denial also carries a text label, a number or a shape.
There are no emoji-only labels and no icon-only buttons. Serial values use
Discord inline code so they remain legible in a proportional client font.

Consistent headings and field names:

- `Your balance`, `Daily allowance`, `First run`
- `Rarity`, `Finish`, `Serial`, `Opened from`, `Balance`, `Odds`
- `Progress`, `Next target`, `Finish families`, `Milestone`
- `Status`, `Reward`, `Visibility`, `Earned`, `Criteria`
- `Destination`, `Visible to`, `Ready to share`, `Stays private`, `Never shared`
- `Next step`, `Reference`

The footer carries the scope and the safety statement, for example
`Foilbury · committed receipt` or `Nothing was charged or changed.`

## Template families

| Builder                  | Primary state and action                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcomeMessage`         | First use: balance, daily availability, free inspection, daily/open/packs and a field-guide link.                                                                   |
| `capsulePickerMessage`   | Price and real odds per capsule, disabled/unavailable reasons, one obvious open action per capsule.                                                                 |
| `sealedRevealMessage`    | Face-down committed opening: card back, pool, price, Reveal card + Collection + album. No result fields.                                                            |
| `revealReceiptMessage`   | Committed pull: card, finish, rarity, serial, pool, price, balance, odds, new/duplicate/wishlist feedback, collection progress, replay marker and artwork recovery. |
| `cardFaceMessage`        | Saved front or back render, collection, side, finish, serial, source, swap/details/album controls.                                                                  |
| `albumProgressMessage`   | `7/8` or `complete`, missing subject, finish families, milestone, optional completion share.                                                                        |
| `achievementMessage`     | Earned/in-progress/locked, progress, reward, visibility, earned date, criteria, optional share.                                                                     |
| `missionProgressMessage` | Daily cap, reset, per-mission progress, claimed/claimable/not-complete states, bounded claim buttons.                                                               |
| `profileMessage`         | Balance, owned/unique cards, daily state, badges, Bot scope and privacy note.                                                                                       |
| `sharePromptMessage`     | Destination and its verified audience, what will post, what stays private, what is never included, consent.                                                         |
| `stateMessage`           | Designed error, empty and denied states with a next step and optional private diagnostic reference.                                                                 |
| `stateFromError`         | Reviewed human copy selected by error code; never echoes a raw `ApiError` message or SQL.                                                                           |

### Reveal receipt parity

`REVEAL_RECEIPT_FIELDS` mirrors the committed Discord draw receipt in
`commands.ts`:

```text
card_id, variant_id, card_name, variant_name, material_key, effect_key,
render_url, serial, pool_name, price, currency, balance_after,
probability_bps, drawn_at, replayed
```

Every field is consumed. `card_id` and `variant_id` stay opaque and are never
rendered into visible copy. `render_url` is used only as a fallback image for a
verified **public** reveal; member and private reveals use only the attached
saved render. A missing render still produces an owned-card receipt with a
recovery instruction.

### Sealed opening, then a deliberate reveal

`/foilbury open` commits the draw first, persists the interaction receipt, then
returns `sealedRevealMessage`. That message contains only the pool, price, a
public card-back image and a `Reveal card` button. No field, title, image,
filename, custom id, accessible name or live announcement carries the card
name, finish, rarity, serial or result render.

`Reveal card` is a separate read-only component interaction
(`foilbury:reveal:<original-interaction-id>`). It recovers the same committed
receipt and builds the result. It never calls the draw service, spends Foil or
creates a copy. Repeating the reveal is free and returns the same card, serial
and settlement. A recovery re-send (`foilbury:redeliver:`) explicitly marks the
result as recorded; the first reveal does not.

The reveal adds owned-result feedback that the committed receipt already knows:
new subject/finish, duplicate count, wishlist hit, the card's collection
progress and whether reward settlement is still confirming. The card artwork is
the saved published render; a missing render leaves the exact serial and an
artwork follow-up rather than a blank or a fabricated image.

## Discord limits enforced

`DISCORD_LIMITS` is the single source of truth:

| Limit                            | Value      | Behaviour                                                            |
| -------------------------------- | ---------- | -------------------------------------------------------------------- |
| Embed title                      | 256        | Truncated with an ellipsis                                           |
| Embed description                | 4096       | Truncated; the 6000-character total is reserved                      |
| Fields per embed                 | 25         | Rejected above the limit                                             |
| Inline fields per Foilbury embed | 5          | Extra inline fields are demoted to full width                        |
| Field name / value               | 256 / 1024 | Truncated                                                            |
| Footer                           | 2048       | Truncated                                                            |
| Embeds per message               | 10         | Rejected above the limit                                             |
| Combined embed characters        | 6000       | Description is reduced; fixed content rejects                        |
| Action rows                      | 5          | Rejected above the limit                                             |
| Buttons per row                  | 5          | Rejected above the limit                                             |
| Button label                     | 80         | Truncated with an ellipsis                                           |
| Custom id                        | 100        | Rejected, not truncated (truncation breaks state)                    |
| Button URL                       | 512        | Rejected; absolute http(s) only, no credentials or secret query keys |
| Attachment filename              | 100        | Sanitised to a safe image basename                                   |
| Message content                  | 2000       | Never emitted by these builders                                      |

Button rules:

- Action buttons use style `1`–`4` and a `foilbury:` custom id.
- URL-only buttons use style `5`, a valid URL and no `custom_id`.
- A link with a `custom_id`, or an action with a URL, is rejected.
- Emoji-only or symbol-only labels are rejected.

## Private by default

Every builder defaults to `flags: 64` (ephemeral/private) and
`allowed_mentions: { parse: [] }`. Builders never accept a raw `flags` value.

A channel response is possible only through `buildMessage` when all of these
are true:

1. The caller states a non-private audience (`public` or `members`).
2. The caller states the verified channel audience.
3. The channel audience is at least as restrictive as the content audience.
4. The caller sets `channelApproved: true`.

`revealReceiptMessage` falls back to private when those checks fail. The share
prompt is always private and rejects an offered item whose audience is wider
than the channel, or whose audience is `private`.

## Attachments

`cardAttachment(render, kind)` creates the only supported card attachment names:

- `foilbury-reveal-card.webp` (or the matching image extension)
- `foilbury-card-front.webp`
- `foilbury-card-back.webp`
- `foilbury-share.webp`

`safeAttachmentFilename` strips directories, neutralises traversal, lowercases
and restricts the stem to `[a-z0-9._-]`, prefixes `foilbury-`, checks the
extension against the MIME type and caps the result at 100 characters. The
server-only R2 key stays in `DiscordAttachment.r2Key` for the handler and is
never placed in visible copy or the review output.

## Local contact sheet

The contact sheet is a structural review aid. It is deliberately **not** a
Discord client and must not be presented as acceptance evidence.

```ts
import { contactSheetHtml, contactSheetJson } from "./src/server/discord/presentation";

const entries = [{ label: "Welcome", message: welcomeMessage(input) }];

const html = contactSheetHtml(entries);
const json = contactSheetJson(entries);
```

- `contactSheetHtml` returns a self-contained, screenshot-ready page with the
  palette, embed structure, button shapes and attachment placeholders.
- `contactSheetJson` returns deterministic JSON; repeated calls with the same
  payload are byte-for-byte equal.
- Both outputs carry the disclaimer and redact `r2Key`.
- The HTML shows attachment names and remote-image hosts, not private bytes.

Real-client review still needs:

- Discord desktop and mobile, at normal and 320 px-like narrow widths.
- A spectator account for member-only and public shares.
- Long display names, huge serials, mixed finish albums, empty and full
  inventories.
- Missing art / failed render delivery and a retry of the same interaction.
- The registered command tree, deferred acknowledgements and ephemeral
  follow-up behaviour.
- Screen reader and keyboard traversal of buttons in the Discord client.

## Integration notes

The router workstream should replace local payload assembly with these
builders, passing the already-committed result. Do not make the presentation
layer fetch data or re-decide authority. Do not add a second card renderer.
Keep the existing interaction handler; these are ordinary message payloads.

Components V2 is not used here. The current classic embeds and action rows are
supported by the desktop and mobile clients and keep the interaction handler
unchanged. Revisit only with real-client evidence that Components V2 clearly
improves readability.

## Verification

```sh
pnpm exec vitest run --config vitest.workers.config.ts tests/workers/discord-presentation.test.ts
pnpm exec astro check
```

The structural suite covers exact payload shape, limit truncation and
rejection, private-by-default responses, attachment naming, reveal-receipt
parity, audience gates, mission/album states and deterministic preview output.
It does not replace a real Discord desktop/mobile/spectator session.

## Adoption status — current

The command router now consumes the shared builders for the primary player
surface:

- `/foilbury help` → welcome/guide builder;
- `/foilbury daily` → daily claim builder;
- `/foilbury packs` and the empty-default picker → capsule picker builder;
- `/foilbury open`, open buttons → sealed opening builder;
- `Reveal card` and the re-send receipt → committed reveal/receipt builder;
- `/foilbury card`, card buttons → card-face builder;
- `/foilbury collection` → cabinet summary builder;
- `/foilbury achievements` → achievements overview builder;
- `/foilbury profile` → profile builder;
- errors/denied states → shared safe-copy state builder.

The handler tests invoke the actual command/component path and assert the
builder-specific titles, fields and action labels. Builder-only tests remain
useful but are no longer the adoption proof.

## Slice 5 — collection identity parity

- **Production:** source `d389861a04bb540bbbe49a7e09ba35d344d2209c`, Worker
  `5137ecc7-04b7-47a9-95a8-75879b9df7f8`.
- `/foilbury collection` now leads the cabinet summary with the most recent
  owned collection's real banner (`image`) and real mark (`thumbnail`). The
  router resolves `/media/asset/...` through the authenticated R2 asset and
  committed `/art/collections/...` through the public origin. `cover_url` is
  never used.
- `/foilbury profile` keeps the chosen account avatar as the thumbnail and the
  saved featured card render as the large image, and now names the featured
  collection with its exact subject progress and audience.
- Pull receipts still use the saved published render, finish, serial, collection
  progress and native actions. No Discord-only card renderer was added.
- The collection summary remains a private response; member/private artwork is
  only attached inside that authorised ephemeral response. A public channel
  share still passes the existing audience checks.
- Presentation and command tests cover banner-first/logo-second, no
  `cover_url`, the profile avatar/featured-card contract, and that profile or
  collection views do not change wallet, inventory or ledger rows. `pnpm
  test:workers` passed 361 tests.
- **Live Discord API read:** the `foilbury` command is registered in the test
  guild with `profile` and `collection` options present. This is command
  registration, not a user invocation.
- **Not claimed:** a live Discord interaction for this slice. No authorised
  human Discord client/spectator interaction was available in this pass; the
  historical 2026-11-08 real-client evidence above predates this change. The
  command path is exercised through the signed interaction handler tests, not a
  live client.

## Real-client evidence — 2026-11-08

Source `08ffd7270435db79f4bc31792604159ab67e6bd9`; Worker
`2c93b5d6-1041-4782-831d-3f7b07105c68`.

The signed-in desktop Discord client, normal inline size, dark theme, in
`#card-collector-test`:

- Sealed opening: message `1568901235795431525`
  (https://discord.com/channels/997734945206313041/1566700752385081355/1568901235795431525).
  Rendered the real Foilbury card back at Discord's 457×639 proxy (750×1050
  source), `Cabinet Draw · sealed`, `−80 ✦`, and Reveal card / Collection /
  Open album. No card name, finish, rarity, serial or result render appeared.
- First reveal: message `1568901484823969802`
  (https://discord.com/channels/997734945206313041/1566700752385081355/1568901484823969802).
  Rendered `Nagisa Momoe — Plain`, Uncommon / Plain / serial `FB-4-DE-DC4892`,
  `New subject and finish`,
  `Puella Magi Madoka Magica — Mitakihara · 4/8 collected`, opening debit,
  after-debit balance, `+280 ✦ · Four wishes`, settled balance `1720 ✦`,
  `0.60% for this copy`, and the committed artwork attachment
  `foilbury-reveal-card.webp`. The periwinkle action buttons and neutral embed
  surface replaced the rejected Signal Fold styling at the time; Foil Standard
  replaced those tokens on 2026-11-09 without changing the message structure.
- The first deploy's reveal (`1568899355954384908`) showed `Recorded result`
  incorrectly. The live run exposed it; source `08ffd727` persists
  `replayed: false` on a first commit and the re-run no longer shows that field.

Screenshots: `.foilbury/evidence/discord-presentation-20261108/`
(`discord-sealed-fixed.png`, `discord-reveal-full.png`).

Not performed and not claimed: a real mobile Discord client, an independent
second-account spectator, or the light Discord theme. Those remain open on
#24. A scheduled-maintenance alert at 08:07 UTC reported `database unavailable`
during the first deployment; the following scheduled runs produced no further
alert, so it is recorded as a transient deploy-window failure rather than a
pass.
