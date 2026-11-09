#!/usr/bin/env node
import fs from "node:fs";
import { validateReviewSelection } from "./review-selection.mjs";

const [selectionPath, reviewRoot, collection] = process.argv.slice(2);
if (!selectionPath || !reviewRoot || !collection) {
  console.error("Usage: node scripts/content/check-review-selection.mjs <selection.json> <review-root> <collection-slug>");
  process.exitCode = 2;
} else {
  try {
    const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8"));
    const result = validateReviewSelection(selection, reviewRoot, collection);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(`Selection rejected: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
