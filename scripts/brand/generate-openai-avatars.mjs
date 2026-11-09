#!/usr/bin/env node
/**
 * Generate the Foilbury account-avatar family with OpenAI GPT Image.
 *
 * One base mascot is generated first, then every role and expression is an
 * image edit against that exact base. That keeps the character, paper texture,
 * lighting and palette consistent instead of producing eight unrelated images.
 *
 * Usage:
 *   set -a; source .env; set +a
 *   node scripts/brand/generate-openai-avatars.mjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const avatarDir = join(root, "public/avatars/default");
const mascotDir = join(root, "public/brand/mascot");
const workDir = join(root, ".foilbury/art/openai");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY is required.");

const MODEL = "gpt-image-2.6-sunburst";
const BASE_PROMPT = `A single square collectible avatar. An original Foilbury mascot: a small cream card-stock creature with a rounded rectangular body, one dog-eared top corner, two solid black ink dot eyes, a tiny restrained ink smile, one narrow electric foil-blue edge, two small paper hands and two small paper feet, holding a small antique brass cabinet key against its chest. Tactile paper craft photographed in a studio: visible paper fibre, deckled edges, letterpress ink bleed, soft directional light from upper left, subtle natural shadow, warm bone paper background. Minimal, charming, designed, restrained. Centred, strong silhouette, generous negative space. No text, no letters, no numbers, no logos, no UI, no floating particles, no glossy 3D, no plastic, no gradient background, no bokeh.`;

const EDITS = {
  archivist: `Keep this exact paper mascot, pose, face, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Add only tiny round brass spectacles resting on the face and a neat stack of cream index cards tucked under one paper hand. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  prospector: `Keep this exact paper mascot, pose, face, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Add only a small folded ochre paper explorer hat perched on the top edge and a brass magnifying loupe held in front of one eye by a paper hand. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  completionist: `Keep this exact paper mascot, pose, face, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Add only a tiny cream paper checklist card held in front of the chest, with one foil-blue checked box and one empty box. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  curator: `Keep this exact paper mascot, pose, face, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Add only a small black paper bow tie below the smile and a tiny framed miniature card held by one paper hand. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  "night-owl": `Keep this exact paper mascot, face, hands, feet, key, dog-eared corner, paper texture and lighting unchanged. Add only a deep charcoal paper hood behind the card with two pointed ears and a small antique brass crescent-moon pin on the hood. Keep the warm bone background and the blue foil edge. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  trader: `Keep this exact paper mascot, pose, face, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Add only a small black paper flat cap perched on the top edge and fan two tiny cream cards from one paper hand like a trade offer. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  neutral: `Keep this exact paper mascot, pose, body, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Change only the expression to a calm, friendly neutral: two solid ink dot eyes and a tiny restrained smile. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  curious: `Keep this exact paper mascot, pose, body, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Change only the expression to curious: one ink dot eye slightly wider, the other normal, and a tiny round open mouth. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  pleased: `Keep this exact paper mascot, pose, body, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Change only the expression to pleased: two happy curved ink eyes and a warm small smile. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
  mischievous: `Keep this exact paper mascot, pose, body, hands, feet, key, blue foil edge, dog-eared corner, paper texture, lighting, shadow and background unchanged. Change only the expression to mischievous: one eye narrowed, a small sideways smirk. No text, no letters, no numbers, no logos, no UI, no extra limbs.`,
};

async function requestImage(prompt, referencePath = null) {
  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", prompt);
  form.append("size", "1024x1024");
  form.append("quality", "high");
  form.append("output_format", "png");
  if (referencePath) {
    const bytes = await readFile(referencePath);
    form.append("image[]", new Blob([bytes], { type: "image/png" }), "reference.png");
  }
  const response = await fetch(
    referencePath
      ? "https://api.openai.com/v1/images/edits"
      : "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    },
  );
  const payload = await response.json();
  const b64 = payload?.data?.[0]?.b64_json;
  if (!response.ok || !b64) {
    throw new Error(`OpenAI image request failed (${response.status}): ${JSON.stringify(payload?.error ?? payload).slice(0, 500)}`);
  }
  return Buffer.from(b64, "base64");
}

async function render(buffer, path, size) {
  await sharp(buffer).resize(size, size, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(path);
}

// The generated sheet leaves generous studio margin. Account avatars read
// better with a tighter square that keeps the dog-ear, hands and feet intact.
const AVATAR_CROP = { left: 122, top: 122, width: 780, height: 780 };
async function renderAvatar(buffer, path, size) {
  await sharp(buffer)
    .extract(AVATAR_CROP)
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(path);
}

await mkdir(avatarDir, { recursive: true });
await mkdir(mascotDir, { recursive: true });
await mkdir(workDir, { recursive: true });

const basePath = join(workDir, "keeper.png");
let base;
try {
  base = await readFile(basePath);
} catch {
  base = await requestImage(BASE_PROMPT);
  await writeFile(basePath, base);
}
for (const size of [256, 128, 64, 32]) {
  await renderAvatar(base, join(avatarDir, `keeper-${size}.png`), size);
}
await render(base, join(mascotDir, "keeper-neutral-512.png"), 512);
console.log("rendered The Keeper");

for (const [role, prompt] of Object.entries(EDITS)) {
  let buffer;
  try {
    buffer = await readFile(join(workDir, `${role}.png`));
  } catch {
    buffer = await requestImage(prompt, basePath);
    await writeFile(join(workDir, `${role}.png`), buffer);
  }
  if (role in { neutral: 1, curious: 1, pleased: 1, mischievous: 1 }) {
    await render(buffer, join(mascotDir, `keeper-${role}-512.png`), 512);
    console.log(`rendered Keeper ${role}`);
    continue;
  }
  for (const size of [256, 128, 64, 32]) {
    await renderAvatar(buffer, join(avatarDir, `${role}-${size}.png`), size);
  }
  console.log(`rendered ${role}`);
}
