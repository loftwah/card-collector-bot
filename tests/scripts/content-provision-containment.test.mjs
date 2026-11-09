import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/content/provision.mjs");

test("provisioning refuses writes before accessing local state or an endpoint", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-provision-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, "--skip-render"], { cwd: dir, encoding: "utf8", env: { ...process.env, FOILBURY_URL: "http://127.0.0.1:1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no verifiable byte-bound review record/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("dry run inventories manifests without writing generated art or connecting", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-provision-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const content = path.join(dir, ".foilbury", "content");
  fs.mkdirSync(content, { recursive: true });
  const source = JSON.stringify({ schema: 1, collection: { slug: "sample", name: "Sample" }, cards: [{ slug: "test", name: "Test", bio: "Fictional fixture" }] });
  fs.writeFileSync(path.join(content, "sample.json"), source);
  const result = spawnSync(process.execPath, [script, "--dry-run", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, FOILBURY_URL: "http://127.0.0.1:1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: "dry-run", collections: [{ slug: "sample", cards: 1, achievements: 0 }], writes: 0 });
  assert.deepEqual(fs.readdirSync(path.join(dir, ".foilbury")), ["content"]);
  assert.equal(fs.readFileSync(path.join(content, "sample.json"), "utf8"), source);
});
