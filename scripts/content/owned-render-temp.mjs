import fs from "node:fs";
import path from "node:path";

// A job owns only the freshly created directory, never a shared filename.
export async function withOwnedRenderTemp(parent, run) {
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "render-job-"));
  // Pathname-based identity checks cannot atomically prevent a same-user swap
  // before unlink. Retain output until a safe ownership/reclamation mechanism
  // is available, including on successful completion.
  return await run(directory);
}
