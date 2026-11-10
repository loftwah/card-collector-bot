# Foil economy and administrator gifts

Foil is the earned currency. A **foil finish** is a card material treatment.
The UI keeps the two words distinct: “✦ Foil” for currency, “Gold finish” or
“Holographic finish” for cards.

## Main-album defaults

Migration `0008` applies these only to the tenant with slug `cabinet`. Creator
Bot configurations are untouched.

| Setting | Before | After |
|---|---|---|
| Starter grant | 350 local / 350 production seed | **800 Foil** |
| Daily reward | 120 | **480 Foil** |
| Daily cooldown | 86400 s | 86400 s |
| Standard opening | 80 Foil | 80 Foil |

At 80 Foil per opening, the welcome grant is ten standard openings and the daily
reward is six. The change is versioned and audited as
`economy.updated` by `migration:0008`.

## Finish weights

The launch pools assign each eligible variant a weight by finish family:

| Finish | Weight | Effective probability when all four are eligible |
|---|---:|---:|
| Base / Plain | 45 | 45% |
| Silver | 30 | 30% |
| Gold | 18 | 18% |
| Holographic | 7 | 7% |

The pool preview shows the actual effective probability after collection, Bot,
channel, tag and player filters. If a finish is missing from a pool, the
remaining weights are re-normalised and the preview shows the new totals; the
UI never displays a stale headline rate. Pity is explicitly disabled.

These are product defaults, not claims about every creator's pool. A creator can
set their own reviewed weights. No player-specific odds are applied.

## Earning and spending

- Daily allowance, achievement rewards, set completions, gifts and recycled
  duplicates are the intended sources.
- A draw is one D1 batch: debit, draw receipt, instance, serial, history and
  idempotency record.
- Retrying a draw returns the recorded result; it never re-rolls or charges.
- There is no purchase, cash-out, marketplace, NFT, advertising grind or
  investment value.

## Gifts

`Send a gift` supports:

| Kind | Behaviour |
|---|---|
| Foil | Credits the recipient's Bot wallet with an audited ledger row |
| Opening | Credits Foil equal to `openings × current standard opening price`, labelled as an opening gift |
| Card | Creates one owned copy with its own serial and `admin_gift` history |

Rules:

- Super Admin: any authorised Bot scope and a capped platform campaign.
- Bot Owner / delegated reward-capable admin: this Bot only, max 1,000 Foil per
  recipient. Super Admin: max 10,000 Foil per recipient.
- Bulk campaigns are capped at 500 recipients.
- A campaign is the durable idempotency boundary; each recipient award has its
  own unique row. Retrying a send never double-delivers.
- Platform campaigns resolve deliberate per-tenant membership rows and credit
  each recipient's own Bot wallet. They never merge wallets.
- The message is plain text, length-limited and strips `@everyone`, `@here` and
  user mentions.
- Receipts are visible at `/play/gifts`; notification delivery is separate from
  fulfilment.
- Corrections and reversals are new audited ledger rows. Existing ledger rows
  are never edited. A card gift is never recorded as a currency credit.

## Achievement gifts

Administrator gifts count toward `gift_received` only when delivered. They do
not create a circular reward chain: achievement rewards are ledger credits and
do not themselves emit gift/achievement events.

## 2026-11-10 — Slice 6 economy clarity

- **Production:** source `c636e0ac257876d19b5e6f70798b493b7844bd30`, Worker
  `91bb9131-1cac-487c-a986-42b66943d45a`. Receipt:
  `.foilbury/evidence/release-receipt-c636e0ac2578-b06cfe15-d11d-482b-a500-78050f827825.json`.
- **One sentence:** the draw page now says "You get 480 Foil free every day.
  Each capsule shows its own price; the cheapest open capsule is 80 Foil. Foil
  is earned through daily allowances, missions and achievements, never bought."
- **Exact contents and odds:** the draw page lists every eligible copy with its
  finish and actual chance before the open button. The finish summary and the
  full table are both server-confirmed by the existing preview API. Empty pools
  never charge.
- **Next action:** a server-rendered panel chooses the honest next step from the
  current balance, the cheapest positive-price capsule, the closest shelf and
  duplicate count. It links to the daily allowance, missions, the binder, trades
  or the selected capsule.
- **Ledger:** `/play/rewards` now shows "Your Foil history" with human labels
  (`Capsule opening`, `Achievement reward`, `Daily or set reward`, `Trade`,
  `Recycle`, `Correction`), the real balance after each entry, and no raw
  developer `kind`. Corrections remain compensating entries; history is never
  edited.
- **No casino framing:** the copy contains no bet, wager, jackpot, spin,
  paid re-roll or shop language. `Open again` remains a new, priced pull; a
  replay never rerolls or charges.
- **Real signed-in draw (production):** Danganronpa capsule, Monokuma — Plain,
  serial `FB-4-DE-C40598`, opening −80, after debit 1640, achievement reward
  +40, settled balance 1680. The ledger shows the matching `Capsule opening`
  (−80, balance 1640) and `Achievement reward` (+40, balance 1680) rows. This is
  a real product draw, not a mock.
- **Live layout:** draw and rewards checked at 1440 and 390, light and dark; no
  horizontal overflow. The draw listed 36 eligible rows and the exact finish
  odds. The rewards ledger showed the new draw and reward rows with balance
  after each.
- **Checks:** `pnpm check` 7/7; `pnpm test:ui` passed; `pnpm test:product`
  57/57; `pnpm build` production artifact.
- **Data:** the pre-change D1 JSON backup is
  `.foilbury/backups/d1-2026-11-10T00-53-53-721Z.json` (97 tables, 37,016 rows,
  SHA-256 `9c9aabc505cc4cbf7dc418f2e8610de6696ede61960b389fa5b3866a6aac1c01`).
  The draw is an ordinary product action; no schema or collection pointer
  changed.

