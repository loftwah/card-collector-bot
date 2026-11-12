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
