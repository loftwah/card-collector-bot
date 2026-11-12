# Foilbury artwork prompts

Owner direction, 12 November 2026. Use Codex ImageGen to generate complete
card fronts and backs from actual references. Studio is where we compare
candidate images, record the pick and prepare a release. Existing composed
cards stay available for comparison and historical prints.

## Start with one set

Make one strong anchor card first. Its visual decisions become the set
reference: border and materials, type hierarchy, art-to-copy balance,
collection mark placement, and the tone of the scene. Across the set, give
each subject a scene drawn from their world. Keep the scene subordinate to
their face, costume and silhouette.

The Madoka Magica anchor is Homura Akemi Plain: an indigo rainy city seen
through a window, thin lilac rails and engraved corners, a quiet aubergine
information panel and readable cream serif type. The actual character and
collection mark are distinct inputs. Keep this direction inside the member
album. Other albums should choose their own atmosphere and visual anchor.

### Front prompt

> Generate one complete face-on 5:7 collectible card, edge to edge. Reference 1
> is the actual subject: preserve their recognisable likeness, costume and
> age. Reference 2 is the actual collection mark: reproduce it faithfully once
> in its real proportions and colours. Reference 3 is the selected set card:
> match its frame, material, typography and information hierarchy without
> copying its subject, scene or copy. Place this subject in [specific scene],
> with [the collection's palette and medium]. Keep the face unobstructed. Set
> only [exact name, role, collection, rarity, finish, verified print code if
> present and provenance]. Make name, rarity and finish clear at 214 px.
> No extra letters, fake serials, false official claims, outside margin or UI.

### Finish or alternate-print prompt

> Edit the selected front. Preserve likeness, exact text and collection mark.
> Change [finish label] and [material direction]. Hold the composition still for
> a finish variant. For a distinct print, change [specific setting, framing or
> wardrobe supported by the brief] and use its real edition title.

Plain is uncoated paper; Silver is cool brushed metal; Gold is warm foil;
Holographic is restrained diffraction at the rails. They should be recognisable
at 128 px. An edition such as Wedding, Fairy or Neon has its own visual idea;
a recolour alone does not make a new print. Use separate whole images and keep
the face and type clear across the family.

### Back prompt

> Generate the reverse of Reference 1, matching its frame geometry, paper,
> finish and typography. Reference 2 is the actual collection mark. Use a
> motif from the front and a short, spoiler-safe character record. Set only
> [exact name, role, collection, short description, rarity, finish, verified
> print code if present, exact known source/creator credit and provenance]. Avoid
> long lore, dense ornament, extra
> lettering, fake serials and marks invented by the model.

## Icons, banners and covers

- **Icon:** supply the current brand or collection mark. Ask for a single
  strong silhouette and quiet background, with room for a circular crop.
  Check recognition at 32, 64 and 128 px. Keep the clean brand master.
- **Banner:** supply the selected mark and visual anchor. Generate a scene
  specific to that collection or project, with an intentional quiet area for
  title and mobile crop. Review actual desktop and phone placements.
- **Cover and share art:** use the same visual world and exact copy with the
  intended crop and audience. Keep each original master and purpose-specific
  export. No franchise art on public Foilbury brand surfaces.

## Work in batches and verify the live card

### Start a new member collection

In Studio, create the collection and roster as member drafts. Upload the
collection mark and banner, then add one Plain artwork edition per draft card.
Studio creates the edition and finish as published targets. The draft
collection and cards stay out of member browsing while you prepare the faces.
In an ignored directory such as
`.foilbury/content/<collection-slug>/`, save the art brief as `art.json`.
Paths are relative to that file. The IDs are optional for planning and come
from the existing Studio collection, card and target variant before staging.

```json
{
  "collection": {
    "name": "Lantern Detectives",
    "mark": "mark.png",
    "direction": "Warm newsprint, engraved brass rails, bold cream type"
  },
  "cards": [
    {
      "key": "signal-keeper-plain",
      "name": "Signal Keeper",
      "role": "Night shift detective",
      "rarity": "Rare",
      "description": "Tracks broken lanterns after dark.",
      "credit": "Character art by the collection creator.",
      "scene": "A foggy signal box with a single warm window",
      "motif": "An engraved green lantern",
      "source": "signal-keeper-source.png",
      "front": "signal-keeper-front.png",
      "back": "signal-keeper-back.png"
    }
  ]
}
```

1. Run `pnpm art:collection plan <path-to-art.json>`. The result lists exact
   copy, prompts, ordered reference paths and output filenames. Generate the
   anchor first, then add its selected front as `collection.anchor` and rerun
   the plan for the rest of the roster. Run independent fronts in parallel
   and use each selected front as the matching back's first reference.
2. Run `pnpm art:collection proof <path-to-art.json>`. Both faces must be
   single PNG, WebP or JPEG images at an exact 5:7 ratio and at least 750 px
   wide. Inspect the proofs at 400, 214 and 128 px for copy, likeness, logo,
   finish and cropping. The command records file hashes so the operator can
   identify the exact selection.
3. Add `collection.id` and each card's `cardId` and `variantId`, then run
   `pnpm art:collection stage <path-to-art.json>`. It uses the existing Studio
   agent credentials and defaults to localhost. It attaches both faces as one
   member-only Art Lab candidate per row and prints the brief and candidate IDs.
   The import runs outside the paid generation queue. Repeating the command
   for the same selection resumes the existing job or reuses the saved candidate.
   For production, take the normal D1 backup and use the existing scoped
   production-agent setup. Keep the manifest, exact prompts, proofs, staging
   receipts and masters with the collection's private source files.
4. In **Studio → Art Lab**, review and publish each pair to its target.
   Publish the cards and collection, then configure the Bot's collection and pool when it
   is ready to play. Check a member's odds, an actual front/back flip and
   signed-out media denial. Preserve issued versions when refreshing a live
   collection. Follow the existing release and rollback workflow for a capsule.

Build the queue from the live catalogue, grouped by collection, subject and
published print/finish. Catalogue and brand assets have separate inventory.
Generate independent subjects in parallel after the anchor is selected.
Generate related finishes and backs from the selected base image. Track
**generated → reviewed → selected → published → verified** per asset. One
release owner handles publication and live verification.

Review the actual images at 400, 214 and 128 px. Compare the face and mark
against the references, transcribe the printed text, and reject drift,
garbling, unwanted marks, weak crops or ambiguous finishes. Preserve the
master, exact prompts, reference IDs and hashes, dimensions, origin, audience,
`official:false` and selection. Record native Codex ImageGen and leave model,
seed or per-image cost unknown if the tool does not report them.

Keep Studio candidates private. Preserve issued prints, historical media and
serials. For issued or draw-eligible variants, release as a separate edition or
use a versioned replacement that preserves the previous media for existing
receipts and handles concurrent draws. A Studio rollback snapshot alone does
not make an in-place pointer swap safe.
Verify the saved front and back in the signed-in inspector and the authorised
Discord test server. A generated or staged image does not replace the live
card. Keep [#122](https://github.com/loftwah/card-collector-bot/issues/122) open
until the affected card surfaces are delivered and
[#39](https://github.com/loftwah/card-collector-bot/issues/39) open for the wider
art catalogue, icons and banners.
