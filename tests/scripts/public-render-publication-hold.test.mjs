import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/publish-public-renders.mjs", import.meta.url));

test("public render publisher holds both modes before touching files", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "foilbury-publish-hold-"));
  try {
    writeFileSync(path.join(directory, "evidence.txt"), "preserve me");
    for (const args of [[], ["--apply"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /publication is unavailable/);
      assert.deepEqual(readdirSync(directory), ["evidence.txt"]);
      assert.equal(readFileSync(path.join(directory, "evidence.txt"), "utf8"), "preserve me");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
