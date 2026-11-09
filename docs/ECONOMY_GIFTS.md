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

Member set rewards require an explicit review by the current Bot owner with a
recent passkey or MFA session. The review binds the roster, reward and linked
collections. A member claim checks that exact release, current membership and
session, every card's audience and ownership, and the wallet in the same D1
transaction. The member surface derives its label from the authorised roster;
unreviewed set descriptions are not published. This path currently supports
published global and own-Bot member collections and approved public
collections; private grants and other Bots are not included. If bound details
change, revoke the release and review the current version again. Historical
reviews, claims and ledger entries remain intact; re-review does not create a
second reward for the same set version. Public set
release approval remains a separate Super Admin action.

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
