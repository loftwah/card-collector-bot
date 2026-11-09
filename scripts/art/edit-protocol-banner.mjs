#!/usr/bin/env node
/**
 * One bounded correction pass on the selected Protocol 11 banner candidate.
 * Keeps the composition, lighting and table setting; corrects only character
 * details that drifted from the supplied portraits.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const base = path.join(root, ".foilbury/generated/protocol-11/banner-candidate-2.png");
const outDir = path.join(root, ".foilbury/generated/protocol-11");
const ledgerPath = path.join(root, ".foilbury/evidence/art-budget-ledger.json");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()]),
);
const key = env.FAL_AI_API_KEY || env.FAL_KEY;
if (!key) throw new Error("FAL_AI_API_KEY or FAL_KEY is required in .env.");
const shasum = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const references = [
  base,
  ...[
    ".foilbury/art-src/protocol-11/protocol-gabe.png",
    ".foilbury/art-src/protocol-11/protocol-rhea.png",
    ".foilbury/art-src/protocol-11/protocol-june.png",
    ".foilbury/art-src/protocol-11/protocol-nora.png",
    ".foilbury/art-src/protocol-11/protocol-knox.png",
  ].map((relative) => path.join(root, relative)),
];
const dataUri = (file) => {
  const bytes = fs.readFileSync(file);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};

const prompt = `Edit the supplied group banner. Keep the exact composition, camera, lighting, room, table, props, poses, expressions and every character except for the three corrections below.
1. Rhea (the woman with purple hair and round glasses, second from the right): change her black top to the deep teal jacket from her portrait, with a cream shirt underneath. Keep her purple hair, glasses, face, earrings and pose unchanged.
2. June (the orange animal in the white chef hat, centre-right): make her an anthropomorphic raccoon matching her portrait — rounded raccoon ears, a cream muzzle, a dark raccoon mask around the eyes, and orange-and-cream fur. Keep the white chef hat and red neckerchief.
3. Knox (the silver robot on the right): remove the small green leaf emblem from the hoodie. Keep the teal hoodie, amber smile screen, antenna and pose unchanged.
Do not change Gabe, Nora, the table, the lamp, the window, the plants, the biscuits, the mugs, the dice or the board. No text, letters, numbers, logos, watermarks, borders, card frames or UI.`;

const body = {
  prompt,
  image_urls: references.map(dataUri),
  num_images: 1,
  aspect_ratio: "16:9",
  resolution: "2K",
  output_format: "png",
  safety_tolerance: 4,
};
const response = await fetch("https://queue.fal.run/fal-ai/nano-banana-pro/edit", {
  method: "POST",
  headers: { authorization: `Key ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const submitted = await response.json().catch(() => ({}));
if (!response.ok || !submitted.request_id) {
  throw new Error(
    `fal submit failed (${response.status}): ${JSON.stringify(submitted).slice(0, 400)}`,
  );
}
const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
const entry = {
  id: crypto.randomUUID(),
  subject: "protocol-11",
  role: "collection_banner_edit",
  candidate: 3,
  endpoint: "fal-ai/nano-banana-pro/edit",
  resolution: "2K",
  cost_usd: 0.15,
  prompt_sha256: shasum(Buffer.from(prompt)),
  prompt,
  reference_sha256: references.map((file) => shasum(fs.readFileSync(file))),
  status: "submitted",
  created_at: new Date().toISOString(),
};
ledger.entries.push(entry);
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });

const started = Date.now();
let imageUrl = null;
while (Date.now() - started < 6 * 60_000) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const poll = await fetch(submitted.status_url, { headers: { authorization: `Key ${key}` } });
  const state = await poll.json().catch(() => ({}));
  if (state.status === "COMPLETED") {
    const result = await fetch(submitted.response_url, {
      headers: { authorization: `Key ${key}` },
    });
    const output = await result.json().catch(() => ({}));
    imageUrl = output.images?.[0]?.url ?? null;
    if (!result.ok || !imageUrl) throw new Error(`fal result missing an image (${result.status}).`);
    break;
  }
  if (state.status === "FAILED") {
    throw new Error(`fal job failed: ${JSON.stringify(state).slice(0, 400)}`);
  }
}
if (!imageUrl) throw new Error(`fal job ${submitted.request_id} timed out after six minutes.`);
const imageResponse = await fetch(imageUrl);
if (!imageResponse.ok) throw new Error(`Output download failed (${imageResponse.status}).`);
const bytes = Buffer.from(await imageResponse.arrayBuffer());
const file = path.join(outDir, "banner-candidate-3.png");
fs.writeFileSync(file, bytes);
entry.status = "succeeded";
entry.request_id = submitted.request_id;
entry.output_file = path.relative(root, file);
entry.output_sha256 = shasum(bytes);
entry.completed_at = new Date().toISOString();
fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ file, sha256: entry.output_sha256, bytes: bytes.length }, null, 2));
