#!/usr/bin/env node
/**
 * Foilbury Art Lab runner.
 *
 * The browser queues a bounded job. This local worker claims one job at a time,
 * prepares the real-source information sheet, calls exactly the recorded
 * provider/model, uploads the real bytes and records what it observed. It never
 * falls back to another provider and never tops up a budget.
 *
 * Whole-card AI is the production card method. The reference sheet is prepared
 * from the real subject art, the supplied collection mark, the current live card
 * and the exact copy. GPT Image 2.6 Sunburst and the top FAL models receive that
 * sheet as an image reference. The shared renderer is retained only as a
 * comparison method.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { hasLivery } from "../art/card-render.mjs";
import { composeCard, composeCardBack } from "../art/compose.mjs";
import { accessHeaders, agentToken, apiForm, apiJson, BASE_URL, ensureServer } from "./lib/api.mjs";

// A developer shell can contain a stale key. The project's `.env` is the
// authoritative local provider configuration for this operator script, so parse
// it explicitly and prefer it over inherited process env.
const projectEnv = dotenv.config({ processEnv: {} }).parsed ?? {};
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Number(limitArg?.split("=")[1] ?? 1) || 1);
const jobArg = process.argv.find((arg) => arg.startsWith("--job="));
const requestedJob = jobArg?.split("=")[1]?.trim() || undefined;
const presentations = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/data/collection-presentations.json"), "utf8"),
);
const livery = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src/data/collection-livery.json"), "utf8"),
);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "foilbury-art-lab-"));
const fontFiles = [
  "art/fonts/card/Fraunces-SemiBold.ttf",
  "art/fonts/card/Fraunces-Bold.ttf",
  "art/fonts/card/Manrope-Regular.ttf",
  "art/fonts/card/Manrope-SemiBold.ttf",
  "art/fonts/card/Manrope-Bold.ttf",
  "art/fonts/IBMPlexMono-Regular.ttf",
  "art/fonts/IBMPlexMono-SemiBold.ttf",
].map((file) => path.join(process.cwd(), file));
let generated = 0;
let failed = 0;

function log(message) {
  console.log(message);
}

function providerKey(provider) {
  const envKey =
    provider === "fal"
      ? projectEnv.FAL_AI_API_KEY?.trim()
      : provider === "openai"
        ? projectEnv.OPENAI_API_KEY?.trim()
        : "";
  if (envKey) return envKey;
  return provider === "fal"
    ? (process.env.FAL_AI_API_KEY?.trim() ?? "")
    : provider === "openai"
      ? (process.env.OPENAI_API_KEY?.trim() ?? "")
      : "";
}

async function binaryGet(route) {
  const response = await fetch(`${BASE_URL}${route}`, {
    headers: { authorization: `Bearer ${agentToken()}`, ...accessHeaders() },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${route}: ${text.slice(0, 400)}`);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get("content-type") ?? "image/png",
  };
}

function aspectFor(run) {
  if (run.brief.category !== "cards") {
    return ["banners", "og_images"].includes(run.brief.category) ? "16:9" : "1:1";
  }
  return "3:4";
}

function finishLabel(variant) {
  const material = variant?.material_key ?? "plain";
  if (
    material === "diamond" ||
    material === "holographic" ||
    variant?.effect_key === "holographic"
  ) {
    return "HOLOGRAPHIC";
  }
  return material.toUpperCase();
}

function cardCopy(run) {
  const provenance =
    run.brief.audience === "public"
      ? "PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT"
      : "MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL";
  return {
    name: run.card?.name ?? run.brief.title,
    role: run.card?.subtitle ?? run.card?.class?.name ?? "Member subject",
    collection: run.collection?.name ?? "Foilbury",
    rarity: (run.card?.rarity?.name ?? "RARE").toUpperCase(),
    finish: finishLabel(run.variant),
    code: run.catalogue_code ?? "FB-ART-001",
    provenance,
  };
}

const STYLE_LABELS = {
  atelier: "Atelier",
  cinematic: "Cinematic",
  editorial: "Editorial",
  archive: "Archive",
  manga: "Manga",
  minimal: "Minimal",
};

function styleLabel(key) {
  return key ? (STYLE_LABELS[key] ?? key) : null;
}

/**
 * One provider call with the same prompt produces near-identical cards. Every
 * candidate in a run gets a distinct composition directive so the contact sheet
 * is a real choice, not four versions of the same picture. The exact copy, the
 * subject identity and the card contract never change.
 */
const WHOLE_CARD_VARIATIONS = [
  {
    label: "Centered hero",
    direction:
      "a centered full-figure hero shot at eye level, the environment visible around the subject, an open confident pose, balanced negative space.",
  },
  {
    label: "Low angle",
    direction:
      "a dramatic low-angle three-quarter shot, subject offset to one side, strong foreground weather or reflections, bolder negative space.",
  },
  {
    label: "Close crop",
    direction:
      "a tighter bust or three-quarter crop, the face and signature prop prominent, shallow depth of field, the information band still fully readable.",
  },
  {
    label: "Wide scene",
    direction:
      "a wide environmental shot with the subject smaller in the frame, the place carrying the mood, one clear focal light and a calm composition.",
  },
  {
    label: "Graphic",
    direction:
      "a graphic poster-like composition with a strong diagonal, a high-contrast shape behind the subject and minimal background detail.",
  },
  {
    label: "Editorial",
    direction:
      "an editorial studio-meets-street portrait, subject turned away from the camera, clean rim light and a restrained palette.",
  },
];

function variationFor(index) {
  return WHOLE_CARD_VARIATIONS[index % WHOLE_CARD_VARIATIONS.length];
}

const SCENE_VARIATIONS = [
  {
    label: "Establishing",
    direction:
      "a wide establishing view with deep space, a low horizon and one clear focal light; leave room for the subject cutout and the information band.",
  },
  {
    label: "Low angle",
    direction:
      "a low-angle view looking up through the environment, strong foreground weather and a dramatic sky; keep the centre calm for the subject.",
  },
  {
    label: "Environmental detail",
    direction:
      "a closer environmental detail with layered foreground/midground/background and strong texture; the subject will sit against the midground.",
  },
  {
    label: "Graphic",
    direction:
      "a graphic, high-contrast environmental plate with one bold diagonal shape and restrained detail; the subject will be the only complex silhouette.",
  },
];

function sceneVariationFor(index) {
  return SCENE_VARIATIONS[index % SCENE_VARIATIONS.length];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(value, max) {
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!word) continue;
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= max) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function dataUri(buffer, mime = "image/png") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function buildReferenceSheet(run) {
  if (run.brief.category !== "cards") return null;
  if (!run.card || !run.collection) {
    throw new Error("The card brief is missing its subject or collection.");
  }
  const subjectAssetId = run.source_assets?.subject_asset_id;
  if (!subjectAssetId) {
    throw new Error("The target edition has no real subject art for the reference sheet.");
  }
  const subject = await binaryGet(`/api/v1/admin/assets/${subjectAssetId}/bytes`);
  const mark = run.source_assets?.logo_asset_id
    ? await binaryGet(`/api/v1/admin/assets/${run.source_assets.logo_asset_id}/bytes`)
    : null;
  const current = run.current_render_url
    ? await binaryGet(run.current_render_url).catch(() => null)
    : null;
  const subjectPng = await sharp(subject.bytes)
    .resize(600, 900, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  const markPng = mark
    ? await sharp(mark.bytes)
        .resize(250, 130, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer()
    : null;
  const currentPng = current
    ? await sharp(current.bytes).resize(250, 350, { fit: "contain" }).png().toBuffer()
    : null;
  const copy = cardCopy(run);
  const chosenStyle = styleLabel(run.job.style_key);
  const accent = run.collection?.accent ?? livery[run.collection?.slug]?.accent ?? "#1f5eff";
  const paper = "#fafaf8";
  const ink = "#0a0a0a";
  const graphite = "#5b5b57";
  const rule = "#e4e4df";
  const foil = "#1f5eff";
  const nameLines = wrap(copy.name, 18).slice(0, 2);
  const roleLines = wrap(copy.role, 30).slice(0, 3);
  const collectionLines = wrap(copy.collection, 32).slice(0, 3);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1960" viewBox="0 0 1400 1960">
  <rect width="1400" height="1960" fill="${paper}"/>
  <rect x="0" y="0" width="1400" height="14" fill="${ink}"/>
  <text x="60" y="62" font-family="IBM Plex Mono" font-size="22" letter-spacing="4" fill="${ink}">FOILBURY · CARD REFERENCE</text>
  <text x="60" y="92" font-family="IBM Plex Mono" font-size="16" letter-spacing="1.5" fill="${graphite}">NOT THE FINAL CARD · USE FOR IDENTITY, MARK AND EXACT COPY</text>
  <line x1="60" y1="116" x2="1340" y2="116" stroke="${rule}" stroke-width="1"/>

  <rect x="60" y="150" width="650" height="1000" fill="#111111"/>
  <rect x="60" y="150" width="650" height="1000" fill="none" stroke="${accent}" stroke-width="3"/>
  <image x="85" y="175" width="600" height="900" href="${dataUri(subjectPng)}" preserveAspectRatio="xMidYMid meet"/>
  <text x="82" y="1140" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">REAL SUBJECT ART · KEEP FACE, HAIR, OUTFIT AND PROPS</text>

  <rect x="750" y="150" width="590" height="1000" fill="#ffffff" stroke="${rule}" stroke-width="1"/>
  <text x="780" y="188" font-family="IBM Plex Mono" font-size="16" letter-spacing="2" fill="${graphite}">SUPPLIED COLLECTION MARK</text>
  ${markPng ? `<image x="1040" y="165" width="270" height="140" href="${dataUri(markPng)}" preserveAspectRatio="xMidYMid meet"/>` : `<text x="1040" y="230" font-family="IBM Plex Mono" font-size="16" fill="${graphite}">no mark supplied</text>`}
  <line x1="780" y1="318" x2="1310" y2="318" stroke="${rule}" stroke-width="1"/>

  <text x="780" y="360" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">NAME</text>
  ${nameLines.map((line, index) => `<text x="780" y="${414 + index * 68}" font-family="Fraunces" font-weight="600" font-size="62" fill="${ink}">${escapeXml(line)}</text>`).join("")}
  <text x="780" y="530" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">ROLE</text>
  ${roleLines.map((line, index) => `<text x="780" y="${566 + index * 32}" font-family="Manrope" font-size="28" fill="${ink}">${escapeXml(line)}</text>`).join("")}
  <text x="780" y="690" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">COLLECTION</text>
  ${collectionLines.map((line, index) => `<text x="780" y="${726 + index * 28}" font-family="Manrope" font-size="24" fill="${ink}">${escapeXml(line)}</text>`).join("")}
  <text x="780" y="838" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">RARITY / FINISH</text>
  <text x="780" y="878" font-family="Manrope" font-weight="600" font-size="28" fill="${ink}">${escapeXml(`${copy.rarity} · ${copy.finish}`)}</text>
  <text x="780" y="936" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">PRINT CODE</text>
  <text x="780" y="974" font-family="IBM Plex Mono" font-size="22" fill="${ink}">${escapeXml(copy.code)}</text>
  ${
    chosenStyle
      ? `<text x="780" y="790" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">STYLE</text>
  <text x="780" y="826" font-family="Manrope" font-weight="600" font-size="28" fill="${ink}">${escapeXml(chosenStyle)}</text>`
      : ""
  }
  <text x="780" y="1030" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">PROVENANCE</text>
  <text x="780" y="1064" font-family="IBM Plex Mono" font-size="16" fill="${ink}">${escapeXml(copy.provenance)}</text>
  <text x="780" y="1110" font-family="Manrope" font-weight="600" font-size="18" fill="${foil}">USE EXACTLY THESE WORDS. NO OTHER TEXT.</text>

  ${
    currentPng
      ? `<text x="750" y="1200" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">CURRENT LIVE CARD · LAYOUT REFERENCE</text>
  <image x="750" y="1218" width="250" height="350" href="${dataUri(currentPng)}" preserveAspectRatio="xMidYMid meet"/>`
      : ""
  }
  <text x="1040" y="1218" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${graphite}">PALETTE</text>
  <rect x="1040" y="1240" width="90" height="90" fill="${paper}" stroke="${rule}"/>
  <rect x="1140" y="1240" width="90" height="90" fill="${ink}"/>
  <rect x="1240" y="1240" width="90" height="90" fill="${foil}"/>
  <rect x="1040" y="1340" width="90" height="90" fill="${accent}"/>
  <text x="1040" y="1468" font-family="IBM Plex Mono" font-size="14" fill="${graphite}">PAPER · INK · FOIL BLUE · COLLECTION</text>

  <rect x="60" y="1700" width="1280" height="200" fill="${ink}"/>
  <text x="90" y="1745" font-family="IBM Plex Mono" font-size="18" letter-spacing="3" fill="${paper}">THE FINISHED OBJECT</text>
  <text x="90" y="1795" font-family="Manrope" font-size="30" fill="${paper}">One 5:7 collectible card. Designed frame. Reserved information band.</text>
  <text x="90" y="1840" font-family="Manrope" font-size="24" fill="${paper}">Name, rarity and print code readable at 214 × 300. Real subject. Supplied mark. Exact copy.</text>
  <text x="90" y="1878" font-family="IBM Plex Mono" font-size="15" letter-spacing="2" fill="${foil}">NO POSTER · NO MOOD BOARD · NO GIBBERISH · NO INVENTED LOGOS</text>
  </svg>`;

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1400 },
    font: {
      fontFiles,
      loadSystemFonts: false,
      defaultFontFamily: "Manrope",
    },
  });
  const png = resvg.render().asPng();
  const jpeg = await sharp(png)
    .resize(1024, 1434, { fit: "fill" })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { jpeg, png, copy };
}

async function callProvider(run, index, prompt, reference) {
  const { provider, model } = run.job;
  const key = providerKey(provider);
  if (!key) {
    throw new Error(
      `Missing ${provider === "fal" ? "FAL_AI_API_KEY" : "OPENAI_API_KEY"}. No provider call was made.`,
    );
  }
  const seed = Math.floor(Date.now() / 1000) + index;
  if (provider === "openai") {
    if (reference) {
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("n", "1");
      form.append("size", "1024x1536");
      form.append(
        "image",
        new Blob([reference], { type: "image/jpeg" }),
        "foilbury-card-reference.jpg",
      );
      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI ${model} edit failed (${response.status}): ${text.slice(0, 700)}`);
      }
      return parseOpenAIImage(await response.json(), seed, model);
    }
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: "1024x1536",
        output_format: "png",
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI ${model} failed (${response.status}): ${text.slice(0, 700)}`);
    }
    return parseOpenAIImage(await response.json(), seed, model);
  }
  if (provider === "fal") {
    const isSeedream = model.includes("seedream");
    const body = {
      prompt,
      num_images: 1,
      seed,
      ...(isSeedream
        ? { image_size: "portrait_4_3" }
        : {
            aspect_ratio: aspectFor(run),
            output_format: "png",
            enable_safety_checker: true,
          }),
    };
    if (reference && run.price?.supports_reference) {
      const uri = dataUri(reference, "image/jpeg");
      if (run.price.reference_param === "image_urls") {
        body.image_urls = [uri];
      } else {
        body.image_url = uri;
        body.image_prompt_strength = 0.65;
      }
    }
    const response = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: {
        authorization: `Key ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FAL ${model} failed (${response.status}): ${text.slice(0, 700)}`);
    }
    const payload = await response.json();
    const url = payload?.images?.[0]?.url ?? payload?.image?.url;
    if (!url) throw new Error(`FAL ${model} returned no image URL.`);
    const image = await fetch(url);
    if (!image.ok) throw new Error(`FAL output download failed (${image.status}).`);
    return {
      bytes: Buffer.from(await image.arrayBuffer()),
      seed: String(seed),
      provider: "fal",
      model,
    };
  }
  throw new Error(`No runner adapter exists for provider "${provider}".`);
}

function parseOpenAIImage(payload, seed, model) {
  const entry = payload?.data?.[0];
  if (entry?.b64_json) {
    return {
      bytes: Buffer.from(entry.b64_json, "base64"),
      seed: String(seed),
      provider: "openai",
      model,
    };
  }
  if (entry?.url) {
    return fetch(entry.url).then(async (image) => {
      if (!image.ok) throw new Error(`OpenAI output download failed (${image.status}).`);
      return {
        bytes: Buffer.from(await image.arrayBuffer()),
        seed: String(seed),
        provider: "openai",
        model,
      };
    });
  }
  throw new Error(`OpenAI ${model} returned no image data.`);
}

async function cardSizes(raw) {
  const master = await sharp(raw)
    .resize(1500, 2100, { fit: "cover", position: "attention" })
    .png()
    .toBuffer();
  const front = await sharp(master).resize(750, 1050).webp({ quality: 92, effort: 5 }).toBuffer();
  const preview400 = await sharp(master).resize(400, 560).webp({ quality: 90 }).toBuffer();
  const thumb128 = await sharp(master).resize(128, 179).webp({ quality: 88 }).toBuffer();
  return { master, front, preview400, thumb128 };
}

function ensureRunData(run) {
  if (run.brief.category !== "cards") return;
  if (!run.card || !run.collection) {
    throw new Error("The card brief is missing its subject or collection.");
  }
  if (!run.variant) {
    throw new Error(
      "The card brief has no target variant. Pick a finish variant on the brief before generating.",
    );
  }
}

async function compose(run, rawScene) {
  ensureRunData(run);
  const presentation = presentations[run.collection.slug] ?? {};
  const subjectAssetId = run.source_assets?.subject_asset_id;
  const logoAssetId = run.source_assets?.logo_asset_id;
  if (!subjectAssetId) {
    throw new Error("The target edition has no subject asset to compose.");
  }
  const subject = await binaryGet(`/api/v1/admin/assets/${subjectAssetId}/bytes`);
  const subjectPath = path.join(tmpDir, `subject-${run.job.id}-${Date.now()}.png`);
  fs.writeFileSync(subjectPath, subject.bytes);
  const scenePath = path.join(tmpDir, `scene-${run.job.id}-${Date.now()}.png`);
  fs.writeFileSync(scenePath, rawScene);
  const mark = logoAssetId ? await binaryGet(`/api/v1/admin/assets/${logoAssetId}/bytes`) : null;
  const composition =
    run.edition?.composition_json &&
    (() => {
      try {
        return JSON.parse(run.edition.composition_json);
      } catch {
        return null;
      }
    })();
  const audience = run.brief.audience;
  const cardInput = {
    subjectPath,
    subjectOverride: true,
    backgroundPath: scenePath,
    backgroundOverride: true,
    material: run.variant.material_key,
    effect: run.variant.effect_key ?? "none",
    styleKey: run.brief.styles?.[0] ?? "",
    name: run.card.name,
    subtitle: run.card.subtitle ?? "",
    setName: presentation.cardSetName ?? run.collection.name ?? "Cabinet",
    serial: audience === "public" ? "PUBLIC SHOWCASE" : "MEMBER EDITION",
    className: run.card.class?.name ?? "",
    rarity: run.card.rarity?.name ?? "",
    composition,
    collectionTheme: presentation.theme ?? "",
    collectionSlug: run.collection.slug,
    cardSlug: run.card.slug,
    catalogueCode: run.catalogue_code ?? undefined,
    bio: run.card.bio_safe ?? run.card.description ?? "",
    edition: "Member archive · First printing",
    provenance:
      audience === "public"
        ? "PUBLIC SHOWCASE · ORIGINAL FOILBURY PROJECT"
        : "MEMBER ARCHIVE · THIRD-PARTY ART · NOT OFFICIAL",
    provenanceLong:
      "Provider-generated scene. Card composed by the shared Foilbury renderer. Not official or licensed third-party artwork.",
    markPlate: presentation.markPlate,
    markInvert: presentation.markInvert ?? false,
    markBuffer: mark?.bytes,
    markMime: mark?.mime,
    returnBytes: true,
  };
  const front = await composeCard(cardInput);
  const back = hasLivery(run.collection.slug) ? await composeCardBack(cardInput) : null;
  const material = run.variant.material_key;
  const theme = presentation.theme ?? "";
  const styleKey = run.job.style_key ?? run.brief.styles?.[0] ?? "";
  const frameName = theme ? `frame-${theme}-${material}.png` : `frame-${material}.png`;
  const aiEffect = styleKey ? `ai/${styleKey}-holo.png` : null;
  const layers = [
    { key: "scene", label: "AI scene", source: "provider", kind: "ai" },
    {
      key: "subject",
      label: "Real subject art",
      source: "sourced",
      kind: "sourced",
      asset_id: subjectAssetId,
    },
    {
      key: "material",
      label: `${material} material`,
      path: `/art/layers/material-${material}.png`,
      blend: material === "silver" ? "overlay" : material === "diamond" ? "screen" : "soft-light",
      kind: "authored",
    },
    {
      key: "frame",
      label: "Card frame",
      path: `/art/layers/${frameName}`,
      blend: "over",
      kind: "authored",
    },
    ...(aiEffect && (material === "diamond" || run.variant.effect_key === "holographic")
      ? [
          {
            key: "effect",
            label: "AI holographic effect",
            path: `/art/layers/${aiEffect}`,
            blend: "screen",
            opacity: 0.34,
            kind: "ai",
          },
        ]
      : []),
    { key: "type", label: "Exact code type", source: "code", kind: "code" },
  ];
  return {
    front: front.buffer ?? front,
    master: front.masterPng,
    back: back?.buffer ?? back ?? null,
    layers,
  };
}

async function uploadCandidate(run, raw, extra, index) {
  const form = new FormData();
  form.append("raw", new Blob([raw]), `raw-${index + 1}`);
  if (extra?.front) {
    form.append(
      "front",
      new Blob([extra.front], { type: "image/webp" }),
      `front-${index + 1}.webp`,
    );
  }
  if (extra?.back) {
    form.append("back", new Blob([extra.back], { type: "image/webp" }), `back-${index + 1}.webp`);
  }
  if (extra?.master) {
    form.append(
      "master",
      new Blob([extra.master], { type: "image/png" }),
      `master-${index + 1}.png`,
    );
  }
  if (extra?.preview400) {
    form.append(
      "preview400",
      new Blob([extra.preview400], { type: "image/webp" }),
      `preview-${index + 1}.webp`,
    );
  }
  if (extra?.thumb128) {
    form.append(
      "thumb128",
      new Blob([extra.thumb128], { type: "image/webp" }),
      `thumb-${index + 1}.webp`,
    );
  }
  if (extra?.reference) {
    form.append(
      "reference",
      new Blob([extra.reference], { type: "image/jpeg" }),
      `reference-${index + 1}.jpg`,
    );
  }
  if (extra?.prompt) form.append("prompt", extra.prompt);
  if (extra?.label) form.append("label", extra.label);
  form.append("seed", String(extra?.seed ?? ""));
  if (extra?.layers) form.append("layers", JSON.stringify(extra.layers));
  return apiForm(`/api/v1/admin/art/jobs/${run.job.id}/candidates`, form);
}

async function processJob(run, counters) {
  log(
    `Claimed ${run.job.id}: ${run.brief.title} · ${run.job.method} · ${run.job.count} candidate(s)`,
  );
  let reference = null;
  let prompt = run.job.prompt;
  try {
    if (run.job.method === "whole_card" && run.brief.category === "cards") {
      const sheet = await buildReferenceSheet(run);
      reference = sheet.jpeg;
      prompt = `${prompt}\n\nThe attached reference sheet contains the real subject art, the supplied collection mark, the current live card and the exact copy. Use it as source material. Create a new finished card; do not reproduce the reference-board layout.`;
      log("  prepared real-source reference sheet");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await apiJson(`/api/v1/admin/art/jobs/${run.job.id}/fail`, {
      method: "POST",
      body: { message, actualCostCents: 0 },
    }).catch(() => undefined);
    log(`  failed before provider call: ${message}`);
    return;
  }
  for (let index = 0; index < run.job.count; index += 1) {
    let attempted = false;
    try {
      const key = providerKey(run.job.provider);
      if (!key) {
        throw new Error(
          `Missing ${run.job.provider === "fal" ? "FAL_AI_API_KEY" : "OPENAI_API_KEY"}. No provider call was made.`,
        );
      }
      attempted = true;
      const variation =
        run.brief.category === "cards"
          ? run.job.method === "whole_card"
            ? variationFor(index)
            : run.job.method === "composed_scene"
              ? sceneVariationFor(index)
              : null
          : null;
      const candidatePrompt = variation
        ? `${prompt}

VARIATION ${index + 1} of ${run.job.count} — ${variation.label}: ${variation.direction} Keep the exact copy, the subject identity, the supplied mark and the card contract unchanged. This composition must be visibly different from the other candidates in this run.`
        : prompt;
      const result = await callProvider(run, index, candidatePrompt, reference);
      counters.generated += 1;
      if (run.job.method === "whole_card") {
        const sizes = await cardSizes(result.bytes);
        await uploadCandidate(
          run,
          result.bytes,
          {
            ...sizes,
            seed: result.seed,
            reference,
            prompt: candidatePrompt,
            label: variation ? `Candidate ${index + 1} · ${variation.label}` : undefined,
          },
          index,
        );
      } else if (run.job.method === "raw_art") {
        await uploadCandidate(run, result.bytes, { seed: result.seed, prompt }, index);
      } else {
        const composed = await compose(run, result.bytes);
        const sizes = await cardSizes(composed.front);
        await uploadCandidate(
          run,
          result.bytes,
          {
            front: composed.front,
            back: composed.back,
            master: composed.master ?? sizes.master,
            preview400: sizes.preview400,
            thumb128: sizes.thumb128,
            seed: result.seed,
            prompt: candidatePrompt,
            label: variation ? `Candidate ${index + 1} · ${variation.label}` : undefined,
            layers: composed.layers,
          },
          index,
        );
      }
      log(`  candidate ${index + 1} uploaded`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const unit = run.price?.unit_cents ?? 0;
      const actual = unit * Math.max(counters.generated, attempted ? 1 : 0);
      await apiJson(`/api/v1/admin/art/jobs/${run.job.id}/fail`, {
        method: "POST",
        body: { message, actualCostCents: actual },
      }).catch(() => undefined);
      log(`  failed: ${message}`);
      return;
    }
  }
  const unit = run.price?.unit_cents ?? 0;
  await apiJson(`/api/v1/admin/art/jobs/${run.job.id}/complete`, {
    method: "POST",
    body: {
      actualCostCents: unit * counters.generated,
      costSource: "price_table",
      note: `${counters.generated} candidate(s) generated by scripts/art-lab-runner.mjs.`,
    },
  });
  log(
    `Completed ${run.job.id}: ${counters.generated} candidate(s), recorded US$${((unit * counters.generated) / 100).toFixed(2)}.`,
  );
}

async function main() {
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL)) await ensureServer();
  if (dryRun) {
    const exportData = await apiJson("/api/v1/admin/art/agent?limit=20");
    const queued = [];
    for (const brief of exportData.briefs ?? []) {
      for (const job of brief.jobs ?? []) {
        if (job.status === "queued") queued.push({ brief, job });
      }
    }
    if (!queued.length) {
      log("No queued Art Lab jobs.");
      return;
    }
    for (const entry of queued.slice(0, limit)) {
      log(
        `\n${entry.brief.brief.title} · ${entry.job.method} · ${entry.job.provider}/${entry.job.model}`,
      );
      log(entry.job.prompt);
    }
    return;
  }
  for (let index = 0; index < limit; index += 1) {
    const claimed = await apiJson("/api/v1/admin/art/jobs/claim", {
      method: "POST",
      body: requestedJob && index === 0 ? { jobId: requestedJob } : {},
    });
    const run = claimed.job;
    if (!run) {
      log("No queued Art Lab jobs.");
      break;
    }
    const counters = { generated: 0 };
    await processJob(run, counters);
  }
}

try {
  await main();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
