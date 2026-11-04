# Start the Foilbury tour — live entry

Published and verified 2026-11-04 14:20 AEDT (2026-11-04 03:20 UTC).

## The link

**https://discord.com/channels/997734945206313041/1566700752385081355/1567185366014763079**

- Guild: **Loftwah** `997734945206313041`
- Channel: **#card-collector-test** `1566700752385081355`
- Application: **Foilbury** `1566702936615026769`
- Message: `1567185366014763079` (bot-authored, existing onboarding message updated in place)
- Command: `/foilbury` `1566755562551779330`

The entry is one persistent channel message. It needs only View Channel, Send
Messages, Embed Links and Read Message History. It does not need Manage
Channels, Manage Roles, Manage Messages or pinning.

## What the entry contains

- **Start the tour** — action button `foilbury:tour:welcome`. Pressing it opens
  the private guided tour at stage 1. This is a real component handled by the
  signed HTTP interaction endpoint; it is not a web link dressed as a button.
- **Claim daily** — `foilbury:daily`, the same shared allowance as
  `/foilbury daily`.
- **Packs** — `foilbury:packs`, real eligible capsules, prices and odds.
- **Web tour**, **Open cabinet**, **Public showcase** — link buttons to
  `https://foilbury.loftwah.com/tour`, `/cabinet` and `/showcase`.
- The route field names all eleven stages, including the private administration
  appendix. The text states the privacy rule: member-only artwork stays in
  private responses; only a deliberate public-safe share appears in the
  channel.

No button on the entry draws, spends or grants by itself.

## Verify it

```sh
pnpm discord:tour:entry --dry-run      # validated payload, no Discord call
pnpm discord:tour:entry                # update the recorded entry
pnpm demo:discord:check                # read-only; includes the tour entry check
```

The preflight now reads the entry back and asserts that it still carries the
`foilbury:tour:welcome` control and a `/tour` link. Current production result:
**17 PASS, 0 FAIL, 4 BLOCKED**. The four blocked items are pinning, channel
visibility, an independent spectator and an authenticated actor session.

Workers test `starts the guided tour without drawing, spending or granting`
sends the exact `foilbury:tour:welcome` component and asserts a private
response, the tour welcome and no ledger/draw change.

## Owner route — shortest practical session

Open the link above while signed in as the authorised `usr_prod_owner` account
(Dean).

1. Press **Start the tour**. Expected: **Foilbury · guided tour**, private, with
   your balance, the public showcase, member album count and free-play amounts.
   Nothing charged.
2. Press **Start with an album**. Expected: **Danganronpa — Three Killing
   Games**, members-only, collection release version, roster, 32 published
   variants, your unique progress and the **Three schools** frozen milestone.
3. Press **Next** → **Free play, first run**. Expected: welcome/daily amounts,
   real eligible pools, actual prices and aggregate finish odds. No draw.
4. Press **Next** → **A real opening**, then the single **Open …** button.
   Expected: one private reveal with artwork, name, finish, rarity, serial,
   price, balance after debit and the odds for that copy. This is the step that
   spends Foil and creates a new instance.
5. Press **Next** → **Inspect**. Expected: saved front and back, details,
   Plain/Silver/Gold/Holographic render examples, and a clearly labelled
   **Open in web album (3D)** link.
6. Press **Next** → **Progress**. Expected: unique subjects, owned copies,
   duplicates, variant progress, earned badges and the next milestone. It does
   not award anything passively.
7. Press **Next** → **Share deliberately**. Expected: public-safe share only
   (if you own a public card); album share remains absent because this channel
   has no verified member audience. Pressing an available share posts one
   public message; pressing it again returns “already shared”.
8. Press **Next** → **Administration appendix · private**. Expected for Dean:
   Bot counts, Studio, Foil & grants, Owner operator console, Platform Admin and
   EmDash links. An ordinary member sees a denial instead.

For the complete versioned set and achievement transition, use a dedicated
labelled demonstration account. Do not grant the owner a second full set to
produce screenshots. The existing local proof is in
`.foilbury/evidence/demo-album-transition.json`; a production transition needs
its own real receipts and authorised actor.

## What is still unperformed

- A real click on **Start the tour** from Dean's Discord client. The entry is
  live and API-verified; the interaction itself is not simulated or claimed.
- A real Discord opening on the current deployed build. The previous real
  openings in this channel are historical (2026-11-02/03) and are not evidence
  for the current build.
- An independent spectator observation. A second tab of the same account is
  not a spectator.
- A channel-visible member reveal. The channel has no `@everyone` View Channel
  deny, so member-only art remains private. Do not change that merely to make
  the demo public.

## Rollback

The previous message payload is retained at
`.foilbury/evidence/discord-tour-entry-before-2026-11-04.json`. To restore it,
PATCH the same message with that JSON body (or re-run the publisher with a
reviewed payload). Deleting the message is not required and would remove the
entry other members may already use.

The publisher never posts to another channel, never DMs, never mentions
`@everyone` and never edits a message authored by anyone else.
