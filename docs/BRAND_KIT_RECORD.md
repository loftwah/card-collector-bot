# Foilbury brand kit record

## Selected identity: Foil Standard

Foil Standard is the working Foilbury identity. It replaces the aqua/lime Signal
Fold system and the short-lived neutral/periwinkle Manrope direction.

- **Mark** — an original two-plane card fold: a paper F over a foil-blue plane
  with a chamfered top-right corner. The opaque icon is the app icon; the
  transparent glyph is the product mark.
- **Type** — Geist Serif 500 for display, Geist Sans for interface and body,
  Geist Mono for serials, odds, labels and provenance. All three are self-hosted
  under `public/fonts/geist/` and licensed under the SIL Open Font License 1.1.
- **Colour** — paper `#fafaf8`, ink `#0a0a0a`, graphite `#5b5b57`, rule
  `#e4e4df`, foil blue `#1f5eff`, and a holo edge
  `#8be9ff → #1f5eff → #b18cff → #e9ff8a`.
- **Voice** — a collector's archive, not a game dashboard. Sentence-case serif
  display, hairline rules, honest data and one signal colour.

The palette, type licensing, rationale and every generated rendition are recorded
in `public/brand/kit/manifest.json`. The selection and application state are in
`public/brand/kit/selection.json`.

## Generation

```sh
pnpm brand:generate
# node scripts/brand/generate-identity.mjs
```

The generator is deterministic and local. It renders the vector masters in real
Chromium with the self-hosted Geist faces, then writes the app icons, favicons,
PWA icons, Discord avatar and banner, Open Graph image, brand-kit specimens and
the generic card back. No paid generation, stock imagery or third-party art is
used.

The older `pnpm brand:generate:legacy` script is retained for the historical
Signal Fold, Bastion and Aperture boards. Those assets remain under
`public/brand/kit/` as reference and are not active identities.

## Shipping surfaces

- `public/brand/mark.svg`, `mark.png`, `mark-mono.svg`, `glyph.svg`
- `public/brand/wordmark.png`, `wordmark-reverse.png`, `wordmark.svg`, `lockup.svg`
- `public/brand/favicon-16.png`, `favicon-32.png`, `favicon-48.png`,
  `apple-touch-icon.png`, `icon-192*.png`, `icon-512*.png`
- `public/brand/discord-avatar.png`
- `public/brand/social-preview.jpg` and `public/brand/kit/social/og-1200x630.png`
- `public/brand/kit/banners/foil-standard-960x540.png` and `-1920x1080.png`
- `public/brand/card-back.webp`

The default share image is the Foil Standard Open Graph card. Public card shares
use the saved card render with its real dimensions; member/private shares fall
back to the brand image, never a private render.

Collection identity uses the collection's own `banner_url` or `logo_url`, never
a card render. `cover_url` is a card cover for card contexts only. Collections
without a banner use the designed mark tile.

## Historical note

Signal Fold was selected under delegated authority on 2026-11-04 and applied to
the Discord application at that time. The owner subsequently rejected it and the
periwinkle/Manrope replacement. Foil Standard was selected on 2026-11-09 after
the owner asked for a Vercel-grade monochrome identity using Geist Serif.

The former board recorded the preceding application icon, cover and description
for rollback. The Loftwah guild icon remains unchanged because it belongs to the
wider server identity; the server banner remains blocked by the guild's Boost
entitlement. The bot profile banner is a Developer Portal surface.

## Verification

- `pnpm check` passes (7 gates).
- `pnpm build` produces the production artifact.
- Light/dark desktop and 390px captures are under `.foilbury/brand-audit/`.
- The final application icon, cover and description are applied through Discord's
  official `PATCH /applications/@me` endpoint and recorded in
  `public/brand/kit/selection.json`.

## Collection identity repair (2026-11-09)

Collection identity uses the collection's own banner or mark, never a card
render. `cover_url` remains a card cover for card contexts only. The play
collections grid, collection detail hero, preference rows, home shelf and share
panel now follow that rule.

The production Total Drama Island collection pointers were restored to the
existing approved original-Foilbury mark and cover assets:

- Logo: `ast_mvzdy3vn1p6c0gnmrxt95e48`
  (`tenants/ten_mvyy304wagy8asnga8tg7r3f/assets/71c74a5c…png`)
- Banner: `ast_mvzeos51g2kn57ppgrkagqz5`
  (`tenants/ten_mvyy304wagy8asnga8tg7r3f/assets/59774069…png`)

Previous pointers, retained for rollback:
`logo_url=/media/asset/ast_mw6t0kqfyty1006xp1j8fcnk`,
`banner_url=/media/asset/ast_mw6t0liq14xd5ydhks1r3ssk`.

Production D1 JSON backup before the pointer change:
`.foilbury/backups/d1-2026-11-09T04-53-13-147Z.json` (96 tables, 34,007 rows,
SHA-256 `1a9088447493a57fc898cc2402bc0bba39186ec001c7c32c16fe7498c4e6c532`).

Rollback:

```sql
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0kqfyty1006xp1j8fcnk',
    banner_url = '/media/asset/ast_mw6t0liq14xd5ydhks1r3ssk'
WHERE slug = 'total-drama-island';
```

## Sourced collection art (2026-11-09)

This supersedes the Total Drama pointer rollback in the previous section for all 17 third-party collections. The rollback below is the current pre-change state.

The rejected collection banners and marks were programmatic card collages, gradients, dot grids and initials. They have been replaced for all 17 third-party collections with real series logos and key art from the public references already recorded for their cards. The four Foilbury-owned collections (Bubbles, Fighter, Protocol 11, Shared Characters) keep their committed original marks.

Full per-asset provenance (wiki, series page, file page, image URL, retrieval time, license, artist, credit, source and stored dimensions, hashes, access classification) is in `docs/COLLECTION_ART_PROVENANCE.md`.

### Production data change

- D1 JSON backup before the change: `.foilbury/backups/d1-2026-11-09T08-43-40-770Z.json` (96 tables, 34,007 rows, SHA-256 `71a5a60661a428937c10eb325028290bf80d5d7ef1765bbd0a65181f58b5c5dc`).
- The admin HTTP API is behind Cloudflare Access. The asset rows and R2 objects were provisioned through the existing Wrangler production configuration with `scripts/content/provision-collection-art.mjs`; the script is idempotent by SHA-256 and reuses existing brand assets.
- Asset rows: `kind=brand`, `access_classification=member`, `visibility=private`, `official=0`, `review_status=reviewed`, `origin=sourced`. No third-party asset was made public or labelled official/licensed.
- Collection pointers were updated with `scripts/content/apply-collection-art-pointers.mjs`, an idempotent art-only UPDATE guarded on the new values. `release_version`, `status` and `view_audience` were not changed.

### Pointers and asset hashes

| Collection | Old logo_url | New logo asset | Old banner_url | New banner asset | Release |
| --- | --- | --- | --- | --- | ---: |
| Alien Stage — Stage Lights | `/media/asset/ast_mw6szwvd4ch73jtcs3a7kqg8` | `ast_6978c318949aecbe3ef39186` | `/media/asset/ast_mw6szxw1a42xrzsr8tmrs26d` | `ast_a893485348864ec3a48baffe` | 5 |
| Chainsaw Man — Public Safety, Part 1 | `/media/asset/ast_mw6szyit8cvb29qk7kn558js` | `ast_62cc986c0f86f740025fb2fb` | `/media/asset/ast_mw6szz9qmjwn1n2b6zdksx9p` | `ast_0854d8f8b50074d2c09eaf62` | 5 |
| Danganronpa — Three Killing Games | `/media/asset/ast_mw6s2vr3f2ghdgkw08j2tys4` | `ast_d76930b65ee447ca88f64e48` | `/media/asset/ast_mw6s2wnp2ts155f2539d9mn1` | `ast_be1ceb505beb9688f0101664` | 6 |
| Death Note — The Kira Case | `/media/asset/ast_mw6t000mmb33cmt1swyfp054` | `ast_b1b217e42cb301f8d46b0f87` | `/media/asset/ast_mw6t0169mkrye0em6sbj2xnf` | `null` | 5 |
| Doki Doki Literature Club! — The Clubroom | `/media/asset/ast_mw6t01td3dgmfaemz5swqg30` | `ast_a20daa2315863afbd7f4d2fd` | `/media/asset/ast_mw6t02mdd64ft0amzj09m8wh` | `ast_6ba6bf48901c19e140e953d1` | 5 |
| Puella Magi Madoka Magica — Mitakihara | `/media/asset/ast_mw6t0askhf0aesmx2s4m5806` | `ast_d33e8f8ec9eea6b4c9e2d1d0` | `/media/asset/ast_mw6t0byv6d890m1mzbcdv4c0` | `ast_44415e6b748d361bb3b19397` | 5 |
| NANA — Two Nanas, One Tokyo | `/media/asset/ast_mw6t03c2bpf0mksm021q3k84` | `ast_bf03e53054b0fd35a6112395` | `/media/asset/ast_mw6t04co4c8kbmjg8cdhxp2m` | `ast_e3471c4b9c47e0b43cf2f1ae` | 5 |
| NBA — Opening Night | `/media/asset/ast_mw6t054hz3zee9xdvjy4v9y5` | `ast_aaa452963ac8e5cdc19d15bc` | `/media/asset/ast_mw6t069d0efqvjcywfw94z1d` | `null` | 5 |
| Neon Genesis Evangelion — Episodes 1–26 | `/media/asset/ast_mw6t06x687jtzxjh1kecf73e` | `ast_562fae7e22b252f9d919fda8` | `/media/asset/ast_mw6t07olf4eb947v4wyq077v` | `null` | 5 |
| Project Sekai — Unit Stage | `/media/asset/ast_mw6t08e72bxjf1xadzn6wr9m` | `ast_f285a314d49993dafd246672` | `/media/asset/ast_mw6t09nu2qvnk41y7nhcgsak` | `ast_4aef0884a4ac2ada50402b6f` | 5 |
| Rick and Morty — Portal | `/media/asset/ast_mw6t0csfhnrs1f06y1ztqwzg` | `ast_f5f4e62f977a362622ca3e99` | `/media/asset/ast_mw6t0dm51pjehvq2y08rhh81` | `null` | 5 |
| Scott Pilgrim — Six Volumes, One City | `/media/asset/ast_mw6t0ebs8zk9ymtp9g73xkr9` | `ast_6647dd70999086a8da7611d6` | `/media/asset/ast_mw6t0fced8ej0p2mqg575wqt` | `null` | 5 |
| South Park — Town Album | `/media/asset/ast_mw6t0g0ngy4n37ypjfn1edky` | `ast_48ae560851d5f4d912ca82b9` | `/media/asset/ast_mw6t0gttbfk9qx9eaja69evw` | `ast_1c67c15f2351f1bf4dee907c` | 5 |
| The Summer Hikaru Died — The Village and the Voice | `/media/asset/ast_mw6t0ja6s6ttth4ksk19tvxw` | `ast_c7279774ca85b21ef0716269` | `/media/asset/ast_mw6t0k26rd35f4vzvpanvyy4` | `ast_0f31b035de02bd07c8af9ec8` | 5 |
| The Simpsons — Springfield, U.S.A. | `/media/asset/ast_mw6t0hotdw50k5dbgbphdam4` | `ast_2f22ee5840dc5fb22dc0d369` | `/media/asset/ast_mw6t0ilv63djvj2e75shyqz0` | `null` | 5 |
| Total Drama Island — Camp Wawanakwa, 2007 | `/media/asset/ast_mvzdy3vn1p6c0gnmrxt95e48` | `ast_acba0db79ee23faac612f5d0` | `/media/asset/ast_mvzeos51g2kn57ppgrkagqz5` | `ast_806d710687db1b2b4a98ba1b` | 5 |
| Vocaloid — Voicebanks | `/media/asset/ast_mw6t0mik66gft8rrc9eyrp19` | `ast_b5f2ad518f2135ed216977bf` | `/media/asset/ast_mw6t0nbopkpn9aekbcrxrmg6` | `ast_f78dcf118656553aaa171f9c` | 6 |

Stored asset SHA-256 values:

| Collection | Banner SHA-256 | Mark SHA-256 |
| --- | --- | --- |
| Alien Stage — Stage Lights | `a893485348864ec3a48baffe415c050bec5aa2b374030350c6de66e0ba4d6b90` | `6978c318949aecbe3ef391869da252e58b55d1f66c057a543d9fdc3b3356af2c` |
| Chainsaw Man — Public Safety, Part 1 | `0854d8f8b50074d2c09eaf6284824d66c6ab26d59ff0b31ef6f83b29947ca67e` | `62cc986c0f86f740025fb2fbf52817445be85fefd9934e953a025f78634a3576` |
| Danganronpa — Three Killing Games | `be1ceb505beb9688f01016649f9559b1e7dafb94c3d1343012c905f50579aeed` | `d76930b65ee447ca88f64e48ae93d88218e6094f7bf0d7bffb91535645f745a1` |
| Death Note — The Kira Case | — | `b1b217e42cb301f8d46b0f87231773afa7778de204253156047f34780b960332` |
| Doki Doki Literature Club! — The Clubroom | `6ba6bf48901c19e140e953d1a34a20d8a4862060e797850783511b14d1b5a6e6` | `a20daa2315863afbd7f4d2fd76ad25e4fb366fb3d729007a07f791ac894e587e` |
| Puella Magi Madoka Magica — Mitakihara | `44415e6b748d361bb3b1939756e1f93a2853ec27802f23f8aadcfbb832fbc445` | `d33e8f8ec9eea6b4c9e2d1d094af64f81359c09b86bff2b706d74b6eb8085b19` |
| NANA — Two Nanas, One Tokyo | `e3471c4b9c47e0b43cf2f1ae02fa31e5d9cfe79c75863b7a40965b19bd71b1bd` | `bf03e53054b0fd35a61123959a2d1c97e9fd62ca6eb593692dcd3f00dcbde91e` |
| NBA — Opening Night | — | `aaa452963ac8e5cdc19d15bc35123bc629de13369e5744b830a852e88a16af8f` |
| Neon Genesis Evangelion — Episodes 1–26 | — | `562fae7e22b252f9d919fda85cc6a9825aa99cae4444059e94ba718d272b1183` |
| Project Sekai — Unit Stage | `4aef0884a4ac2ada50402b6f0eb7ca3e978e5ef2d4025aa9f15f7c3e9b9ea34b` | `f285a314d49993dafd2466722af70afb4cf7c72db0e2b75a089fc0336b5d64bd` |
| Rick and Morty — Portal | — | `f5f4e62f977a362622ca3e99d1091b43d6ea8f012fa1141eb8e465fedf4074ae` |
| Scott Pilgrim — Six Volumes, One City | — | `6647dd70999086a8da7611d667fae75fcb995535b1b9b0be19ac6918c423774e` |
| South Park — Town Album | `1c67c15f2351f1bf4dee907c7d959683fd573569bd3a62349f7253b6405fe13c` | `48ae560851d5f4d912ca82b9df18b706cae8e17edfeaf6c82861b59c0775c143` |
| The Summer Hikaru Died — The Village and the Voice | `0f31b035de02bd07c8af9ec845d14c6029e056f2bbe78a1e1f927fa127ee9915` | `c7279774ca85b21ef07162697d475f7a4eb0a91c87fa4cc72bb8b887de33a44c` |
| The Simpsons — Springfield, U.S.A. | — | `2f22ee5840dc5fb22dc0d36955702e25f3eaa0447a818d1e6117e38973f03a84` |
| Total Drama Island — Camp Wawanakwa, 2007 | `806d710687db1b2b4a98ba1b4610707198cd8c883649d59d9bf7ebae3a3bee95` | `acba0db79ee23faac612f5d04ebf7be4e1707c6e53f55ae0a2e5fcd3faaa7e8b` |
| Vocaloid — Voicebanks | `f78dcf118656553aaa171f9c05522fedb2e6aea793bdf9e58eb00d1e30e76896` | `b5f2ad518f2135ed216977bf6aeedf5691e81453245ff8cd111383f3ee1224d4` |

### Rollback

The following restores the exact pre-change pointers. It does not delete the new assets or alter release metadata.

```sql
-- alien-stage
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6szwvd4ch73jtcs3a7kqg8',
    logo_asset_id = 'ast_mw6szwvd4ch73jtcs3a7kqg8',
    banner_url = '/media/asset/ast_mw6szxw1a42xrzsr8tmrs26d',
    banner_asset_id = 'ast_mw6szxw1a42xrzsr8tmrs26d',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'alien-stage';

-- chainsaw-man-public-safety
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6szyit8cvb29qk7kn558js',
    logo_asset_id = 'ast_mw6szyit8cvb29qk7kn558js',
    banner_url = '/media/asset/ast_mw6szz9qmjwn1n2b6zdksx9p',
    banner_asset_id = 'ast_mw6szz9qmjwn1n2b6zdksx9p',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'chainsaw-man-public-safety';

-- danganronpa-three-games
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6s2vr3f2ghdgkw08j2tys4',
    logo_asset_id = 'ast_mw6s2vr3f2ghdgkw08j2tys4',
    banner_url = '/media/asset/ast_mw6s2wnp2ts155f2539d9mn1',
    banner_asset_id = 'ast_mw6s2wnp2ts155f2539d9mn1',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'danganronpa-three-games';

-- death-note
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t000mmb33cmt1swyfp054',
    logo_asset_id = 'ast_mw6t000mmb33cmt1swyfp054',
    banner_url = '/media/asset/ast_mw6t0169mkrye0em6sbj2xnf',
    banner_asset_id = 'ast_mw6t0169mkrye0em6sbj2xnf',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'death-note';

-- doki-doki-literature-club
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t01td3dgmfaemz5swqg30',
    logo_asset_id = 'ast_mw6t01td3dgmfaemz5swqg30',
    banner_url = '/media/asset/ast_mw6t02mdd64ft0amzj09m8wh',
    banner_asset_id = 'ast_mw6t02mdd64ft0amzj09m8wh',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'doki-doki-literature-club';

-- madoka-magica-mitakihara
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0askhf0aesmx2s4m5806',
    logo_asset_id = 'ast_mw6t0askhf0aesmx2s4m5806',
    banner_url = '/media/asset/ast_mw6t0byv6d890m1mzbcdv4c0',
    banner_asset_id = 'ast_mw6t0byv6d890m1mzbcdv4c0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'madoka-magica-mitakihara';

-- nana-two-nanas
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t03c2bpf0mksm021q3k84',
    logo_asset_id = 'ast_mw6t03c2bpf0mksm021q3k84',
    banner_url = '/media/asset/ast_mw6t04co4c8kbmjg8cdhxp2m',
    banner_asset_id = 'ast_mw6t04co4c8kbmjg8cdhxp2m',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'nana-two-nanas';

-- nba-opening-night
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t054hz3zee9xdvjy4v9y5',
    logo_asset_id = 'ast_mw6t054hz3zee9xdvjy4v9y5',
    banner_url = '/media/asset/ast_mw6t069d0efqvjcywfw94z1d',
    banner_asset_id = 'ast_mw6t069d0efqvjcywfw94z1d',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'nba-opening-night';

-- neon-genesis-evangelion
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t06x687jtzxjh1kecf73e',
    logo_asset_id = 'ast_mw6t06x687jtzxjh1kecf73e',
    banner_url = '/media/asset/ast_mw6t07olf4eb947v4wyq077v',
    banner_asset_id = 'ast_mw6t07olf4eb947v4wyq077v',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'neon-genesis-evangelion';

-- project-sekai
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t08e72bxjf1xadzn6wr9m',
    logo_asset_id = 'ast_mw6t08e72bxjf1xadzn6wr9m',
    banner_url = '/media/asset/ast_mw6t09nu2qvnk41y7nhcgsak',
    banner_asset_id = 'ast_mw6t09nu2qvnk41y7nhcgsak',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'project-sekai';

-- rick-and-morty
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0csfhnrs1f06y1ztqwzg',
    logo_asset_id = 'ast_mw6t0csfhnrs1f06y1ztqwzg',
    banner_url = '/media/asset/ast_mw6t0dm51pjehvq2y08rhh81',
    banner_asset_id = 'ast_mw6t0dm51pjehvq2y08rhh81',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'rick-and-morty';

-- scott-pilgrim
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0ebs8zk9ymtp9g73xkr9',
    logo_asset_id = 'ast_mw6t0ebs8zk9ymtp9g73xkr9',
    banner_url = '/media/asset/ast_mw6t0fced8ej0p2mqg575wqt',
    banner_asset_id = 'ast_mw6t0fced8ej0p2mqg575wqt',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'scott-pilgrim';

-- south-park
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0g0ngy4n37ypjfn1edky',
    logo_asset_id = 'ast_mw6t0g0ngy4n37ypjfn1edky',
    banner_url = '/media/asset/ast_mw6t0gttbfk9qx9eaja69evw',
    banner_asset_id = 'ast_mw6t0gttbfk9qx9eaja69evw',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'south-park';

-- summer-hikaru-died
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0ja6s6ttth4ksk19tvxw',
    logo_asset_id = 'ast_mw6t0ja6s6ttth4ksk19tvxw',
    banner_url = '/media/asset/ast_mw6t0k26rd35f4vzvpanvyy4',
    banner_asset_id = 'ast_mw6t0k26rd35f4vzvpanvyy4',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'summer-hikaru-died';

-- the-simpsons
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0hotdw50k5dbgbphdam4',
    logo_asset_id = 'ast_mw6t0hotdw50k5dbgbphdam4',
    banner_url = '/media/asset/ast_mw6t0ilv63djvj2e75shyqz0',
    banner_asset_id = 'ast_mw6t0ilv63djvj2e75shyqz0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'the-simpsons';

-- total-drama-island
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mvzdy3vn1p6c0gnmrxt95e48',
    logo_asset_id = 'ast_mw6t0kqfyty1006xp1j8fcnk',
    banner_url = '/media/asset/ast_mvzeos51g2kn57ppgrkagqz5',
    banner_asset_id = 'ast_mw6t0liq14xd5ydhks1r3ssk',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'total-drama-island';

-- vocaloid
UPDATE fb_collections
SET logo_url = '/media/asset/ast_mw6t0mik66gft8rrc9eyrp19',
    logo_asset_id = 'ast_mw6t0mik66gft8rrc9eyrp19',
    banner_url = '/media/asset/ast_mw6t0nbopkpn9aekbcrxrmg6',
    banner_asset_id = 'ast_mw6t0nbopkpn9aekbcrxrmg6',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE slug = 'vocaloid';

```
