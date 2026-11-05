import { composeCard } from '../../art/compose.mjs';
import { parseQueuedComposition, requireQueuedBackground } from './render-queued-front.mjs';

// The queued snapshot is authoritative for this attempt; never substitute a
// later catalogue read for the edition placement captured when it was queued.
export async function renderProvisionedFront({ payload, card, subjectPath, backgroundPath, outputPath }) {
  requireQueuedBackground(payload);
  return composeCard({
    subjectPath,
    backgroundPath,
    material: payload.material_key,
    effect: payload.effect_key ?? 'none',
    name: card.name,
    subtitle: card.subtitle ?? '',
    setName: card.sets[0]?.name ?? card.collections[0]?.name ?? 'Cabinet',
    serial: 'CABINET PROOF',
    className: card.class?.name ?? '',
    rarity: card.rarity?.name ?? '',
    composition: parseQueuedComposition(payload.composition_json),
    outputPath,
  });
}
