# Artwork provenance and the AI-artwork preference

Status: implemented 2026/11/04. Schema `0027_ai_art_provenance_and_scope.sql`.

Foilbury tracks **what an artwork is**, not just who supplied the file. The
typed `fb_assets.origin` field is the authoritative answer for every asset:

| Origin | Meaning | Example |
| --- | --- | --- |
| `sourced` | A publicly published reference image with a recorded source, rights note and review state. The card design and finishes remain Foilbury originals. | The 140 franchise subject references |
| `foilbury_original` | Authored or owner-supplied Foilbury artwork with no external generation record. | Brand marks, owner-supplied original-IP characters |
| `ai_assisted` | A real generated/edited image made with a reviewed provider and recorded generation metadata. Not official artwork. | The eight fal.ai print artworks |
| `ai_generated` | A generated image with no human-authored source layer. Currently unused; reserved for a future reviewed route. | — |
| `derived` | A deterministic render composed from source layers and a recipe. The render is not an independently generated original. | All 6,655 published card renders |
| `unknown` | No structured provenance yet. This is an honest gap, never an inference of AI or human authorship. | Some owner-supplied original-IP backgrounds/subjects |

`fb_assets.generation_json` holds the structured generation record when the
origin is AI-assisted: provider, endpoint, request id, prompt/reference hashes,
cost, generation time, reviewer and review note. It is JSON-queryable. The
migration repaired the earlier double-encoded print records.

## Bot preference

`fb_bots.ai_art_enabled` is a per-Bot preference. **New Bots default to off.**

- Off: AI-assisted editions are excluded from future draws, album rosters,
  card inspection, shares and Discord surfaces. Sourced, original and
  deterministic assets are unaffected.
- On: AI-assisted editions remain available and every card detail shows the
  `AI-assisted` origin label.
- Changing the preference never deletes owned copies, serials, ledger rows or
  earned achievements. Historical inventory remains accessible; the label is
  the disclosure.

The admin toggle is on the Overview screen (`Admin → Overview → Artwork
provenance`) and the API is:

```http
PATCH /api/v1/admin/bot
content-type: application/json

{ "aiArtEnabled": true }
```

The route requires a signed-in Bot Owner/Admin with content capability; the
change is audited as `bot.ai_art.updated`.

## What is enforced

- `getPoolPreview` and `executeDraw` exclude AI variants when the Bot preference
  is off, and include the preference in the distribution fingerprint.
- Album rosters and card hydration omit AI-only editions; a subject with a
  non-AI edition remains visible.
- Discord card detail and the web card detail show the origin; the tour's
  inspection stage states whether the album is sourced, AI-assisted or mixed.
- The persistent demonstration uses the sourced Danganronpa references, not the
  AI-assisted print set.

## Audit

```sh
pnpm art:audit          # human summary
pnpm art:audit -- --json
```

The audit is read-only. It reports assets by origin, unknown counts and any
AI-assisted record whose generation metadata is missing or malformed. A
non-zero `ai_assets_with_incomplete_generation` is a release concern for the
print workflow, not a reason to guess an origin.

## Current production baseline (2026/11/04)

- 8 `ai_assisted` subject assets (Tux/Gabe/Drop Bear print set) with provider,
  endpoint, request id, cost and review recorded.
- 140 sourced subject references and 140 sourced backgrounds (franchise
  albums).
- 6,655 deterministic render assets.
- 134 Foilbury brand assets.
- 310 `unknown` assets: 159 subject and 151 background files, mostly
  owner-supplied original-IP showcase art. They are not labelled AI. They are
  queued for explicit owner provenance review under #27.

## Rules for new content

1. Every new asset must declare an origin before it can be used in a published
   edition.
2. An AI-assisted asset must record provider, endpoint, request id, prompt and
   reference hashes, cost, reviewer and review note. Missing metadata blocks
   publication rather than silently becoming `unknown`.
3. A sourced reference must record its source, rights note and review state.
4. Never describe a sourced reference as AI-generated, or an AI-assisted image
   as official or licensed artwork.
5. Do not infer `origin` from a filename, a visual guess or the operator's
   broader catalogue visibility.
