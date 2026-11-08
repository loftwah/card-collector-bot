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

---

# 2026-11-08 extension — collector identity, missions and achievements

Status: **PRODUCTION_VERIFIED** for the retained extension. The original twelve
messages are preserved; stages 13–17 were added as ordinary channel messages,
then the chapter index and introduction were refreshed to link the complete
sequence.

## Entry and new stages

- **Start:** https://discord.com/channels/997734945206313041/1566700752385081355/1567443524209872926
- **Chapter index:** https://discord.com/channels/997734945206313041/1566700752385081355/1567443613346959481
- **Conclusion:** https://discord.com/channels/997734945206313041/1566700752385081355/1568646096039968830

| Stage | Message ID | What it shows |
| --- | --- | --- |
| 13 | `1568646069347287090` | Real daily board: world visit, front/back inspection and one ordinary capsule opening; all three missions claimed, 180/180 earned; claim replay `rwd_mw6g7dwjqzgzpfwwan3pp47f` returned the same claim and no extra credit |
| 14 | `1568646077413068820` | Seven earned badges, nine in-progress badges, 155 locked; re-evaluation kept 7 unlocks and 1,900 achievement Foil unchanged |
| 15 | `1568646082571927552` | Saved collector composition: Binder desk, Hairline frame, Corner marks, Wide tracking, Soft sheen, exact featured Kyoko Kirigiri Gold · Holographic, pinned shelf and earned badges |
| 16 | `1568646092973940806` | Deliberate profile share created through the normal Share profile control and the shared share service; member-audience snapshot, no wallet/email/account ID/serial, private recipient link not republished |
| 17 | `1568646096039968830` | Conclusion and full index to stages 1–17, source events, build/Worker identity, unperformed criteria and rollback |

## What actually ran

- Source `5e375e09f26abb4c8cc1b45481cdc6665e0f5f21`; Worker
  `7f1a64b8-14a4-401a-bcba-53d05f88a388`; schema `0029_profile_presentation.sql`.
  Script integration `3680086eff7244ea9a9927e2d5dc483e40b6c477`.
- The demonstration collector completed a real world visit, a front/back
  inspection and one ordinary Danganronpa capsule opening:
  **Kyoko Kirigiri — Silver**, serial `FB-3-FO-EC577E`, draw
  `drw_mw6fr69m14dz6q4n1mb2axbj`, −80 Foil.
- Three real mission claims: `rwd_mw6g7dwjqzgzpfwwan3pp47f` (Visit a world),
  `rwd_mw6g8c99p9dnqaa99868phnw` (Inspect a card) and
  `rwd_mw6g8f1z8zmd0bjxkq1zqhpe` (Open a capsule), 60 Foil each. The replay
  returned the same claim ID, `replayed: true`, earned 180 → 180 and no extra
  credit.
- Achievements: 7 earned, 9 in progress, 155 locked. Re-evaluation returned
  unlocks 7 → 7 and achievement Foil 1,900 → 1,900; no duplicate award row.
- Collector composition saved at version 3: Binder desk, Hairline frame, Corner
  marks, Wide tracking, Soft sheen, featured Kyoko Kirigiri Gold · Holographic,
  shelf Kyoko/Monokuma/Kaede/Nagito, badges Warm metal, Hold it to the light,
  First trial and Three schools.
- Profile share `shr_mw6ewp9c8w5m8at06zz46k16`, created through the normal
  Share profile control at 2026/11/08 00:01 AEDT, member audience, expires
  2026/11/14. The private recipient link is retained in the run state, not
  republished in the channel.

### Release 6 refresh after the Gonta import

The bounded production import added Gonta Gokuhara to Danganronpa on
2026/11/08 (release 5 → 6, 9 subjects, 36 variants; pool revision 4). The
retained demonstration was refreshed without another draw or charge:

- Stages 2, 3, 7, 8, 10, 11, 12 and 17 were patched. Stage 2 now shows the
  complete 9-subject release-6 roster and 36 eligible variants.
- The demonstration collector owns 8 of the 9 current subjects. Stage 7 shows
  `8/9` with Gonta marked missing, not a false `9/9`.
- `Three schools` remains a genuine, once-only release-5 achievement. Stage 8
  and its image now say **release 5 achievement, 8/8 frozen subjects, current
  release 6 has 9**. The award is not revoked or re-awarded.
- Stage 10 reports `8/9` current-release subjects and the frozen release-5
  milestone. Stage 11 is labelled a release-5 completion share.
- Stages 12 and 17 now show `8/9` unique current-release subjects and schema
  0030. The read-back remains **17/17 PASS**; no new messages were posted, so
  all historical message IDs remain stable.

The Gonta render and its four finishes are in
`.foilbury/evidence/incremental-import-2026-11-07T18-00-36-952Z/contact-sheet.png`.
The import backup, aliases, collection release and pool revision are recorded
in `docs/CONTENT_QUALITY_MATRIX.md` and the import evidence JSON.

## Repairs made during the journey

- A later draw receipt presented earlier achievement unlocks as newly earned
  rewards and added their historical Foil to the `credits_total`. The receipt
  now includes only unlocks whose `earned_at` belongs to this draw; a worker
  regression test covers the second-draw case.
- The mission summary stayed at `0/180` after a claim because the header stats
  were server-rendered outside the client component. The summary now lives in
  `DailyMissions` and updates from the persisted board.
- The profile customiser preview said “Your collector name” instead of the
  collector's name. It now receives and renders the saved display name and
  initials.
- The customiser and share heroes let baked collection-banner lettering collide
  with the collector name. Both now use the same left-to-right scrim so the
  name, featured copy and badges remain readable.

## NPC extension · 2026-11-08

Stages 18–20 were added as retained messages after the #9 production cast and
trade were exercised; stage 17 was refreshed from the old conclusion into an
index so no historical message was deleted.

- **Stage 18 — NPC collectors:** https://discord.com/channels/997734945206313041/1566700752385081355/1568794094019551435
- **Stage 19 — deterministic decision:** https://discord.com/channels/997734945206313041/1566700752385081355/1568794095722434741
- **Stage 20 — completed transfer:** https://discord.com/channels/997734945206313041/1566700752385081355/1568794097450225675
- **Stage 21 — full index:** https://discord.com/channels/997734945206313041/1566700752385081355/1568794099039998004

Stage 19 also records a declined preview: offering Chiaki Nanami Silver
`FB-3-DE-4E3CB0` for Victor Wembanyama Gold `FB-4-TA-A2CA60` returned “the NPC's
only goal copy” and created no trade or reservation. Stage 20 attaches a composed
front-art image of both exact copies, with the serials and the direction of the
exchange.

The recorded trade is `trd_mw6vw8jl6zv9c2pbsh9jwzs5`: Dean gave Anakt Garden
Gold `FB-4-DE-7A6A37` and received Gonta Gokuhara Plain `FB-4-TA-626A51` from
Taro Brass. Production read-back after settlement: the Anakt Garden instance is
owned by Taro Brass's synthetic user, the Gonta instance is owned by
`usr_prod_owner`, both serials and `acquired_at` values are unchanged, the trade
has two acceptances at revision 1, and production still has 147 card instances,
230 Foil ledger rows, one NPC decision and one completed trade. No card or Foil
row was created by the transfer.

## Verification performed

- `scripts/discord/verify-persistent-demo.mjs`: **21/21 PASS**, zero failures.
  Every required image downloaded with HTTP 200 `image/png`; stage 12 and stage
  17 indexes link every stage; no mentions or private account/tenant identifiers.
- The signed-in desktop Discord client was used to inspect stages 13–17, the
  refreshed chapter index and the introduction extension/conclusion links. The
  stage images rendered inline and decoded.
- The production profile, missions and achievements surfaces were inspected at
  the member origin after the deploy. The share page rendered the saved
  composition with the featured exact copy, shelf and badges.
- Pre-change D1 backup:
  `.foilbury/backups/prod-pre-demo-extension-2026-11-07.json` (94 tables,
  32,885 rows, SHA-256
  `7b0df1ae5f2e172ba0dc86bed138a0c985eba3f87e77b22245a23d77f5ccbd42`).
- Release receipt:
  `.foilbury/evidence/release-receipt-5e375e09f26a-8b77e21c-d9be-4864-8229-351dd6af3be9.json`.

## Unperformed / residual

- **Independent second-account spectator:** still BLOCKED. The sequence and the
  member-only share were observed by the signed-in demo/member client, not by an
  independent person.
- **Real mobile Discord client:** still BLOCKED. Responsive browser emulation is
  not a physical-device observation.
- **NPC cast and trading stages:** posted as stages 18–20 from real production
  records. They are a human-initiated trade against a labelled, deterministic
  synthetic collector; they are not a second human participant or an independent
  spectator.
- The profile share expires on 2026/11/14. The retained message shows the
  recipient snapshot; the private link itself is not evidence beyond that date.
