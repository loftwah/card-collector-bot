import fs from 'node:fs';
import path from 'node:path';

/** Each claimed attempt owns a fresh directory, never a variant-derived path. */
export function createRenderWorkspace(root) {
  const directory = fs.mkdtempSync(path.join(root, 'render-attempt-'));
  return {
    directory,
    subject: path.join(directory, 'subject.png'),
    background: path.join(directory, 'background.png'),
    front: path.join(directory, 'front.webp'),
    back: path.join(directory, 'back.webp'),
    mark: extension => path.join(directory, `mark.${extension === 'svg' ? 'svg' : 'png'}`),
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
