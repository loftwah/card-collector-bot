# Foilbury Discord guided tour

Date: 2026-11-03. Source: `e8a0f196577e9356e5eb6b55980ca3b346b9768b` on `release/owner-sign-in-demo-tour`. Production Worker: `821164fd-7590-42b7-8184-b91d9e21755b`.

This is the host script for the real Discord tour in the existing Loftwah test installation. It is not a storyboard of the website. The tour is built from the same D1 cards, owned instances, serials, Foil ledger and achievement unlocks as the website and REST API.

## What is live now

- Application: **Foilbury** `1566702936615026769`; guild **Loftwah** `997734945206313041`; channel `#card-collector-test` `1566700752385081355`.
- Guild command `/foilbury`, command ID `1566755562551779330`, with `tour` added alongside the existing `open`, `daily`, `collection`, `card`, `packs`, `achievements`, `profile`, `help` and `admin` options.
- Signed HTTP interactions only. No Gateway connection and no privileged intents were added.
- Member-only album used by the tour: **Danganronpa — Three Killing Games**, release roster 8, 32 published variants, 32 front renders, 32 back renders, completion achievement **Three schools** with a frozen 8-card roster.
- Public showcase: four approved original-IP collections. Member franchise art is never posted in a channel that has not been verified for that audience.

Run the read-only preflight before every live demonstration:

```sh
pnpm demo:discord:check          # production
pnpm demo:discord:check --local  # local sandbox
```

The preflight does not draw, grant, spend, post or call a paid provider. Current production result: **15 PASS, 0 FAIL, 2 BLOCKED** (channel visibility and spectator setup; see the matrix).

## Prerequisites

1. The Foilbury bot is installed in the Loftwah guild and the `/foilbury` command is registered. `pnpm demo:discord:check` verifies both.
2. The host is signed into Discord as the authorised Loftwah account that owns the `usr_prod_owner` Foilbury link.
3. `#card-collector-test` is the only approved destination. Do not send DMs, invitations or messages to another channel or server.
4. For a member-only reveal to be channel-visible, the channel must deny `View Channel` to `@everyone` and the installation must record the verified channel audience. The current test channel has no `@everyone` deny, so the preflight reports this as **BLOCKED** and the bot keeps restricted reveals ephemeral. Do not work around this by posting restricted art publicly.
5. A second controlled Discord account is needed for a genuine spectator view. Do not use another person's account. If no second account is available, the spectator item stays **BLOCKED**.

## Host script

Start in `#card-collector-test`. The tour is private by default: each response is visible only to the person who runs the command. Buttons that move between stages never draw, spend or grant anything.

### 1. Welcome and discovery

Command:

```text
/foilbury tour
```

Expected private response: **Foilbury · guided tour**. It shows the approved public showcase, the number of member albums enabled for this Bot, the welcome/daily amounts, your balance, and the privacy rule. Buttons: **Start with an album**, **How free play works**, **Claim daily**, **Packs**, **Next**.

What spectators see: nothing. This response is ephemeral.

Safe actions: read it, press **Start with an album** or **Next**. Pressing **Claim daily** is the first action that changes state.

### 2. A complete eight-card member album

Press **Start with an album**.

Expected private response: **Danganronpa — Three Killing Games**. It shows the members-only audience, the actual eight-card release roster, the 32 published variants, your unique-card progress, and the **Three schools** milestone with its frozen 8-card target and one-time reward.

This is an album, not a token sample. If the account is not entitled, the album is not shown at all.

### 3. Free play, allowance, pools and odds

Press **Next** (or **How free play works**).

Expected private response: **Free play, first run**. It shows the welcome grant, the daily amount and cooldown, the current balance, the eligible pools, their real prices, eligible variant counts and aggregate finish odds. No draw has happened.

If a pool is empty or disabled, the stage says so and does not offer a charged action.

### 4. A genuine opening

Press **Next** to **A real opening**. The stage explains the price and balance. It offers one **Open …** button; nothing is automatic. Pressing it runs the same authoritative draw as `/foilbury open`, with:

- the awarded artwork attached or linked;
- the real name, collection, finish, rarity and serial;
- the pool price, balance after the draw and the odds for that copy;
- **Open again**, **Collection** and **Tour** buttons.

Viewing **View front**, **View back** or **Details** afterwards never spends or awards another copy. 3D inspection is explicitly labelled as a website feature; Discord does not claim native 3D.

### 5. Front, back, details and the four finishes

Press **Next** to **Inspect · Danganronpa — Three Killing Games**. It shows one real published render for Plain, Silver, Gold and Holographic, plus private **View front**, **View back**, **Details** and **Open in web album (3D)** controls for an owned copy.

The buttons are private. Plain/Silver/Gold/Holographic are real catalogue finishes, not mocked swatches.

### 6. Progress, duplicates and the next milestone

Press **Next** to **Progress · Danganronpa — Three Killing Games**. It reports unique subjects, owned copies, duplicates, variant progress, earned badges and the next milestone. If the album is complete, it shows the completion achievement and the one-time reward, or states honestly that the milestone will be evaluated by the next committed acquisition.

This stage does not evaluate achievements or grant rewards by itself.

### 7. Explicit sharing

Press **Next** to **Share deliberately**. It explains that a channel post and its attachment can be copied after delivery, and that consent never overrides a collection restriction. Available buttons depend on the channel:

- **Share public card** — only for an owned card whose effective audience is public. This is the safe channel-visible demonstration in the current test channel.
- **Share album card** — only when the installation has verified that the channel can hold the member audience. It is absent or refused otherwise.
- **Share profile** — counts only; no wallet, email, session or admin data.
- **Share completion** — only when the channel is verified for the album's audience.

A second click for the same object in the same channel returns “already shared” and posts nothing again. The bot records a receipt; it does not claim that an already-posted attachment can be revoked.

### 8. Private administration appendix

Press **Next** to **Administration appendix · private**. It is only available to this Bot's Owner or Admin. It shows Bot-scoped counts and channel policy, with links to **Open Bot Admin**, and for the provisioned Super Admin also **Open Platform Admin** and **Open EmDash**.

This is not a public feature. A Discord moderator or a Bot Admin does not become a platform Super Admin.

## The 7/8 → 8/8 transition

The local demonstration uses the real administrator gift and achievement services:

```sh
pnpm demo:album --mode seven --apply       # prepare 7 unique cards
# open the album/tour and show 7/8 and "Three schools" in progress
pnpm demo:album --mode complete --apply    # one real grant completes the frozen roster
# show 8/8, "Three schools" earned and the one-time 640 Foil reward
```

The script prints the dry-run plan by default. `--apply` is required. It only targets `player@foilbury.local` and the Danganronpa album in the local database. It records a gift campaign with the reason `Foilbury demo album: danganronpa-three-games`.

To retire only the demo's own grants:

```sh
pnpm demo:album --mode reset --apply
```

This marks only instances acquired by a Foilbury demo album campaign as `surrendered` and writes a `demo_retired` history row. It never deletes ledger rows, serials, unlocks or another player's cards.

Production preparation is deliberately not run. A production plan must use dedicated demo identities, take a D1 JSON backup first, preserve the historical wallet/cards/ledger, use the same bounded grant service, and be separately approved. Do not seed production from the local helper.

## Audience matrix

| Actor / destination                        | Intended view                                                                    | Current evidence                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Initiating user                            | Private balance, inventory, achievement progress and eligible collection details | PASS locally and in Workers tests; live Discord click BLOCKED pending the host's session |
| Authorised ordinary member                 | Their own ephemeral tour; opted-in public share posts; public links              | Local browser + Workers tests PASS; second human spectator BLOCKED                       |
| Signed-out / non-member outsider           | Approved public showcase only; no member roster, badge, render or spoiler        | Production public smoke PASS; Discord outsider BLOCKED (no second account)               |
| Bot Owner / Bot Admin                      | Their explicit Bot controls only                                                 | Bot admin tests PASS; live Discord admin appendix BLOCKED                                |
| Sole platform Super Admin                  | Separately Cloudflare-Access-protected platform admin and EmDash                 | Access policy/JWT tests PASS; fresh human MFA BLOCKED                                    |
| Wrong Bot / wrong channel / another server | Reject safely, charge nothing                                                    | Workers tests PASS                                                                       |
| Removed member                             | Reject commands and old confirmation buttons; never auto-restore membership      | Workers tests PASS                                                                       |

### Delivery modes

- **Ephemeral** — only the invoker sees it. Used for the tour, member cards, balances, achievements, admin status and restricted finishes.
- **Channel message** — everyone with channel access sees it, and attachments can be copied. Used only for an explicit share after audience checks.
- **Web link** — independently authorisation-checked. A link is not a grant.

The current `#card-collector-test` channel has no `@everyone` View Channel deny. Therefore the preflight marks member channel-visible delivery **BLOCKED**; the bot keeps restricted art ephemeral and allows only public original-IP shares in that channel.

## Error recovery

| Symptom                                                       | Action                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| “This server is not bound to a Foilbury Bot”                  | Check the guild ID and installation; run `pnpm demo:discord:check`.                                                                               |
| “Foilbury is not enabled in this channel”                     | Move to `#card-collector-test` or update the channel allowlist through Bot Admin.                                                                 |
| “Discord gameplay is paused”                                  | A Bot Owner uses `/foilbury admin enable surface:game`, then confirms. The admin path is explicitly allowed while gameplay is disabled.           |
| “No member album is available”                                | Enable the collection for this Bot; the tour will not invent one.                                                                                 |
| “Pool is empty”                                               | Use another pool or re-enable a collection; nothing was charged.                                                                                  |
| “Render missing”                                              | The card is not ready; choose another card. The tour never substitutes a fake image.                                                              |
| “This channel has not been verified for that card's audience” | Keep the member card private. Publish only public showcase material, or have an operator verify a genuinely restricted channel.                   |
| “already shared”                                              | The receipt is working; nothing was posted twice.                                                                                                 |
| “no longer an active member”                                  | Membership was revoked. An administrator must restore it deliberately; the bot will not auto-rejoin.                                              |
| Duplicate/stale button                                        | The interaction is idempotent for draws and confirmations. Read the recorded result; do not retry with a new interaction to force a second award. |

## Acceptance matrix

| Item                                                                                                        | Status                             | Evidence                                                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| Production preflight (installation, registration, album, renders, achievement, public showcase, identities) | PASS                               | `pnpm demo:discord:check` — 15 PASS, 0 FAIL, 2 BLOCKED         |
| `tour` command registered without removing existing commands                                                | PASS                               | Discord API command read-back, command ID unchanged            |
| Member-only restricted reveal stays ephemeral in an unverified channel                                      | PASS                               | `tests/workers/discord.test.ts` private-delivery test          |
| Channel-visible member reveal in a genuinely restricted channel                                             | BLOCKED                            | Test channel has no `@everyone` deny; no channel policy is set |
| Public original-IP share in an authorised channel                                                           | PASS locally / live BLOCKED        | Share receipt + audience tests; live click needs the host      |
| Complete eight-card album and real 7/8 → 8/8 transition                                                     | PASS locally                       | `pnpm demo:album` + `docs/evidence/demo-album-transition.json` |
| Live Discord desktop welcome/open/front/back/progress/share                                                 | BLOCKED                            | Requires Dean's Discord client; do not impersonate             |
| Live Discord mobile                                                                                         | BLOCKED                            | Requires a real mobile device/client                           |
| Genuine second-account spectator view                                                                       | BLOCKED                            | Requires an authorised second person/account                   |
| Removed member, wrong Bot, wrong channel, wrong server denial                                               | PASS (Workers tests)               | `tests/workers/discord.test.ts`                                |
| Non-member / signed-out public-only boundary                                                                | PASS (production smoke)            | `pnpm test:deployed`                                           |
| Ephemeral content absent from spectator view                                                                | BLOCKED live / designed and tested | Ephemeral flags and tests; no second human yet                 |
| No duplicate ownership, charge, reward or announcement on replay                                            | PASS (Workers tests)               | draw, confirmation, achievement and share receipts             |

## Cleanup

- The local tour fixture only touches `player@foilbury.local`, its own gift campaigns and the local D1.
- `pnpm demo:album --mode reset --apply` retires only demo-acquired instances.
- Do not delete `.foilbury/`, `.dev.vars`, production backups or another person's evidence.
- The preflight is read-only; it does not leave a message, draw or grant behind.
- Live test messages stay in `#card-collector-test`. Delete only messages this run created; never delete another member's history.

## Evidence pointers

- `.foilbury/evidence/discord-preflight-2026-11-03.json` — sanitised preflight result.
- `.foilbury/evidence/demo-album-transition.json` — 1 → 7 → 8 unique cards, achievement/reward states.
- `.foilbury/demo/latest/index.html` — 28-stage local storyboard, including Platform Admin and the native EmDash console.
- `docs/evidence/deployed-smoke.json` — production public/privacy smoke.
- `docs/AUTH_ACCEPTANCE.md`, `docs/DISCORD_ACCEPTANCE.md` — identity and deployment records.
