import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const script = path.resolve("scripts/art/export-print-set.mjs");
test("refuses publication or apply modes without touching existing evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "foilbury-print-export-"));
  try {
    const output = path.join(dir, ".foilbury", "exports", "print-set");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "production.sql"), "historical evidence");
    for (const args of [[], ["--apply"], ["--inspect", "--database", "missing.sqlite", "--apply"]]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unavailable/i);
      assert.equal(await readFile(path.join(output, "production.sql"), "utf8"), "historical evidence");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("inspects an explicit sqlite file without changing it or creating a bundle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "foilbury-print-inspection-"));
  try {
    const file = path.join(dir, "fixture.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE fb_print_proposals (status TEXT); CREATE TABLE fb_print_proposal_reviews (id TEXT); INSERT INTO fb_print_proposals VALUES ('approved'),('proposed'); INSERT INTO fb_print_proposal_reviews VALUES ('review');");
    db.close();
    const missing = path.join(dir, "missing.sqlite");
    const failed = spawnSync(process.execPath, [script, "--inspect", "--database", missing], { cwd: dir, encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    await assert.rejects(readFile(missing), { code: "ENOENT" });
    const before = await readFile(file);
    const result = spawnSync(process.execPath, [script, "--inspect", "--database", file], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.publication_export_available, false);
    assert.deepEqual(report.counts, { proposals: 2, approved_proposals: 1, reviews: 1 });
    assert.deepEqual(await readFile(file), before);
    await assert.rejects(readFile(path.join(dir, ".foilbury", "exports", "print-set", "production.sql")), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
