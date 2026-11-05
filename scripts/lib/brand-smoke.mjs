/** Check the current asset page without treating the preserved archive as current. */
export function assertCurrentBrandPage(html) {
  if (typeof html !== 'string') throw new Error('Brand page is missing.');
  for (const expected of [
    'Foilbury brand assets',
    '/brand/kit/colophon/mark.svg',
    '/brand/kit/colophon/wordmark-ink.svg',
    '/brand/kit/colophon/discord-avatar-1024.png',
    '/brand/kit/colophon/social-preview.png',
  ]) {
    if (!html.includes(expected)) throw new Error(`Brand page is missing ${expected}.`);
  }
  if (html.includes('Selected · Signal Fold') || html.includes('agent-selected website candidate'))
    throw new Error('Brand page still presents the rejected or internal identity state.');
}
