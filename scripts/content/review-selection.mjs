import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REQUIRED_ROLES = ["mark", "cover", "back"];
const shaPattern = /^[a-f0-9]{64}$/;

function reviewedFile(root, entry, label) {
  if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !shaPattern.test(entry.sha256 ?? "")) {
    throw new Error(`${label} requires a relative path and lowercase SHA-256.`);
  }
  const parts = entry.path.split(/[\\/]/);
  if (!entry.path || path.isAbsolute(entry.path) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be inside the review root.`);
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} cannot contain a symbolic link.`);
  }
  if (!fs.statSync(current).isFile()) throw new Error(`${label} must be a file.`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(current)).digest("hex");
  if (actual !== entry.sha256) throw new Error(`${label} does not match its recorded SHA-256.`);
  return { path: entry.path, sha256: actual };
}

/** Validate retained review artifacts. This does not authenticate the reviewer. */
export function validateReviewSelection(selection, reviewRoot, expectedCollection) {
  if (!selection || selection.schema !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selection.collection ?? "")) throw new Error("A schema 1 selection and collection slug are required.");
  if (expectedCollection && selection.collection !== expectedCollection) throw new Error("Selection belongs to a different collection.");
  const review = selection.review;
  if (!review || review.decision !== "approved" || !["agent", "human"].includes(review.reviewer_kind) || typeof review.reviewer_id !== "string" || !review.reviewer_id.trim() || typeof review.note !== "string" || review.note.trim().length < 20 || typeof review.reviewed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(review.reviewed_at) || !Number.isFinite(Date.parse(review.reviewed_at))) {
    throw new Error("Selection requires an approved, attributed and dated review with a substantive note.");
  }
  if (!selection.assets || typeof selection.assets !== "object" || Array.isArray(selection.assets) || Object.keys(selection.assets).sort().join(",") !== [...REQUIRED_ROLES].sort().join(",")) throw new Error("Selection must contain exactly mark, cover and back assets.");
  const root = fs.realpathSync(reviewRoot);
  const evidence = reviewedFile(root, review.evidence, "Review evidence");
  const assets = Object.fromEntries(REQUIRED_ROLES.map((role) => [role, reviewedFile(root, selection.assets[role], role)]));
  return { collection: selection.collection, reviewer_kind: review.reviewer_kind, reviewer_id: review.reviewer_id, reviewed_at: review.reviewed_at, evidence, assets, reviewer_authenticated: false };
}
