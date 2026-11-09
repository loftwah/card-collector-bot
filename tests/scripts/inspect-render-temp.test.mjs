import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectRenderTemp } from "../../scripts/content/inspect-render-temp.mjs";

test("inspection preserves old and live-like output and does not follow symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-inspect-test-"));
  try {
    const parent = path.join(root, ".foilbury", "tmp");
    fs.mkdirSync(parent, { recursive: true });
    const old = path.join(parent, "render-job-old");
    const live = path.join(parent, "render-job-live");
    fs.mkdirSync(old);
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(old, "partial.webp"), "old evidence");
    fs.writeFileSync(path.join(live, "front.webp"), "live output");
    fs.utimesSync(old, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    fs.symlinkSync(live, path.join(parent, "render-job-link"));
    const parentLink = path.join(root, "parent-link");
    fs.symlinkSync(parent, parentLink);
    assert.throws(() => inspectRenderTemp(parentLink), /must not be a symlink/);
    const result = inspectRenderTemp(parent);
    assert.deepEqual(result.candidates.map((item) => item.name).sort(), ["render-job-live", "render-job-old"]);
    assert.ok(result.candidates.every((item) => item.status === "unverified"));
    assert.equal(result.truncated, false);
    assert.equal(fs.readFileSync(path.join(old, "partial.webp"), "utf8"), "old evidence");
    assert.equal(fs.readFileSync(path.join(live, "front.webp"), "utf8"), "live output");
    assert.equal(fs.lstatSync(path.join(parent, "render-job-link")).isSymbolicLink(), true);
    const script = fileURLToPath(new URL("../../scripts/content/inspect-render-temp.mjs", import.meta.url));
    const command = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    assert.match(JSON.parse(command.stdout).notice, /No files were changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("inspection is bounded and reports incomplete results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-inspect-test-"));
  try {
    for (let i = 0; i < 3; i++) fs.mkdirSync(path.join(root, `render-job-${i}`));
    const result = inspectRenderTemp(root, { maxEntries: 2, maxCandidates: 2 });
    assert.equal(result.inspected, 2);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(fs.readdirSync(root).length, 3);
    assert.deepEqual(inspectRenderTemp(path.join(root, "missing")), { candidates: [], inspected: 0, truncated: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
