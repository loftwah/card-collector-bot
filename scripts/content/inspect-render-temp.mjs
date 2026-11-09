#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Names and timestamps are clues only; they do not prove ownership or liveness.
export function inspectRenderTemp(parent, { maxEntries = 2000, maxCandidates = 100 } = {}) {
  const candidates = [];
  let inspected = 0;
  let truncated = false;
  let directory;
  try {
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("Render temporary directory must not be a symlink.");
    directory = fs.opendirSync(parent);
  } catch (error) {
    if (error.code === "ENOENT") return { candidates, inspected, truncated };
    throw error;
  }
  try {
    while (true) {
      if (inspected >= maxEntries || candidates.length >= maxCandidates) {
        truncated = true;
        break;
      }
      const entry = directory.readSync();
      if (!entry) break;
      inspected++;
      if (!entry.name.startsWith("render-job-") || !entry.isDirectory()) continue;
      const candidatePath = path.join(parent, entry.name);
      try {
        const info = fs.lstatSync(candidatePath);
        if (!info.isDirectory()) continue;
        candidates.push({ name: entry.name, modifiedAt: info.mtime.toISOString(), status: "unverified" });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  } finally { directory.closeSync(); }
  return { candidates, inspected, truncated };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parent = path.join(process.cwd(), ".foilbury", "tmp");
  const result = inspectRenderTemp(parent);
  console.log(JSON.stringify({
    directory: parent,
    notice: "Names and timestamps do not establish ownership or whether a job is still running. No files were changed.",
    ...result,
  }, null, 2));
}
