import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("scripts/lib/local.mjs")).href;
function runSetup(dir) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { ensureDevVars } from ${JSON.stringify(moduleUrl)}; ensureDevVars();`], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("local setup preserves unrelated values, comments, ordering, line endings and permissions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-vars-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".dev.vars");
  const original = "# operator note\r\nCUSTOM_PROVIDER_KEY=fixture value\r\nFOILBURY_LOCAL_MODE=false\r\n# keep this\r\nCUSTOM_FLAG=on\r\nFOILBURY_LOCAL_MODE=false\r\n";
  fs.writeFileSync(file, original, { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  runSetup(dir);
  const result = fs.readFileSync(file, "utf8");
  assert.ok(result.startsWith(original.replaceAll("FOILBURY_LOCAL_MODE=false", "FOILBURY_LOCAL_MODE=true")));
  assert.equal(result.match(/FOILBURY_LOCAL_MODE=true/g)?.length, 2);
  assert.ok(result.includes("FOILBURY_SESSION_SECRET="));
  assert.ok(!result.replaceAll("\r\n", "").includes("\n"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  runSetup(dir);
  assert.equal(fs.readFileSync(file, "utf8"), result);
});

test("local setup creates missing configuration with private permissions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-vars-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  runSetup(dir);
  const file = path.join(dir, ".dev.vars");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /FOILBURY_LOCAL_MODE=true/);
});

test("invalid configured secrets cause an error without changing the file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-vars-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".dev.vars");
  for (const original of ["FOILBURY_SESSION_SECRET=short-fixture\nCUSTOM=keep\n", "EMDASH_ENCRYPTION_KEY=unsupported-fixture\nCUSTOM=keep\n"]) {
    fs.writeFileSync(file, original);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { ensureDevVars } from ${JSON.stringify(moduleUrl)}; ensureDevVars();`], { cwd: dir, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.doesNotMatch(result.stderr, /short-fixture|unsupported-fixture/);
  }
});
