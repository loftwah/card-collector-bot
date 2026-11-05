import fs from 'node:fs';

// Matches the current asset upload limit. Stream bounds apply even when a
// response has no or an inaccurate Content-Length.
export const MAX_RENDER_SOURCE_BYTES = 8 * 1024 * 1024;
export async function readRenderSource(response) {
  if (!response.ok) throw new Error(`Render source fetch failed (${response.status}).`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Render source body is unavailable.');
  const chunks = []; let length = 0, count = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength; count++;
    if (length > MAX_RENDER_SOURCE_BYTES || count > 16384) {
      await reader.cancel(); throw new Error('Render source exceeds its bounded size.');
    }
    chunks.push(part.value);
  }
  if (!length) throw new Error('Render source is empty.');
  return Buffer.concat(chunks, length);
}
export function readLocalRenderSource(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (!size || size > MAX_RENDER_SOURCE_BYTES) throw new Error('Render source exceeds its bounded size.');
    const data = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const read = fs.readSync(fd, data, offset, size - offset, offset); if (!read) throw new Error('Render source changed while reading.'); offset += read; }
    if (fs.fstatSync(fd).size !== size) throw new Error('Render source changed while reading.');
    return data;
  } finally { fs.closeSync(fd); }
}
