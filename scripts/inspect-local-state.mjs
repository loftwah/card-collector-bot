import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const r2 = path.join(root, ".wrangler/state/v3/r2");

if (fs.existsSync(r2)) {
  for (const entry of fs.readdirSync(r2)) {
    const full = path.join(r2, entry);
    if (entry.includes("foilbury") || entry.includes("miniflare-R2BucketObject")) {
      console.log(`local R2 state: ${path.relative(root, full)}`);
    }
  }
}
console.log(`local D1 state: ${path.relative(root, path.join(root, ".wrangler/state/v3/d1"))}`);
