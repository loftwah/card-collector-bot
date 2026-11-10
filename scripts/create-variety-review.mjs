#!/usr/bin/env node
/**
 * Create one review wall with three genuinely different Tux directions.
 *
 * The cards were composed offline by art/card-v3.mjs from new AI scene and
 * subject plates. This script only records the brief and uploads the real
 * front/back bytes; it does not call a provider and does not publish.
 */
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.FOILBURY_URL ?? "https://foilbury.loftwah.com";
const root = process.cwd();
const evidence = path.join(root, ".foilbury/evidence/card-v3");
const variety = path.join(evidence, "variety/assets");
const proofs = path.join(root, "public/art/proofs");
const TITLE = "Tux · Three real directions (review)";
const COLLECTION_ID = "col_cat_mvyy304zzwa1059kz0fk5r47";
const CARD_ID = "crd_mvyy31qsehckx6he4ahjajn7";
const VARIANT_ID = "var_mvyy31qw0s2x1hxh0d274akn";

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}
const agent = readJson(".foilbury/production-agent.json");
const access = readJson(".foilbury/access-service-token.json");

async function api(route, { method = "GET", body, form } = {}) {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${agent.token}`);
  headers.set("CF-Access-Client-Id", access.client_id);
  headers.set("CF-Access-Client-Secret", access.client_secret);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${BASE_URL}${route}`, { method, headers, body: payload });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const error = parsed?.error;
    throw new Error(
      `${response.status} ${route} ${error?.code ?? "request_failed"}: ${error?.message ?? text.slice(0, 500)}`,
    );
  }
  return parsed;
}

function fileFrom(dir, name, type = "application/octet-stream") {
  const found = path.join(dir, name);
  if (!fs.existsSync(found)) throw new Error(`Missing upload file: ${found}`);
  return new File([fs.readFileSync(found)], name, { type });
}

const layers = {
  neon: [
    { role: "scene", kind: "ai", model: "gpt-image-2.5-flare", note: "Rain-slick neon street." },
    {
      role: "subject",
      kind: "ai-cutout",
      model: "gpt-image-2.5-flare",
      note: "Standing Tux, magenta key removed to alpha; feet break into the field note.",
    },
    { role: "material", kind: "authored", note: "Ink panel and print paper." },
    {
      role: "frame",
      kind: "authored",
      note: "Ink edge, holographic inner rule and corner marks with a true art window.",
    },
    {
      role: "effect",
      kind: "ai-screen",
      model: "composed mask",
      note: "Neon holographic edge at 0.34 screen.",
    },
    { role: "type", kind: "code", note: "Exact code-set card type." },
    { role: "back", kind: "authored", note: "Designed record back." },
  ],
  rooftop: [
    {
      role: "scene",
      kind: "ai",
      model: "gpt-image-2.5-flare",
      note: "Rain-slick rooftop antenna above a neon city.",
    },
    {
      role: "subject",
      kind: "ai-cutout",
      model: "gpt-image-2.5-flare",
      note: "Crouched Tux with radio, alpha cutout, feet break into the field note.",
    },
    { role: "material", kind: "authored", note: "Gold rule, ink panel and print paper." },
    {
      role: "frame",
      kind: "authored",
      note: "Gold edge, corner marks and a true art window.",
    },
    { role: "type", kind: "code", note: "Exact code-set card type." },
    { role: "back", kind: "authored", note: "Designed record back." },
  ],
  terminal: [
    {
      role: "scene",
      kind: "ai",
      model: "gpt-image-2.5-flare",
      note: "Long data-centre aisle with amber and teal service lights.",
    },
    {
      role: "subject",
      kind: "ai-cutout",
      model: "gpt-image-2.5-flare",
      note: "Running Tux with radio, alpha cutout, feet break into the field note.",
    },
    { role: "material", kind: "authored", note: "Silver rule, ink panel and print paper." },
    {
      role: "frame",
      kind: "authored",
      note: "Silver edge, corner marks and a true art window.",
    },
    { role: "type", kind: "code", note: "Exact code-set card type." },
    { role: "back", kind: "authored", note: "Designed record back." },
  ],
};

const directions = [
  {
    label: "Direction 1 · Neon noir · Holographic",
    base: "tux-v3",
    scene: path.join(evidence, "tux-v3-scene.png"),
    front: path.join(proofs, "tux-v3-front.webp"),
    back: path.join(proofs, "tux-v3-back.webp"),
    master: path.join(proofs, "tux-v3-front-master.png"),
    preview: path.join(evidence, "tux-v3-front-400.webp"),
    thumb: path.join(evidence, "tux-v3-front-128.png"),
    layers: layers.neon,
    prompt:
      "Neon noir direction: standing Tux in a rain-slick signal street, holographic edge, ink frame, exact code-set type, designed record back.",
  },
  {
    label: "Direction 2 · Rooftop relay · Gold",
    base: "tux-rooftop",
    scene: path.join(variety, "rooftop-scene.png"),
    front: path.join(proofs, "tux-rooftop-front.webp"),
    back: path.join(proofs, "tux-rooftop-back.webp"),
    master: path.join(proofs, "tux-rooftop-front-master.png"),
    preview: path.join(evidence, "tux-rooftop-front-400.webp"),
    thumb: path.join(evidence, "tux-rooftop-front-128.png"),
    layers: layers.rooftop,
    prompt:
      "Rooftop relay direction: crouched Tux on a wet antenna roof above a neon city, gold rule, ink frame, exact code-set type, designed record back.",
  },
  {
    label: "Direction 3 · Terminal run · Silver",
    base: "tux-terminal",
    scene: path.join(variety, "server-scene.png"),
    front: path.join(proofs, "tux-terminal-front.webp"),
    back: path.join(proofs, "tux-terminal-back.webp"),
    master: path.join(proofs, "tux-terminal-front-master.png"),
    preview: path.join(evidence, "tux-terminal-front-400.webp"),
    thumb: path.join(evidence, "tux-terminal-front-128.png"),
    layers: layers.terminal,
    prompt:
      "Terminal run direction: sprinting Tux through a data-centre aisle, silver rule, ink frame, exact code-set type, designed record back.",
  },
];

const index = await api("/api/v1/admin/art?category=cards&limit=100");
const existing = (index.briefs ?? []).find((brief) => brief.title === TITLE);
let briefId = existing?.id;
if (!briefId) {
  const created = await api("/api/v1/admin/art/briefs", {
    method: "POST",
    body: {
      category: "cards",
      collectionId: COLLECTION_ID,
      cardId: CARD_ID,
      targetVariantId: VARIANT_ID,
      title: TITLE,
      intent:
        "Three genuinely different finished directions for Tux, not crop variants: Neon noir (rain street, standing, Holographic), Rooftop relay (crouched on an antenna roof, Gold) and Terminal run (sprinting through a data-centre aisle, Silver). The identity and exact copy stay fixed; setting, pose, finish, palette and frame material change. Review each as a full front and back.",
      audience: "public",
      candidateCount: 3,
      provider: "openai",
      model: "gpt-image-2.6-sunburst",
      methods: ["composed_scene"],
      styleKeys: ["neon"],
      outputSizes: ["1500x2100", "750x1050", "400x560", "128x179"],
      costCapCents: 100,
    },
  });
  briefId = created.brief?.brief?.id ?? created.brief?.id ?? created.id;
  console.log("brief", briefId);
} else {
  console.log("reusing brief", briefId);
  const detail = await api(`/api/v1/admin/art/briefs/${briefId}`);
  if ((detail.candidates ?? []).length >= directions.length) {
    console.log("candidates already uploaded");
    process.exit(0);
  }
}

const queued = await api(`/api/v1/admin/art/briefs/${briefId}/generate`, {
  method: "POST",
  body: { candidateCount: 3 },
});
const jobId = queued.jobs?.at(-1)?.id;
if (!jobId) throw new Error(`No job returned: ${JSON.stringify(queued).slice(0, 400)}`);
const claimed = await api("/api/v1/admin/art/jobs/claim", {
  method: "POST",
  body: { jobId },
});
console.log("job", claimed.job?.job?.id ?? jobId);

for (const direction of directions) {
  const form = new FormData();
  form.append("label", direction.label);
  form.append("prompt", direction.prompt);
  form.append("layers", JSON.stringify(direction.layers));
  form.append("raw", fileFrom(path.dirname(direction.scene), path.basename(direction.scene), "image/png"));
  form.append("front", fileFrom(path.dirname(direction.front), path.basename(direction.front), "image/webp"));
  form.append("back", fileFrom(path.dirname(direction.back), path.basename(direction.back), "image/webp"));
  form.append(
    "master",
    fileFrom(path.dirname(direction.master), path.basename(direction.master), "image/png"),
  );
  form.append(
    "preview400",
    fileFrom(path.dirname(direction.preview), path.basename(direction.preview), "image/webp"),
  );
  form.append(
    "thumb128",
    fileFrom(path.dirname(direction.thumb), path.basename(direction.thumb), "image/png"),
  );
  const uploaded = await api(`/api/v1/admin/art/jobs/${jobId}/candidates`, {
    method: "POST",
    form,
  });
  console.log("candidate", direction.label, uploaded.candidate?.id);
}

await api(`/api/v1/admin/art/jobs/${jobId}/complete`, {
  method: "POST",
  body: {
    actualCostCents: 0,
    costSource: "runner_recorded",
    note: "Scenes and subject poses were generated in the operator session; this job made no provider call.",
  },
});
console.log("review", `${BASE_URL}/studio/art?brief=${briefId}`);
