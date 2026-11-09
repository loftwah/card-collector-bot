# Account identity: avatar and banner

## Two separate ideas

- **Account avatar** — who the person is. One of:
  - the illustrated Foilbury family (`avatar_kind = 'default'`);
  - a privately cached Discord avatar (`avatar_kind = 'discord'`);
  - a private uploaded photo (`avatar_kind = 'upload'`).
- **Collector portrait** — collection affinity. It is stored in the profile
  presentation (`mascot` or a collection mark) and never replaces the account
  avatar.

The header, profile hero, share page and Discord profile card all read the
account avatar. The collector portrait appears as a separate affinity chip.

## Defaults

The default is the Keeper, a paper-card creature. The illustrated family is:

| Key | Label |
| --- | --- |
| `keeper` | The Keeper |
| `archivist` | The Archivist |
| `prospector` | The Prospector |
| `completionist` | The Completionist |
| `curator` | The Curator |
| `night-owl` | The Night Owl |
| `trader` | The Trader |

There is no letter-monogram fallback anywhere. A missing or broken asset resolves
to `keeper`. The final artwork is raster PNG in
`public/avatars/default/`; regenerate it with:

```sh
set -a; source .env; set +a
node scripts/brand/generate-openai-avatars.mjs
```

The canonical model is OpenAI `gpt-image-2.6-sunburst`. One base mascot is
generated, then every role and expression is an image edit against that exact
base so the character, paper texture, lighting and palette stay coherent.
The script writes 256, 128, 64 and 32 pixel avatar PNGs; the mascot poses are
512 pixels. Review the actual output at 32, 64, 128 and 256 and in a circular
crop; a clean detector is not acceptance.

**Owner decision:** the flat vector avatar set and the procedural paper render
were rejected. Do not reintroduce SVG avatars, flat geometric portraits or
procedural stand-ins when the image models are available. OpenAI GPT Image is
the right tool for consistent character edits and layout; FAL.ai Flux Pro /
Seedream is the right tool for high-aesthetic hero, banner and scene art. Use
Cloudflare Workers AI only as an explicit fallback, not as the default.

## Persistence

`fb_users` stores:

- `avatar_kind` (`default`, `discord`, `upload`)
- `avatar_default_key`
- `avatar_asset_id` (a private `fb_member_media` row)
- `avatar_source_hash` (Discord source hash or upload hash)
- `avatar_updated_at`
- `banner_asset_id`, `banner_source_hash`, `banner_updated_at`

Every change writes an `account.avatar.*` or `account.banner.*` audit event.

## Private media

`fb_member_media` tracks private R2 objects and their renditions. Uploads are
validated by magic bytes and dimensions, cropped square in the browser, and
prepared at 64, 128 and 256 pixels. Banners use an 8:3 crop at 1600 × 600 and
800 × 300.

- `GET /media/member/:id?size=…` requires the owning session.
- A profile share snapshot references the media id; `GET /s/:token/media/avatar`
  and `/s/:token/media/banner` re-check the live link, membership and owner
  membership on every request.
- Missing private bytes redirect to the Keeper, never to initials.

## Discord

A Discord avatar is fetched once when selected and cached in R2 as a private
asset. The source hash is stored on the identity and the user. On later Discord
sign-in or interaction, a changed hash refreshes the cached copy. If the fetch
fails, the last good copy remains; with no good copy, the Keeper is used.

The `/foilbury profile` embed attaches the cached avatar (or the public default
PNG) as its thumbnail. No Discord CDN URL is used as the long-lived source of
truth.

## API

- `GET /api/v1/me/avatar`
- `POST /api/v1/me/avatar/default` `{ key }`
- `POST /api/v1/me/avatar/discord`
- `POST /api/v1/me/avatar/upload` `{ renditions: [{ size, data, mime }] }`
- `DELETE /api/v1/me/avatar`
- `POST /api/v1/me/banner/upload` `{ renditions: [{ size, data, mime }] }`
- `DELETE /api/v1/me/banner`
