import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeCard } from '../../art/compose.mjs';
import { renderQueuedFront } from '../../scripts/content/render-queued-front.mjs';

test('queued worker renders the saved edition composition and keeps legacy defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foilbury-queued-composition-'));
  const subjectPath = path.join(dir, 'subject.png');
  const backgroundPath = path.join(dir, 'background.png');
  const pixels = Buffer.alloc(60 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 60; x++) {
    const i = (y * 60 + x) * 3;
    pixels[i] = x < 30 ? 240 : 10; pixels[i + 1] = x < 30 ? 10 : 240; pixels[i + 2] = y < 50 ? 100 : 20;
  }
  fs.writeFileSync(subjectPath, await sharp(pixels, { raw: { width: 60, height: 100, channels: 3 } }).png().toBuffer());
  fs.writeFileSync(backgroundPath, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#283b34' } }).png().toBuffer());
  const composition = { mode: 'fill', zoom: 1.2, offsetX: 20, offsetY: -15 };
  const payload = { background_asset_id: 'bg', material_key: 'plain', effect_key: null, card_name: 'Fixture', composition_json: JSON.stringify(composition) };
  const common = { subjectPath, backgroundPath, markPath: '', meta: null };
  const queuePath = path.join(dir, 'queued.png');
  const expectedPath = path.join(dir, 'expected.png');
  const legacyPath = path.join(dir, 'legacy.png');
  const directLegacyPath = path.join(dir, 'direct-legacy.png');
  await renderQueuedFront({ ...common, payload, outputPath: queuePath });
  await composeCard({ subjectPath, backgroundPath, material: 'plain', effect: 'none', name: 'Fixture', subtitle: '', setName: 'Cabinet', serial: 'MEMBER EDITION', className: '', rarity: '', markPath: '', composition, outputPath: expectedPath });
  assert.deepEqual(fs.readFileSync(queuePath), fs.readFileSync(expectedPath));
  await renderQueuedFront({ ...common, payload: { ...payload, composition_json: null }, outputPath: legacyPath });
  await composeCard({ subjectPath, backgroundPath, material: 'plain', effect: 'none', name: 'Fixture', subtitle: '', setName: 'Cabinet', serial: 'MEMBER EDITION', className: '', rarity: '', markPath: '', outputPath: directLegacyPath });
  assert.deepEqual(fs.readFileSync(legacyPath), fs.readFileSync(directLegacyPath));
  assert.notDeepEqual(fs.readFileSync(queuePath), fs.readFileSync(legacyPath), 'fixture must expose the omitted composition');
  await assert.rejects(renderQueuedFront({ ...common, payload: { ...payload, composition_json: '{invalid' }, outputPath: path.join(dir, 'invalid.png') }), SyntaxError);
  for (const value of [[], 42, 'text', { mode: 'other' }, { zoom: 2 }, { offsetX: '5' }, { typo: 1 }]) {
    await assert.rejects(renderQueuedFront({ ...common, payload: { ...payload, composition_json: JSON.stringify(value) }, outputPath: path.join(dir, 'invalid.png') }), /Invalid queued artwork composition/);
  }
  console.log(`Synthetic compositor evidence: ${dir}`);
});
