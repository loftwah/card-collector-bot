import fs from "node:fs";
import path from "node:path";
import { discoverSources, writeDiscovery } from "./data.mjs";

const json = process.argv.includes("--json");
try {
  const discovered = discoverSources();
  const file = path.join(process.cwd(), ".foilbury/sources/discovered.json");
  writeDiscovery(discovered, file);
  const counts = {
    sources: Object.keys(discovered.sources).length,
    backgrounds: discovered.backgrounds.length,
    cards: discovered.items.length,
    editions: discovered.items.length,
    variants: discovered.items.reduce((sum, item) => sum + item.variants.length, 0),
    sharedIdentities: new Set(discovered.items.map((item) => item.logicalId)).size !== discovered.items.length
      ? discovered.items.length - new Set(discovered.items.map((item) => item.logicalId)).size
      : 0,
  };
  if (json) {
    console.log(JSON.stringify({ ok: true, file, counts, sources: discovered.sources, backgrounds: discovered.backgrounds.map(({ key, sourceHash, sourcePath }) => ({ key, sourceHash, sourcePath })) }, null, 2));
  } else {
    console.log("Foilbury source discovery");
    for (const [name, source] of Object.entries(discovered.sources)) {
      console.log(`  ${name.padEnd(12)} ${source.commit.slice(0, 10)}  ${source.remote}`);
    }
    console.log(`  backgrounds: ${counts.backgrounds}`);
    console.log(`  cards:       ${counts.cards}`);
    console.log(`  editions:    ${counts.editions} (${counts.sharedIdentities} shared-identity editions)`);
    console.log(`  variants:    ${counts.variants}`);
    console.log(`  manifest:    ${path.relative(process.cwd(), file)}`);
    console.log("No files were uploaded and no card was changed.");
  }
} catch (error) {
  console.error(`sources:discover failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
