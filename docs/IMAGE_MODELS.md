# Image model inventory and routing

Credentials live in `.env` (never commit them). The project has working access
to more than one model family; choose by the job, not by habit. Verified against
the live APIs on 2026-11-10: OpenAI `gpt-image-2.6-sunburst` (models endpoint
200), FAL `fal-ai/flux-pro/v1.1-ultra`, Cloudflare `flux-2-klein-4b`.

## Current card-art route

**Whole-card AI is the primary card production method.** The Art Lab prepares a
reference sheet from:

- the real subject art,
- the supplied collection mark,
- the current live card,
- the exact copy: name, role, collection, rarity, finish, print code and
  provenance.

GPT Image 2.6 Sunburst receives that sheet through `/v1/images/edits`; FAL FLUX
Pro 1.1 Ultra / Seedream v4 receive it through their image reference field. The
model generates the finished 5:7 card. `art/card-render.mjs` prepares the
reference sheet and remains a comparison/publishing tool; it is not the default
final card composition. See `docs/ART_LAB.md`.

## OpenAI — `OPENAI_API_KEY`

| Model                               | Best for                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `gpt-image-2.6-sunburst`            | Default. Whole-card layout, exact copy, consistent character edits, expression sets, character sheets, controlled compositions. |
| `gpt-image-2.5-sunburst` / `-flare` | Previous-generation variants; use when 2.6 is unavailable.                                                                      |
| `gpt-image-2`                       | Strong general image generation and editing.                                                                                    |
| `gpt-image-1.5`                     | Faster, cheaper general work.                                                                                                   |
| `gpt-image-1-mini`                  | Low-cost drafts and thumbnails, not final hero art.                                                                             |
| `chatgpt-image-latest`              | General fallback.                                                                                                               |

Use `/v1/images/generations` for a new base image and `/v1/images/edits` for a
consistent whole-card generation from the real-source reference sheet. The
runner parses `.env` explicitly and prefers it over a stale shell environment
variable; a developer shell should not silently override the project key.

## FAL.ai — `FAL_AI_API_KEY`

Use FAL when aesthetic breadth matters more than exact layout, or as a
top-tier alternative for whole-card art.

| Model family                                 | Best for                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `fal-ai/bytedance/seedream/v4/edit`          | Reference-guided whole-card art from the real-source reference sheet.         |
| `fal-ai/flux-pro/v1.1-ultra`                 | High-aesthetic scene/key art, hero art, banners and painterly scenes.         |
| `fal-ai/bytedance/seedream/v4/text-to-image` | Character scenes, stylised editorial images and texture plates.               |
| `fal-ai/flux/dev` / `fal-ai/flux/schnell`    | Fast drafts, exploration, cheap iteration.                                    |
| `fal-ai/recraft/v3/text-to-image`            | Flat illustration, icons, brand assets and precise vector-like shapes.        |
| `fal-ai/ideogram/v3`                         | Text-bearing graphics where exact lettering is the point. Inspect the result. |

FAL endpoints are `https://fal.run/fal-ai/...` for synchronous calls or
`https://queue.fal.run/fal-ai/...` for queued work. Always bound the number of
paid generations and inspect the result.

## Cloudflare Workers AI — `CF_API_TOKEN` / `CF_ACCOUNT_ID`

Models: `@cf/black-forest-labs/flux-2-klein-4b`,
`@cf/leonardo/lucid-origin`, `@cf/leonardo/phoenix-1.0`.

Use as an explicit fallback when OpenAI/FAL are unavailable. The endpoint is
`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}` and
Flux expects multipart form data with a `prompt` field.

## Hard rules

- Do not ship SVG avatars, flat vector portraits or procedural "designed in
  code" character art. The owner rejected that direction.
- Whole-card AI is the current card direction. Supply the exact copy and the real
  source reference. Do not invent official logos, serials, watermarks, Japanese
  text or UI chrome. Inspect the actual card at 750, 400, 214 and 128 px. A card
  with gibberish or invented text is a failed card; regenerate or fix the prompt.
- Do not silently degrade to a text-only card or a different provider when the
  chosen model cannot accept a reference. Record the failure and the spend.
- Generate one base character, then edit it for the family so the character,
  paper, lighting and palette stay coherent.
- Inspect the actual output. A clean detector is not acceptance.
- Keep prompts and the chosen model in the domain doc for reproducibility.
