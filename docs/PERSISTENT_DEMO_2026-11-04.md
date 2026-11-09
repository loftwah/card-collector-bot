# Persistent Discord demonstration — 2026/11/04

Status: **delivered in the existing `#card-collector-test` channel**. This is a
retained, scrollable sequence of ordinary bot messages, not an ephemeral tour.
All times are Melbourne local (AEDT, UTC+11) with UTC in parentheses.

## Entry and index

- **Start:** https://discord.com/channels/997734945206313041/1566700752385081355/1567443524209872926
- **Conclusion/index:** https://discord.com/channels/997734945206313041/1566700752385081355/1567443613346959481

| Stage | Message ID | What it shows |
| --- | --- | --- |
| 1 | `1567443524209872926` | Introduction, configured collection, labelled demo actor, scope/build identity, artwork provenance, jump to conclusion |
| 2 | `1567443533567098957` | Complete eight-subject roster image grid and released variants |
| 3 | `1567443538948522089` | Capsule, real price, 32 eligible variants and all four finish odds |
| 4 | `1567443547404243084` | Real opening: Shuichi Saihara — Silver, serial `FB-3-FO-615E07`, draw `drw_mw1t0wttzms5nf50ceskvzak` |
| 5 | `1567443554249220129` | Saved front and back of the awarded copy, readable details, web 3D link |
| 6 | `1567443558955221094` | Plain/Silver/Gold/Holographic catalogue comparison; only Silver is marked owned |
| 7 | `1567443569676124321` | Progress before (`1/8`) and after (`8/8`), 15 copies, 7 duplicates, frozen release target |
| 8 | `1567443590882529332` | Genuine completion: **Three schools**, final draw, +640 Foil credited once |
| 9 | `1567443593218498624` | Real mission claim `Open a capsule` (+60) and replay with no additional credit |
| 10 | `1567443597031120909` | Member-safe profile/achievement summary; no wallet total, email, session or admin control |
| 11 | `1567443610675314771` | Deliberate completion share in the verified members channel |
| 12 | `1567443613346959481` | Index of every stage, source events, build/Worker/scope, unperformed criteria, rollback |

## Actor and configuration

- Guild: **Loftwah** `997734945206313041`; channel **#card-collector-test** `1566700752385081355`.
- Installation: `dci_loftwah_test`; Bot `bot_E9696B66F4660241`; tenant `ten_mvyy304wagy8asnga8tg7r3f`.
- Configured collection: **Danganronpa — Three Killing Games** `col_mvzcwvihmw38qhnz3y43zd19`, release 5, 8 subjects, 32 published variants, members audience.
- Actor: **Foilbury Demo Collector** `usr_demo_discord` — a labelled, non-human demonstration account. Not Dean and not a Discord identity. It is funded by one audited `demo_provisioning` ledger row of 8,000 Foil; no real player wallet was used.
- Scope digest: `5ee761338552f0e1fbadb3957dc75ca42a3d5519a7b60fc25d6681af23f76e87`.
- Source: `a33e4dcb00f46762b4cf8dd2a4445e8dce8cbcaf`; Worker: `dfe306d3-1b15-4ef7-95fa-d9d382326686`; schema `0027_ai_art_provenance_and_scope.sql`.
- A later release (`2ab20a5` / Worker `85d3fb74`) adds the Studio-visible AI preference panel and the read-back verifier; the retained messages were left unchanged.
- Channel audience: `members`. Verified from the live Discord member list: the guild has exactly three members — Dean (Foilbury owner), Kaye (active Foilbury player) and the Foilbury bot. Both humans are active Foilbury members. No Discord permission was changed. The verification is recorded as audit event `aud_discord_audience_2026_11_04`; a future invitee who is not a Foilbury member could see retained member artwork, so re-verify the channel if the guild membership changes.
- Preflight (with actor evidence): **19 PASS · 0 FAIL · 3 BLOCKED**. The remaining blocks are pin capability, the absence of an `@everyone` View Channel deny, and an independent spectator. The reveal policy passes on the recorded members verification; channel visibility remains a separate Discord-permission fact.
- AI-artwork preference: **excluded** for this Bot. The Danganronpa art is a sourced reference with a reviewed provenance record; card design and finishes are Foilbury originals. No AI-assisted print is used in the sequence.

## Real events and receipts

| Fact | Value |
| --- | --- |
| Real openings | 15 |
| Unique subjects | 8/8 |
| Duplicate copies | 7 |
| Draws / instances / owned | 15 / 15 / 15 |
| Spend rows / total | 15 / −1,200 Foil |
| Completion unlock | 1 × `Three schools` (`ach_mvzcxb4fpm0jasra0hcms7v9`) |
| Completion reward | 1 × 640 Foil, ledger `led_mw1t2xp8cket9bnrgw1k49ve` |
| Mission claim | 1 × `Open a capsule`, reward claim `rwd_mw1t3tkk4fbktmjdyrp12gfm`, +60 Foil |
| Mission replay | Same claim id, `replayed: true`, no additional credit |
| Share receipt | `fb_discord_shares` row `shr_demo_2026_11`, message `1567443610675314771` |
| Run row | `fb_discord_demo_runs` `foilbury-demo-2026-11-04`, status `completed` |

## Verification performed

- Every stage read back through the Discord API: same message ID, expected
  footer, expected image (where applicable), no mentions and no private
  identifier. `scripts/discord/verify-persistent-demo.mjs` reports 0 failures.
- Every embed image downloaded and returned HTTP 200 with `image/png`; the roster,
  front/back, four-finish strip, progress pair and completion poster were
  visually inspected.
- The signed-in desktop Discord client was reloaded and scrolled through the
  sequence. The client rendered the text and images; the roster, awarded Silver
  card, front/back pair, finish strip and completion poster were observed after
  lazy image decode. Screenshots are retained privately under
  `.foilbury/demo-readback/`.
- The completion reward and mission claim were reconciled against D1: one
  completion unlock, one 640 ledger row and one mission claim.
- The AI-artwork toggle was exercised in production through the signed-in
  Studio session: `false → true → false`, ending at the original excluded state.

## Unperformed / residual

- **Independent second-account spectator observation:** not performed. The
  sequence is visible to active members; a genuine second identity is still
  required to prove an outsider's view. This does not block the retained
  members-channel delivery.
- **Real mobile client:** not performed. Responsive browser emulation is not a
  substitute.
- **NPC inspection:** no NPC collectors are configured in this Bot, so the
  sequence states that honestly and does not present a synthetic spectator.
- **Future guild membership:** the members-audience verification is a snapshot.
  A non-member invitee could see retained member artwork; the owner controls
  invites and should re-verify if membership changes.

## Rollback and evidence

- Pre-change D1 backup: `.foilbury/backups/prod-pre-ai-scope-demo-2026-11-04.json`
  (93 tables, 32,435 rows, SHA-256 `f341b4f4e75785f528a5421de83aca5e06d6ea2fe93f8ac95dbab185447d20d2`).
- Demo state: `.foilbury/demo/foilbury-demo-2026-11-04.json`.
- Read-back: `.foilbury/demo-readback/verified/` and `.foilbury/demo-readback/*.png`.
- Release receipt: `.foilbury/evidence/release-receipt-a33e4dcb00f4.json`.
- Worker rollback is recorded in the release receipt. Rolling back the Worker
  does not delete retained messages, owned demo cards, serials or ledger rows.
