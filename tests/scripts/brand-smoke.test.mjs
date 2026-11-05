import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCurrentBrandPage } from '../../scripts/lib/brand-smoke.mjs';
const parts=['Foilbury brand assets','/brand/kit/colophon/mark.svg','/brand/kit/colophon/wordmark-ink.svg','/brand/kit/colophon/discord-avatar-1024.png','/brand/kit/colophon/social-preview.png'];
test('brand smoke accepts the current page and rejects missing or stale identity',()=>{
  assert.doesNotThrow(()=>assertCurrentBrandPage(parts.join(' ')));
  for(const [index] of parts.entries()) assert.throws(()=>assertCurrentBrandPage(parts.filter((_,i)=>i!==index).join(' ')),/missing/i);
  for(const stale of ['Selected · Signal Fold','agent-selected website candidate']) assert.throws(()=>assertCurrentBrandPage(`${parts.join(' ')} ${stale}`),/rejected or internal/);
  assert.throws(()=>assertCurrentBrandPage(null),/missing/);
});
