import { existsSync } from "node:fs";
import path from "node:path";

export function generatedCardProofs(root) {
  return path.join(root, ".foilbury/evidence/card-v3/proofs");
}

export function cardProofPath(root, name) {
  const generated = path.join(generatedCardProofs(root), name);
  return existsSync(generated) ? generated : path.join(root, "art/proofs", name);
}
