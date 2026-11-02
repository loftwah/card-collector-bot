import fs from "node:fs";
import path from "node:path";
import { discoverSources, toManifest } from "./data.mjs";
import { apiJson, ensureServer } from "../lib/api.mjs";

const json = process.argv.includes("--json");
try {
  const discovered = discoverSources();
  const manifest = toManifest(discovered);
  await ensureServer();
  const preview = await apiJson("/api/v1/admin/imports/preview", { method: "POST", body: manifest });
  const summary = {
    counts: preview.counts,
    sourceCommits: Object.fromEntries(Object.entries(discovered.sources).map(([name, source]) => [name, source.commit])),
    items: preview.items.map((item) => ({ slug: item.slug, action: item.action, sets: item.sets, variants: item.variants.length })),
  };
  const file = path.join(process.cwd(), ".foilbury/sources/preview.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
  fs.chmodSync(file, 0o600);
  if (json) {
    console.log(JSON.stringify({ ok: true, ...summary, file }, null, 2));
  } else {
    console.log("Foilbury source preview (nothing written)");
    console.log(`  new:       ${preview.counts.new}`);
    console.log(`  revisions: ${preview.counts.revision}`);
    console.log(`  unchanged: ${preview.counts.unchanged}`);
    for (const item of preview.items) console.log(`  ${item.action.padEnd(9)} ${item.slug.padEnd(20)} ${item.variants.length} variants  sets: ${item.sets.join(", ") || "—"}`);
    console.log(`  preview:   ${path.relative(process.cwd(), file)}`);
  }
} catch (error) {
  console.error(`sources:preview failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
