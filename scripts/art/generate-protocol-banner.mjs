#!/usr/bin/env node
/**
 * Bounded Protocol 11 key-art generation.
 *
 * The five table-night portraits are the identity references. The supplied
 * table scene is a setting reference only; its incidental cast is not reused.
 * One or two candidates are generated, reviewed by a human, and only the
 * selected one is copied into the public collection-art path.
 *
 *   node scripts/art/generate-protocol-banner.mjs --candidates=2
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const root = process.cwd();
const outDir = path.join(root, ".foilbury/generated/protocol-11");
const ledgerPath = path.join(root, ".foilbury/evidence/art-budget-ledger.json");
const args = new Set(process.argv.slice(2));
const candidateArg = process.argv.find((arg) => arg.startsWith("--candidates="));
const candidates = Math.min(2, Math.max(1, Number(candidateArg?.split("=")[1] ?? 1)));
const dryRun = args.has("--dry-run");
const model = "fal-ai/nano-banana-pro/edit";
const unitCost = 0.15;
const passCap = 1.0;
const ledgerCap = 8.0;

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()]),
);
const key = env.FAL_AI_API_KEY || env.FAL_KEY;
if (!key && !dryRun) throw new Error("FAL_AI_API_KEY or FAL_KEY is required in .env.");

const shasum = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function readLedger() {
  return fs.existsSync(ledgerPath)
    ? JSON.parse(fs.readFileSync(ledgerPath, "utf8"))
    : { schema: 1, currency: "USD", cap_usd: ledgerCap, entries: [] };
}
const ledger = readLedger();
const spentThisPass = ledger.entries
  .filter(
    (entry) =>
      entry.subject === "protocol-11" &&
      (entry.status === "succeeded" || entry.status === "submitted"),
  )
  .reduce((sum, entry) => sum + Number(entry.cost_usd ?? 0), 0);
if (!dryRun && spentThisPass + candidates * unitCost > passCap + 0.0001) {
  throw new Error(`This pass would exceed the $${passCap.toFixed(2)} ceiling.`);
}

const references = [
  ".foilbury/art-src/protocol-11/protocol-gabe.png",
  ".foilbury/art-src/protocol-11/protocol-rhea.png",
  ".foilbury/art-src/protocol-11/protocol-june.png",
  ".foilbury/art-src/protocol-11/protocol-nora.png",
  ".foilbury/art-src/protocol-11/protocol-knox.png",
  ".foilbury/art-src/protocol-11/table-night-crew.png",
].map((relative) => path.join(root, relative));
for (const file of references) {
  if (!fs.existsSync(file)) throw new Error(`Missing reference: ${file}`);
}

const subject = `A warm, cinematic 16:9 collection banner for Protocol 11, an original Foilbury tabletop crew. The five recurring characters sit around a teal baize game table in a lamplit late-night room. Keep their likenesses exact from the supplied portraits:
- Gabe: a broad, warm human man with red curly hair, a thick black moustache, a small blue-star paper crown, a teal knit vest, cream shirt and red neckerchief.
- Rhea: a sharp, friendly woman with purple-black hair, round glasses and a teal jacket.
- June: a cheerful raccoon chef with orange fur, a cream muzzle, a small white chef hat and a red neckerchief.
- Nora: a composed grey cat with round brass glasses, a cream chest and a red knit sweater.
- Knox: a rounded silver robot with a warm amber smiling screen face, a short antenna and a teal hoodie.
They are mid-game: cards in hand, a bowl of biscuits, mugs, a folded score pad, wooden dice and a small board on the table. Hanging brass lamp, teal wall, plants, a dark window with city lights. Eye-level, all five readable, faces unobscured, hands and props coherent. Deep green, warm brass and cream palette, painterly editorial illustration, full-bleed, crisp enough for a website hero and a Discord banner.`;

const prompts = [
  `${subject}\n\nComposition: a wide ensemble across the far side and near side of the table, the hanging lamp pooling warm light in the centre, the table edge low in frame. Generous negative space at the top edge for a collection title. No text, letters, numbers, logos, watermarks, borders, card frames or UI.`,
  `${subject}\n\nComposition: a slightly higher three-quarter view, Gabe and June laughing at one end, Rhea leaning in, Nora and Knox at the near corners; the teal table and game pieces fill the lower third. Cinematic depth, the room softly out of focus. No text, letters, numbers, logos, watermarks, borders, card frames or UI.`,
];

function dataUri(file) {
  const bytes = fs.readFileSync(file);
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  return { uri: `data:${mime};base64,${bytes.toString("base64")}`, sha256: shasum(bytes) };
}

async function submit(prompt) {
  const body = {
    prompt,
    image_urls: references.map((file) => dataUri(file).uri),
    num_images: 1,
    aspect_ratio: "16:9",
    resolution: "2K",
    output_format: "png",
    safety_tolerance: 4,
  };
  const response = await fetch(`https://queue.fal.run/${model}`, {
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
  const started = Date.now();
  while (Date.now() - started < 6 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await fetch(submitted.status_url, { headers: { authorization: `Key ${key}` } });
    const state = await poll.json().catch(() => ({}));
    if (state.status === "COMPLETED") {
      const result = await fetch(submitted.response_url, {
        headers: { authorization: `Key ${key}` },
      });
      const output = await result.json().catch(() => ({}));
      if (!result.ok || !output.images?.[0]?.url) {
        throw new Error(`fal result missing an image (${result.status}).`);
      }
      return { requestId: submitted.request_id, imageUrl: output.images[0].url };
    }
    if (state.status === "FAILED") {
      throw new Error(`fal job failed: ${JSON.stringify(state).slice(0, 400)}`);
    }
  }
  throw new Error(`fal job ${submitted.request_id} timed out after six minutes.`);
}

fs.mkdirSync(outDir, { recursive: true });
if (dryRun) {
  console.log(
    JSON.stringify({ dry_run: true, candidates, unitCost, passCap, references, prompts }, null, 2),
  );
  process.exit(0);
}

const results = [];
for (let index = 0; index < candidates; index += 1) {
  const prompt = prompts[index % prompts.length];
  const entry = {
    id: crypto.randomUUID(),
    subject: "protocol-11",
    role: "collection_banner",
    candidate: index + 1,
    endpoint: model,
    resolution: "2K",
    cost_usd: unitCost,
    prompt_sha256: shasum(Buffer.from(prompt)),
    prompt,
    reference_sha256: references.map((file) => dataUri(file).sha256),
    status: "submitted",
    created_at: new Date().toISOString(),
  };
  ledger.entries.push(entry);
  ledger.cap_usd = Math.max(Number(ledger.cap_usd ?? 0), ledgerCap);
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  try {
    const output = await submit(prompt);
    const imageResponse = await fetch(output.imageUrl);
    if (!imageResponse.ok) throw new Error(`Output download failed (${imageResponse.status}).`);
    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    const file = path.join(outDir, `banner-candidate-${index + 1}.png`);
    fs.writeFileSync(file, bytes);
    entry.status = "succeeded";
    entry.request_id = output.requestId;
    entry.output_file = path.relative(root, file);
    entry.output_sha256 = shasum(bytes);
    entry.completed_at = new Date().toISOString();
    results.push({ file, sha256: entry.output_sha256, bytes: bytes.length });
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    throw error;
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  console.log(`generated candidate ${index + 1}: ${entry.output_file}`);
}

const metadata = await Promise.all(results.map((result) => sharp(result.file).metadata()));
console.log(JSON.stringify({ model, results, metadata }, null, 2));
