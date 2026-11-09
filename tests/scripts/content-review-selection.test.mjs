import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { validateReviewSelection } from "../../scripts/content/review-selection.mjs";

const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-review-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = {};
  for (const role of ["mark", "cover", "back"]) {
    const text = `fictional ${role}`;
    fs.writeFileSync(path.join(root, `${role}.png`), text);
    assets[role] = { path: `${role}.png`, sha256: digest(text) };
  }
  const text = "fictional review evidence";
  fs.writeFileSync(path.join(root, "evidence.txt"), text);
  return { root, selection: { schema: 1, collection: "sample", assets, review: { decision: "approved", reviewer_kind: "agent", reviewer_id: "fixture-agent", reviewed_at: "2026-11-04T00:00:00Z", note: "Fixture reviewed each selected file.", evidence: { path: "evidence.txt", sha256: digest(text) } } } };
}

test("validates each recorded byte and identifies review as unauthenticated", (t) => {
  const { root, selection } = fixture(t);
  const result = validateReviewSelection(selection, root, "sample");
  assert.equal(result.reviewer_kind, "agent");
  assert.equal(result.reviewer_authenticated, false);
  assert.equal(result.assets.cover.sha256, selection.assets.cover.sha256);
  selection.review.reviewer_kind = "human";
  assert.equal(validateReviewSelection(selection, root, "sample").reviewer_kind, "human");
});

test("rejects changed assets and review evidence, absent roles, and wrong collection", (t) => {
  const { root, selection } = fixture(t);
  assert.throws(() => validateReviewSelection(selection, root, "other"), /different collection/);
  fs.writeFileSync(path.join(root, "cover.png"), "changed");
  assert.throws(() => validateReviewSelection(selection, root, "sample"), /cover does not match/);
  fs.writeFileSync(path.join(root, "cover.png"), "fictional cover");
  fs.writeFileSync(path.join(root, "evidence.txt"), "changed");
  assert.throws(() => validateReviewSelection(selection, root, "sample"), /evidence does not match/);
  delete selection.assets.back;
  assert.throws(() => validateReviewSelection(selection, root, "sample"), /exactly mark, cover and back/);
});

test("rejects traversal, symlinks, malformed or unattributed approvals", (t) => {
  const { root, selection } = fixture(t);
  selection.assets.mark.path = "../outside.png";
  assert.throws(() => validateReviewSelection(selection, root, "sample"), /inside the review root/);
  fs.symlinkSync("cover.png", path.join(root, "link.png"));
  selection.assets.mark = { ...selection.assets.cover, path: "link.png" };
  assert.throws(() => validateReviewSelection(selection, root, "sample"), /symbolic link/);
  selection.review.reviewer_id = "";
  assert.throws(() => validateReviewSelection(selection, root, "sample"), /attributed/);
});
