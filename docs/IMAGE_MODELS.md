# Image model inventory and routing

Credentials live in `.env` (never commit them). The project has working access
to more than one model family; choose by the job, not by habit. Verified against
the live APIs on 2026-11-09: OpenAI `gpt-image-2.6-sunburst`, FAL
`fal-ai/flux/schnell`, Cloudflare `flux-2-klein-4b`.

## OpenAI — `OPENAI_API_KEY`

Available image models include:

| Model | Best for |
| --- | --- |
| `gpt-image-2.6-sunburst` | Default. Strong prompt/layout adherence, consistent character edits, expression sets, character sheets, controlled compositions. |
| `gpt-image-2.5-sunburst` / `-flare` | Previous-generation variants; use when 2.6 is unavailable. |
| `gpt-image-2` | Strong general image generation and editing. |
| `gpt-image-1.5` | Faster, cheaper general work. |
| `gpt-image-1-mini` | Low-cost drafts and thumbnails, not final hero art. |
| `chatgpt-image-latest` | General fallback. |

Use `/v1/images/generations` for a new base image and `/v1/images/edits` for
consistent variants. For a character family: generate one base mascot, then
edit that exact image for every role and expression. Review at 32/64/128/256 and
in a circular crop.

## FAL.ai — `FAL_AI_API_KEY`

Use FAL when aesthetic breadth matters more than exact layout. Typical models:

| Model family | Best for |
| --- | --- |
| `fal-ai/flux-pro/v1.1-ultra` | High-aesthetic hero art, wide banners, painterly and photoreal illustration. |
| `fal-ai/flux/dev` / `fal-ai/flux/schnell` | Fast drafts, exploration, cheap iteration. |
| `fal-ai/bytedance/seedream/v4` | Character scenes and stylised editorial images. |
| `fal-ai/recraft/v3/text-to-image` | Flat illustration, icons, brand assets and precise vector-like shapes. |
| `fal-ai/ideogram/v3` | Text-bearing graphics; never use for card or avatar lettering that code should own. |

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
- No generated lettering, serials, logos or UI. Real type belongs in code.
- Generate one base character, then edit it for the family so the character,
  paper, lighting and palette stay coherent.
- Inspect the actual output. A clean detector is not acceptance.
- Keep prompts and the chosen model in the domain doc for reproducibility.
