# Discord presentation layer

Status: reusable builders and structural tests. The command router still owns
every command decision and has not been migrated in this change. This document
is a specification for that integration, not a claim that the live Discord
client has been re-reviewed.

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

The layer uses the Foilbury Signal palette from `DESIGN.md`:

| Token         | Value     | Use in embeds                                        |
| ------------- | --------- | ---------------------------------------------------- |
| Deep current  | `#044e4a` | committed receipt, card view, profile, share preview |
| Electric aqua | `#00a99c` | getting started, capsule picker, active progress     |
| Ice           | `#c8f4ee` | quiet empty states and locked achievement surfaces   |
| Signal lime   | `#c9f25f` | completed album and earned achievement               |
| Carbon / ink  | `#07110f` | error and denied states                              |
| Bone          | `#eff5f1` | contact-sheet paper and high-contrast text           |

Discord only guarantees a narrow colour strip for an embed. Colour is therefore
a second channel, never the only signal: every rarity, finish, progress,
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

| Builder                  | Primary state and action                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `welcomeMessage`         | First use: balance, daily availability, free inspection, daily/open/packs and a field-guide link.           |
| `capsulePickerMessage`   | Price and real odds per capsule, disabled/unavailable reasons, one obvious open action per capsule.         |
| `revealReceiptMessage`   | Committed pull: card, finish, rarity, serial, pool, price, balance, odds, replay marker, artwork recovery.  |
| `cardFaceMessage`        | Saved front or back render, collection, side, finish, serial, source, swap/details/album controls.          |
| `albumProgressMessage`   | `7/8` or `complete`, missing subject, finish families, milestone, optional completion share.                |
| `achievementMessage`     | Earned/in-progress/locked, progress, reward, visibility, earned date, criteria, optional share.             |
| `missionProgressMessage` | Daily cap, reset, per-mission progress, claimed/claimable/not-complete states, bounded claim buttons.       |
| `profileMessage`         | Balance, owned/unique cards, daily state, badges, Bot scope and privacy note.                               |
| `sharePromptMessage`     | Destination and its verified audience, what will post, what stays private, what is never included, consent. |
| `stateMessage`           | Designed error, empty and denied states with a next step and optional private diagnostic reference.         |
| `stateFromError`         | Reviewed human copy selected by error code; never echoes a raw `ApiError` message or SQL.                   |

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
