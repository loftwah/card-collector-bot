# Collection content manifest

A manifest is a portable input package. It is validated, previewed for conflicts
and imported through the same authorised domain operations as the Admin UI.
Live edits are never overwritten by deployment seeding.

```json
{
  "schema": 1,
  "source": "launch-2026-11",
  "source_repo": "loftwah/card-collector-bot",
  "source_commit": "content-v1",
  "collection": {
    "slug": "nba-opening-night",
    "name": "NBA — Opening Night",
    "description": "A short, dated starting five from one era.",
    "source_work": "NBA",
    "source_context": "Which seasons and teams are in scope.",
    "content_advisory": "Sporting facts are dated to the stated season.",
    "view_audience": "members",
    "accent": "court-red",
    "visual_direction": "Editorial court programme: chalk lines, ticket stubs, team colour blocks.",
    "release_version": 1,
    "categories": [
      { "slug": "nba-guards", "name": "Guards", "description": "Primary ball-handlers in this starter set." }
    ]
  },
  "cards": [
    {
      "logical_id": "nba:example-player",
      "slug": "example-player",
      "name": "Example Player",
      "subtitle": "Guard · Example City",
      "description": "One-line card description.",
      "bio": "Spoiler-safe introduction. Two or three sentences, original wording.",
      "bio_full": "Fuller editorial profile, including the reviewed season boundary.",
      "spoiler_level": 0,
      "attributes": [
        { "key": "team", "label": "Team", "value": "Example City", "unit": null, "source": "2025/26 roster" },
        { "key": "position", "label": "Position", "value": "Guard", "unit": null, "source": "2025/26 roster" }
      ],
      "source_refs": ["https://example.com/reviewed-source"],
      "review_status": "reviewed",
      "tags": ["nba", "guards"],
      "category_slug": "nba-guards",
      "rarity_key": "rare",
      "art": {
        "initials": "EP",
        "motif": "court-lines",
        "palette": ["#17233f", "#e4572e", "#f4e3c1"]
      },
      "credit": "Original Foilbury interpretation; not official artwork."
    }
  ],
  "achievements": [
    {
      "key": "nba-opening-five",
      "name": "Opening five",
      "description": "Collect five subjects from this starter album.",
      "criteria": { "type": "collection_unique", "collection_id": "@collection", "target": 5 },
      "reward": { "foil": 320 },
      "art_key": "medal-court",
      "category": "collection"
    }
  ]
}
```

## Rules

- `bio` is safe to show before any spoiler opt-in. `bio_full` may contain
  spoilers only when `spoiler_level` is greater than zero.
- `attributes` are typed per collection. Do not reuse a universal stat block.
- `review_status` is `reviewed` only when the facts have been checked against the
  listed sources. Use `draft` when uncertain.
- `art` is a deterministic brief for the original Foilbury placeholder art. It
  must not claim to be official artwork, a licensed logo or a character likeness.
- `criteria.type` is one of `unique_cards`, `finish_first`, `finish_set`,
  `collection_complete`, `collection_unique`, `explore_collections`,
  `gift_received`.
- `criteria.collection_id` may be `"@collection"`; the importer resolves it to the
  stable collection ID.
- `source_refs` are reference URLs, not instructions and not embedded media.
