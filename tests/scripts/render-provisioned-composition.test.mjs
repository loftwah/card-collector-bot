import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeCard } from '../../art/compose.mjs';
import { renderProvisionedFront } from '../../scripts/content/render-provisioned-front.mjs';

test('provisioned front applies queued placement and preserves the legacy default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foilbury-provision-placement-'));
  const subjectPath = path.join(dir, 'subject.png'), backgroundPath = path.join(dir, 'background.png');
  const pixels = Buffer.alloc(60 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 60; x++) {
    const i = (y * 60 + x) * 3; pixels[i] = x < 30 ? 240 : 10; pixels[i + 1] = x < 30 ? 10 : 240; pixels[i + 2] = y < 50 ? 100 : 20;
  }
  fs.writeFileSync(subjectPath, await sharp(pixels, { raw: { width: 60, height: 100, channels: 3 } }).png().toBuffer());
  fs.writeFileSync(backgroundPath, await sharp({ create: { width: 64, height: 64, channels: 3, background: '#283b34' } }).png().toBuffer());
  const composition = { mode: 'fill', zoom: 1.2, offsetX: 20, offsetY: -15 };
  const payload = { material_key: 'plain', effect_key: null, composition_json: JSON.stringify(composition) };
  const card = { name: 'Fixture', subtitle: null, sets: [], collections: [], class: null, rarity: null };
  const actual = path.join(dir, 'actual.png'), expected = path.join(dir, 'expected.png');
  const legacy = path.join(dir, 'legacy.png'), old = path.join(dir, 'old.png');
  const original = { subjectPath, backgroundPath, material: 'plain', effect: 'none', name: 'Fixture', subtitle: '', setName: 'Cabinet', serial: 'CABINET PROOF', className: '', rarity: '' };
  await renderProvisionedFront({ payload, card, subjectPath, backgroundPath, outputPath: actual });
  await composeCard({ ...original, composition, outputPath: expected });
  assert.deepEqual(fs.readFileSync(actual), fs.readFileSync(expected));
  await renderProvisionedFront({ payload: { ...payload, composition_json: null }, card, subjectPath, backgroundPath, outputPath: legacy });
  await composeCard({ ...original, outputPath: old });
  assert.deepEqual(fs.readFileSync(legacy), fs.readFileSync(old));
  assert.notDeepEqual(fs.readFileSync(actual), fs.readFileSync(legacy), 'fixture must reveal a dropped transform');
  for (const value of ['', false, 0, '{broken', JSON.stringify([]), JSON.stringify({ zoom: 2 })]) {
    await assert.rejects(renderProvisionedFront({ payload: { ...payload, composition_json: value }, card, subjectPath, backgroundPath, outputPath: path.join(dir, 'invalid.png') }));
  }
  console.log(`Synthetic compositor evidence: ${dir}`);
});
