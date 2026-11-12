#!/usr/bin/env node
/**
 * Publish the v3 layered Tux card to the live Holographic variant.
 *
 * This is an operator script, not a second release system: it queues one
 * bounded Art Lab job, claims it with the production agent grant, uploads the
 * real v3 front/back/master bytes plus the layer metadata, completes the job
 * with zero provider spend (the images were generated in the operator
 * session), approves the candidate and publishes it to the named variant.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cardProofPath } from "../art/proof-paths.mjs";

const BASE_URL = process.env.FOILBURY_URL ?? "https://foilbury.loftwah.com";
const FINISH = (process.env.V3_FINISH ?? "holographic").toLowerCase();
const PLAIN = FINISH === "plain";
const suffix = PLAIN ? "-plain" : "";
const VARIANT_ID =
  process.env.VARIANT_ID ??
  (PLAIN ? "var_mvyy31qvaahfz5gc6bcks0dk" : "var_mvyy31qw0s2x1hxh0d274akn");
const CREATE_BRIEF = process.argv.includes("--create-brief");
const REFRESH = process.argv.includes("--refresh");
const APPROVAL_ID = process.env.APPROVAL_ID ?? "";
let BRIEF_ID = process.env.BRIEF_ID ?? (PLAIN ? "" : "artb_mwawjmqmm63pac3yhddd5a83");
const DRY_RUN = process.argv.includes("--dry-run");
const root = process.cwd();
const evidence = path.join(root, ".foilbury/evidence/card-v3");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

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

function uploadPath(name) {
  return [path.join(evidence, name), cardProofPath(root, name)].find((candidate) =>
    fs.existsSync(candidate),
  );
}

function file(name, type = "application/octet-stream") {
  const found = uploadPath(name);
  if (!found) throw new Error(`Missing upload file: ${name}`);
  return new File([fs.readFileSync(found)], name, { type });
}

const layers = [
  {
    role: "scene",
    kind: "ai",
    model: "gpt-image-2.5-flare",
    note: "Rain-slick neon signal street, no type or characters.",
  },
  {
    role: "subject",
    kind: "ai-cutout",
    model: "gpt-image-2.5-flare",
    note: "Tux signal-keeper, magenta key removed to alpha; feet break into the field-record panel.",
  },
  {
    role: "material",
    kind: "authored",
    note: "Ink panel, foil hairlines and print paper.",
  },
  {
    role: "frame",
    kind: "authored",
    note: "Ink edge, foil inner rule and corner marks with a real art window.",
  },
  ...(PLAIN
    ? []
    : [
        {
          role: "effect",
          kind: "ai-screen",
          model: "composed mask",
          note: "Neon holographic edge at 0.42 screen, 0.25 on the back edge.",
        },
      ]),
  {
    role: "type",
    kind: "code",
    note: "Exact name, role, rarity, finish, print code and provenance set by art/card-v3.mjs.",
  },
  {
    role: "back",
    kind: "authored",
    note: "Designed record with header, bio, field record, provenance and credits.",
  },
];

const label = `Candidate · Layered v3 breakout${PLAIN ? " · Plain" : ""}`;
const uploads = [
  ["raw", "tux-v3-scene.png", "image/png"],
  ["front", `tux-v3${suffix}-front.webp`, "image/webp"],
  ["back", `tux-v3${suffix}-back.webp`, "image/webp"],
  ["master", `tux-v3${suffix}-front-master.png`, "image/png"],
  ["preview400", `tux-v3${suffix}-front-400.webp`, "image/webp"],
  ["thumb128", `tux-v3${suffix}-front-128.png`, "image/png"],
  ["reference", "tux-v3-subject-alpha.png", "image/png"],
];

if (DRY_RUN) {
  console.log(
    JSON.stringify(
      {
        BASE_URL,
        BRIEF_ID,
        VARIANT_ID,
        createBrief: CREATE_BRIEF,
        refresh: REFRESH,
        files: uploads.map(([field, name]) => ({
          field,
          name,
          available: Boolean(uploadPath(name)),
        })),
        layers,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const resumeArg = process.argv.find((arg) => arg.startsWith("--job="));
let jobId = resumeArg?.split("=")[1]?.trim();
if (!jobId && !BRIEF_ID && !CREATE_BRIEF) throw new Error("Supply BRIEF_ID or --create-brief.");
if (REFRESH && !APPROVAL_ID)
  throw new Error("--refresh needs APPROVAL_ID for the live publication.");
const uploadFiles = uploads.map(([field, name, type]) => [field, file(name, type)]);

const agent = readJson(".foilbury/production-agent.json");
const access = readJson(".foilbury/access-service-token.json");

if (CREATE_BRIEF) {
  const created = await api("/api/v1/admin/art/briefs", {
    method: "POST",
    body: {
      category: "cards",
      collectionId: "col_cat_mvyy304zzwa1059kz0fk5r47",
      cardId: "crd_mvyy31qsehckx6he4ahjajn7",
      targetVariantId: VARIANT_ID,
      title: `Tux · Neon layered ${PLAIN ? "plain" : "holographic"} finish`,
      intent: `Layered production card for the Tux ${PLAIN ? "Plain" : "Holographic"} finish: AI Neon scene, the real Tux subject cutout breaking the frame, an authored ink frame with a true art window, ${PLAIN ? "a plain material edge with no holo layer" : "an AI holographic edge layer"} and exact code-set type. Designed record back with header, bio, field record, provenance and credits.`,
      audience: "public",
      candidateCount: 2,
      provider: "openai",
      model: "gpt-image-2.6-sunburst",
      methods: ["composed_scene"],
      styleKeys: ["neon"],
      outputSizes: ["1500x2100", "750x1050", "400x560", "128x179"],
      costCapCents: 100,
    },
  });
  BRIEF_ID = created.brief?.brief?.id ?? created.brief?.id ?? created.id;
  if (!BRIEF_ID) throw new Error(`Brief creation failed: ${JSON.stringify(created).slice(0, 400)}`);
  console.log("brief", BRIEF_ID);
}

if (!jobId) {
  const queued = await api(`/api/v1/admin/art/briefs/${BRIEF_ID}/generate`, {
    method: "POST",
    body: { candidateCount: 1 },
  });
  const job = queued.jobs?.at(-1);
  if (!job?.id) throw new Error(`No queued job returned: ${JSON.stringify(queued).slice(0, 400)}`);
  console.log("queued", job.id, job.method, job.style_key, job.provider, job.model);
  const claimed = await api("/api/v1/admin/art/jobs/claim", {
    method: "POST",
    body: { jobId: job.id },
  });
  jobId = claimed.job?.job?.id ?? claimed.job?.id;
  if (!jobId) throw new Error("Job was not claimed.");
}
console.log("running", jobId);

const form = new FormData();
form.append("label", label);
form.append(
  "prompt",
  `Layered v3 composition: AI Neon scene, AI Tux subject cutout, authored ink frame with a true art window, ${PLAIN ? "a plain material edge with no holographic layer" : "an AI holographic edge effect"} and exact code-set type. Front and designed back.`,
);
form.append("layers", JSON.stringify(layers));
for (const [field, upload] of uploadFiles) form.append(field, upload);

const uploaded = await api(`/api/v1/admin/art/jobs/${jobId}/candidates`, {
  method: "POST",
  form,
});
const candidate = uploaded.candidate;
if (!candidate?.id) throw new Error("Candidate upload returned no id.");
console.log("candidate", candidate.id, candidate.width, candidate.height);

await api(`/api/v1/admin/art/jobs/${jobId}/complete`, {
  method: "POST",
  body: {
    actualCostCents: 0,
    costSource: "runner_recorded",
    note: "Layer images generated in the operator session; no provider call in this job.",
  },
});
console.log("job completed");

if (REFRESH) {
  await api(`/api/v1/admin/art/approvals/${APPROVAL_ID}/rollback`, { method: "POST" });
  console.log("rolled back", APPROVAL_ID);
}

await api(`/api/v1/admin/art/candidates/${candidate.id}/approve`, {
  method: "POST",
  body: {
    usage:
      "Tux Holographic member and public cabinet render. Layered v3 breakout front with a designed back.",
    notes:
      "Inspected at 750, 400, 214 and 128. Subject breaks the frame, exact type is code-set, back is a record.",
  },
});
console.log("approved");

const published = await api(`/api/v1/admin/art/candidates/${candidate.id}/publish`, {
  method: "POST",
  body: {
    confirmation: "PUBLISH",
    variantId: VARIANT_ID,
    publishBack: true,
    notes:
      "Replaces the flat Holographic render with the layered v3 object. Previous front/back retained for rollback.",
  },
});
console.log("published", JSON.stringify({ candidateId: candidate.id, variantId: VARIANT_ID }));
console.log(JSON.stringify(published.publication ?? {}, null, 2).slice(0, 1200));
