# Foilbury brand systems

Status as of 2026-11-04: **Signal Fold selected and applied to the Foilbury
application under delegated authority**. The selection record is
`public/brand/kit/selection.json`; the comparison surface is `/brand-kit`.

| Scope | State |
| --- | --- |
| Foilbury application icon | Applied via Discord `PATCH /applications/@me`; hash `e8234929cc269ab7843ee384aaaa3991`. Previous value recorded for rollback. |
| Foilbury application description | Applied. Replaced the generic platform copy with the real free-play description. |
| Foilbury application cover image | Applied through the supported `cover_image` field: hash `9b20e60b4947e3fac36a62b728a67b4e`. This is the application cover image, not the bot profile banner. |
| Foilbury bot profile banner | Manual Developer Portal step. The old banner was not replaced and no claim is made that it was. |
| Loftwah guild icon | Not changed. The wider server identity is not Foilbury branding. |
| Loftwah server banner | Blocked: the guild has no `BANNER` entitlement (Boost tier 2). The 960×540 and 1920×1080 assets are retained. |
| Discord onboarding panel | Public-safe panel posted in `#card-collector-test`. Pinning was denied because the bot lacks `MANAGE_MESSAGES`. |
| Bastion / Aperture | Retained alternatives. Nothing was deleted; the selection can be reversed. |

**Decision basis.** Signal Fold keeps the folded-card geometry that belongs to a
collecting product, reads as a deliberate F at 32px, has the strongest
continuity with the existing card and website language, and needs no new palette
to stay coherent in light and dark presentation. Bastion's oxblood/plaster
system is more formal but reads as an E at tiny sizes; Aperture is the strongest
circular crop but introduces a whole new midnight/vermilion brand and reads as a
lens or camera mark rather than a card.

This is a selection and provenance record, not a second asset CMS.

## The three systems

| #   | System      | Idea                                                          | Pairing                                                                 | Strongest at                     |
| --- | ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| 01  | Signal Fold | Folded card planes, precision field                           | Carbon field + bone card planes + aqua/lime signal + folded-card banner | Current-identity continuity      |
| 02  | Bastion     | A cabinet built as architecture                               | Oxblood field + plaster masonry + brass seams + cabinet-wall banner     | 32px silhouette and formal weight |
| 03  | Aperture    | A circular card window / optical instrument                   | Midnight blueprint + frost/pale-steel/vermilion planes + lens banner    | Native circular Discord crop      |

The three are paired icon + banner systems, not palette recolours of one image.
Each has its own geometry, palette, banner composition and icon variant set.
`Index` remains one of the existing reviewed marks but is not one of the three
complete systems because it has no paired banner language.

## Selection board

`/brand-kit` shows, for every system:

- a 512×512 icon master in a real circular crop;
- exact 64px and 32px circular-crop proofs on dark and light fields;
- the 960×540 Discord server-banner asset with the top 48px quiet band marked;
- a full 1920×1080 master preview;
- an illustrative Discord profile context, explicitly labelled as a mock and
  not a live client capture;
- rationale, strengths, watch-outs, palette, contrast pairs and provenance;
- downloadable icon, banner, SVG and manifest links.

The selection is stated in the hero status panel, in the chosen system column
and in the application gate. The page reads `selection.json`; the generator can
be re-run without erasing the decision, and the two alternatives remain live.

## System 01 — Signal Fold

**Rationale.** The reviewed Signal Fold geometry is kept, completed as a full
system. The icon is a tight circular-crop cut of the folded-card mark. The
banner is a measured field of card edges with a single notch, held below the
quiet top band. It is not a stretched avatar and contains no embedded type.

**Palette.**

| Token           | Hex       | Role                         |
| --------------- | --------- | ---------------------------- |
| Carbon          | `#07110f` | field and banner ground      |
| Bone            | `#eff5f1` | card planes and light type   |
| Electric aqua   | `#2ce3d3` | primary signal               |
| Signal lime     | `#c9f25f` | one high-energy edge         |
| Deep current    | `#044e4a` | quiet structural plane       |

Contrast: bone on carbon 17.34:1; electric aqua on carbon 11.89:1; signal lime
on carbon 14.92:1.

**Small-size behaviour.** The mark reduces to a blocky F silhouette. The lime
edge is the only colour detail required at 32px.

**Strengths.** Closest to the current identity; strongest dark-field contrast;
coherent icon and banner geometry.

**Watch-outs.** Closest to the incumbent, so it may not read as a decisive
change; aqua and lime need discipline outside the mark; the field grid is
intentionally absent at thumbnail size.

## System 02 — Bastion

**Rationale.** Bastion treats the identity as furniture: plaster mass, brass
seams and an oxblood field. The reviewed block geometry is kept, but the banner
is a monumental cabinet wall, not an enlarged logo. It is the most formal
direction and the clearest break from the current aqua field.

**Palette.**

| Token     | Hex       | Role                         |
| --------- | --------- | ---------------------------- |
| Oxblood   | `#2a1214` | field and banner ground      |
| Plaster   | `#efe2ca` | structural bars and lite type |
| Brass     | `#c99a4b` | seams and one plinth line    |
| Brick     | `#8f3a2f` | single inset accent          |
| Stone     | `#a08b76` | quiet secondary detail       |

Contrast: plaster on oxblood 13.72:1; brass on oxblood 6.87:1; oxblood on plaster
13.72:1.

**Small-size behaviour.** Three heavy horizontal bars and a solid vertical stem
remain unambiguous in a circular crop. No fine detail is required.

**Strengths.** Strongest 32px silhouette; warm archival palette distinct from
the current working identity; robust under compression.

**Watch-outs.** Oxblood is heavy on a full member surface; use the light icon
variant for balance. Brass must stay a seam, never a gloss. The banner carries
more weight than the other two and must be tested behind the server title.

## System 03 — Aperture

**Rationale.** Aperture is the most collectible direction: a circular card
window with three foil planes, moved into a midnight blueprint palette with one
vermilion signal. It is the only system whose geometry is already native to
Discord's circular crop. The banner is a large cropped lens with annular blades,
not a pie-chart enlargement of the avatar.

**Palette.**

| Token       | Hex       | Role                              |
| ----------- | --------- | --------------------------------- |
| Midnight    | `#0c1626` | field and banner ground           |
| Frost       | `#e7edf3` | upper foil plane and lite type    |
| Blueprint   | `#7ea8c4` | ring and secondary plane          |
| Vermilion   | `#e4573f` | one warm signal plane             |
| Pale steel  | `#9bc3d9` | third plane and quiet detail      |

Contrast: frost on midnight 15.37:1; vermilion on midnight 4.95:1; midnight on
frost 15.37:1.

**Small-size behaviour.** The outer ring, three wedge planes and open centre
survive at 32px. The central hole keeps the silhouette from becoming a solid
dot.

**Strengths.** Native to the circular avatar crop; distinct from Signal Fold's
F and Bastion's architecture; one warm accent cuts the night field without a
glow.

**Watch-outs.** Most detailed geometry; inspect the exported 32px proof rather
than only the vector. Vermilion is an accent, never a generic warning or success
colour. The large banner lens needs clear space around its centre.

## Type and licensing

- Display: **Manrope** 780, tight tracking, uppercase only where it carries a
  decision. Self-hosted at `public/fonts/manrope-latin.woff2`.
- Interface: **Geist Sans**; labels, dimensions and provenance: **Geist Mono**.
- Manrope and Geist are self-hosted under the **SIL Open Font License 1.1**
  (`art/fonts/OFL-Manrope.txt`). No new font licence was introduced.
- No stock imagery, franchise emblem, Discord logo or third-party mark is used.

## Files and manifest

Base path: `public/brand/kit/systems/<slug>/`.

| File pattern                    | Pixels     | Format | Use                                  |
| ------------------------------- | ---------- | ------ | ------------------------------------ |
| `mark.svg`                      | 256×256    | SVG    | Vector mark master                   |
| `icon.svg`                      | 512×512    | SVG    | Vector app-icon master               |
| `icon-light.svg`                | 512×512    | SVG    | Positive-on-light vector             |
| `icon-transparent.svg`          | 512×512    | SVG    | Transparent vector                   |
| `icon-mono-dark.svg`            | 512×512    | SVG    | Dark monochrome vector               |
| `icon-mono-light.svg`           | 512×512    | SVG    | Light monochrome vector              |
| `icon-1024.png`                 | 1024×1024  | PNG    | Opaque application-avatar master     |
| `icon-512.png`                  | 512×512    | PNG    | Circular-crop proof                  |
| `icon-128.png`                  | 128×128    | PNG    | Proof                                |
| `icon-64.png`                   | 64×64      | PNG    | Exact 64px proof                     |
| `icon-32.png`                   | 32×32      | PNG    | Exact 32px proof                     |
| `icon-light-1024.png`           | 1024×1024  | PNG    | Positive-on-light variant            |
| `icon-transparent-1024.png`     | 1024×1024  | PNG    | Transparent variant                  |
| `icon-mono-dark-1024.png`       | 1024×1024  | PNG    | Dark monochrome variant              |
| `icon-mono-light-1024.png`      | 1024×1024  | PNG    | Light monochrome variant             |
| `banner.svg`                    | 1920×1080  | SVG    | Vector banner master                 |
| `banner-1920x1080.png`          | 1920×1080  | PNG    | High-resolution banner source        |
| `banner-960x540.png`            | 960×540    | PNG    | Discord server-banner size           |

Each system has 18 recorded assets. `public/brand/kit/manifest.json` carries the
`systems` array with every asset's path, dimensions, format, byte size, use and
scope, plus the generation timestamp and owner-selection status. The page reads
that manifest directly; it is not a hand-maintained parallel list.

Regenerate the systems with:

```sh
node scripts/brand/generate-brand-systems.mjs
```

The existing `pnpm brand:generate` base-kit generator preserves the `systems`
and `system_status` entries when it rewrites the manifest.

## Discord fit and scope

The three surfaces are deliberately separated. A Foilbury bot avatar is not a
guild icon, and a guild icon is not a server banner.

| Surface                  | Candidate asset                        | Who can change it                                                                  | Current status and constraint                                                                                                                  |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot / application avatar | `icon-1024.png`                        | Application owner or team through the Developer Portal, or an authorised application update | Application-level, shown in every installation. **Not changed.**                                                                               |
| Guild / server icon      | `icon-1024.png` (optional)             | Server owner or a member with Manage Server                                         | Server-wide; requires separate explicit owner approval. **Not changed.**                                                                        |
| Server banner            | `banner-960x540.png` / `banner-1920…`  | Server owner or a member with Manage Server                                         | Entitlement-gated: Discord documents server banners at Boosting Level 2, with Partner servers also eligible. **Entitlement not checked. Not uploaded.** |
| Server profile banner    | Not this asset                         | Server owner or a member with Manage Server                                         | Discord's current Server Profile settings use a colour tile for the profile banner, not the 960×540 server-banner image. **Not changed.**        |

**No fake application.** This pass made no Discord request, checked no guild
boost tier and changed no application or guild setting. A banner can be applied
only if the server actually has the feature; otherwise the static master remains
a prepared asset.

### Discord requirements checked 2026-11-04

- Server banner: at least **960×540**, **16:9**; a **1920×1080** source is
  accepted and resized by Discord. Keep the **top 48px** simple and avoid
  embedded logo or text. Static PNG is provided; no animated banner was made.
- Server banner availability: Boosting Level 2 or Partner. Animated banners are
  Level 3, but this package intentionally ships a static fallback.
- Application icon: Discord's image CDN accepts PNG/JPEG/WebP for application
  icons and serves power-of-two sizes from 16 to 4096. The exported master is a
  1024×1024 PNG; the portal's current upload limits will be re-checked at
  application time. The exported masters are 5.5–39 KB, far below any plausible
  upload ceiling.
- Server Profile: the banner in the current Server Profile settings is a colour
  tile. Do not describe the 960×540 server banner as a Server Profile upload.

Sources:

- <https://support.discord.com/hc/en-us/articles/360028716472-Server-Banners>
- <https://support.discord.com/hc/en-us/articles/30715364399511-Server-Profile>
- <https://docs.discord.com/developers/reference#image-formatting>

## Provenance

- Original vector geometry from the reviewed Foilbury marks. No third-party,
  franchise or generated character art.
- Deterministic SVG composition and local Chromium rasterisation in
  `scripts/brand/generate-brand-systems.mjs`. No model provider, paid image
  generation or random seed.
- The exact 32px and 64px proofs are rendered at those sizes, not downsampled
  screenshots.
- The banner top 48px is kept clear by construction in every master.
- Manrope and Geist are self-hosted under the SIL Open Font License 1.1.
- `Index` is retained in the existing kit as a reference mark; it is not part of
  the three-system selection board.

## Owner gate and rollback

1. Owner selects one system. Nothing on `/brand-kit` records or applies that
   choice.
2. Owner requests up to two refinements of the chosen direction. Do not run a
   new round of unrelated options.
3. Final exports are reviewed in the real Discord desktop and mobile clients,
   including the circular avatar crop, small-type contrast and any available
   banner crop. Source-only signoff is not acceptance.
4. Owner gives explicit approval before any application avatar, guild icon or
   server-wide banner is changed.
5. Apply through the authorised Developer Portal or Server Settings path. Keep
   the prior application icon, guild icon and banner files, record the exact
   source revision and asset hashes, and keep the previous assets available for
   rollback.

Applying the application avatar does not authorise a guild icon or server banner
change. Those remain separate owner decisions.

## What remains owner-selected

- Which of Signal Fold, Bastion and Aperture becomes the Foilbury identity.
- The two refinement passes after selection.
- Whether any guild-wide Loftwah asset is changed at all.
- Whether the server currently has banner entitlement.
- The live application and the real Discord desktop/mobile acceptance record.
- Final integration into the shared design tokens and the Discord visual work.

Paid generation remains unrun. Production application remains unapproved and
unperformed.
