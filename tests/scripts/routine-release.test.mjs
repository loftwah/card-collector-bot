import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMigrationParity,
  releaseBudget,
  requireSameDeployment,
  requireSameSource,
  reportedUploadVersion,
  singleServingVersion,
} from "../../scripts/lib/routine-release.mjs";

test("routine release rejects unreadable, changed, duplicated or reordered production migrations", () => {
  const schema = ["0001_first.sql", "0002_second.sql"];
  assert.deepEqual(assertMigrationParity(schema, schema), schema);
  for (const remote of [
    null,
    [],
    ["0001_first.sql"],
    [...schema].reverse(),
    [...schema, schema[0]],
    ["0001_first.sql", "../escape.sql"],
  ]) {
    assert.throws(() => assertMigrationParity(schema, remote), /migrations differ/);
  }
});

test("the two-minute budget applies before display rounding", () => {
  assert.equal(releaseBudget(119.9).remaining_seconds, 0.1);
  assert.equal(releaseBudget(120).within_budget, true);
  assert.equal(releaseBudget(120.01).within_budget, false);
});

const source = { sha: "a".repeat(40), tree_hash: "b".repeat(64), content_hash: "c".repeat(64) };

test("requires one fully serving version", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(singleServingVersion({ versions: [{ version_id: id, percentage: 100 }] }), id);
  for (const versions of [
    [],
    [{ version_id: id, percentage: 99 }],
    [
      { version_id: id, percentage: 50 },
      { version_id: id, percentage: 50 },
    ],
  ])
    assert.throws(() => singleServingVersion({ versions }));
});

test("requires one reported upload version", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(reportedUploadVersion(`Uploaded\nCurrent Version ID: ${id}\n`), id);
  assert.equal(reportedUploadVersion("no version"), null);
  assert.equal(reportedUploadVersion(`Current Version ID: ${id}\nCurrent Version ID: ${id}`), null);
});

test("rejects source or active deployment drift", () => {
  requireSameSource(source, { ...source });
  for (const current of [
    { ...source, dirty: " M file" },
    { ...source, sha: "f".repeat(40) },
    { ...source, tree_hash: "f".repeat(64) },
    { ...source, content_hash: "f".repeat(64) },
  ])
    assert.throws(() => requireSameSource(source, current));
  const id = "12345678-1234-1234-1234-123456789abc";
  const deployment = { id: "one", versions: [{ version_id: id, percentage: 100 }] };
  requireSameDeployment(deployment, structuredClone(deployment));
  assert.throws(() => requireSameDeployment(deployment, { ...deployment, id: "two" }));
  assert.throws(() =>
    requireSameDeployment(deployment, {
      ...deployment,
      versions: [{ version_id: id, percentage: 50 }],
    }),
  );
});
