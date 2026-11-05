import { composeCard } from '../../art/compose.mjs';

// Keep queued placement together with the compositor call. A missing legacy
// value retains the compositor's default; malformed stored JSON fails the job.
export async function renderQueuedFront({ payload, meta, subjectPath, backgroundPath, markPath, outputPath }) {
  const composition = payload.composition_json ? JSON.parse(payload.composition_json) : null;
  if (composition !== null) {
    if (typeof composition !== 'object' || Array.isArray(composition) ||
        Object.keys(composition).some(key => !['mode', 'zoom', 'offsetX', 'offsetY'].includes(key)) ||
        (composition.mode !== undefined && !['contain', 'fill', 'medallion'].includes(composition.mode)) ||
        [['zoom', 0.6, 1.6], ['offsetX', -20, 20], ['offsetY', -20, 20]].some(([key, min, max]) =>
          composition[key] !== undefined && (typeof composition[key] !== 'number' || !Number.isFinite(composition[key]) || composition[key] < min || composition[key] > max))) {
      throw new Error('Invalid queued artwork composition');
    }
  }
  return composeCard({
    subjectPath,
    backgroundPath: payload.background_asset_id ? backgroundPath : null,
    material: payload.material_key,
    effect: payload.effect_key ?? 'none',
    name: payload.card_name,
    subtitle: meta?.subtitle ?? '',
    setName: meta?.collections?.[0]?.name ?? 'Cabinet',
    serial: meta?.collections?.[0]?.view_audience === 'public' ? 'PUBLIC SHOWCASE' : 'MEMBER EDITION',
    className: meta?.class?.name ?? '',
    rarity: meta?.rarity?.name ?? '',
    composition,
    markPath,
    outputPath,
  });
}
