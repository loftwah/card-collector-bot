#!/usr/bin/env node
/**
 * Read-only inspection of a local print catalogue.
 *
 * Publication bundle generation is disabled until approvals are tied to
 * immutable object versions and actor identity can be preserved. Previously
 * generated files are neither removed nor validated by this command.
 *
 *   node scripts/art/export-print-set.mjs --inspect --database /path/to/local.sqlite
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--inspect" || args[1] !== "--database" || !args[2]) {
  console.error("Print publication export is unavailable: reviewed artwork is not bound to immutable object versions. To inspect a local database without writing, use --inspect --database LOCAL_SQLITE. Existing export files are not validated.");
  process.exitCode = 1;
} else {
  let db;
  try {
    db = new DatabaseSync(path.resolve(args[2]), { readOnly: true });
    const count = (sql) => Number(db.prepare(sql).get().count);
    const report = {
      mode: "read-only-inspection",
      publication_export_available: false,
      counts: {
        proposals: count("SELECT COUNT(*) AS count FROM fb_print_proposals"),
        approved_proposals: count("SELECT COUNT(*) AS count FROM fb_print_proposals WHERE status = 'approved'"),
        reviews: count("SELECT COUNT(*) AS count FROM fb_print_proposal_reviews"),
      },
      note: "Counts do not verify artwork, provenance, review or an existing export.",
    };
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error("Could not inspect the supplied local print database. No publication bundle was generated.");
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
