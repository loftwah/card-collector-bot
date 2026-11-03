#!/usr/bin/env node
/**
 * Provision reviewed original-IP prints through the supported local admin API.
 *
 *   node scripts/art/provision-print-set.mjs --only=tux/01-rooftop-relay
 *   node scripts/art/provision-print-set.mjs
 *
 * The script is resumable: it reuses an existing proposal or edition by name,
 * submits/approves/link only the missing step, and never rewrites an existing
 * edition, variant, award or serial. Production use must follow the
 * backup/approval path in AGENTS.md.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { apiForm, apiJson, ensureServer } from "../lib/api.mjs";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1] ?? null;
const skipPool = args.has("--skip-pool");
const skipQueue = args.has("--skip-queue");
const plan = JSON.parse(fs.readFileSync(path.join(root, ".foilbury/content/print-set.json"), "utf8"));
const selections = JSON.parse(
  fs.readFileSync(path.join(root, ".foilbury/content/print-selections.json"), "utf8"),
);

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function upload(kind, filePath, name, fields) {
  const form = new FormData();
  const ext = path.extname(filePath);
  form.append(
    "file",
    new Blob([fs.readFileSync(filePath)], {
      type: ext === ".png" ? "image/png" : "image/jpeg",
    }),
    `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}${ext}`,
  );
  form.append("kind", kind);
  form.append("name", name);
  form.append("access", "member");
  form.append("reviewStatus", "approved");
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  return (await apiForm("/api/v1/admin/assets", form)).asset;
}

const cards = (await apiJson("/api/v1/admin/cards?limit=300")).items;
const summary = { created: [], skipped: [], pool: null, queued: null };

await ensureServer();

for (const selection of selections.prints) {
  const key = `${selection.subject}/${selection.print}`;
  if (only && key !== only) continue;
  const subject = plan.subjects.find((item) => item.slug === selection.subject);
  if (!subject) throw new Error(`Unknown subject ${selection.subject}`);
  const print = subject.prints.find(
    (item) => `${item.print_number}-${slugify(item.title)}` === selection.print,
  );
  if (!print) throw new Error(`Unknown print ${key}`);
  const card = cards.find((item) => item.slug === subject.card_slug);
  if (!card) throw new Error(`Card ${subject.card_slug} is not in this catalogue.`);
  const editionName = `${card.name} — ${print.title}`;
  const proposalTitle = `${card.name} · ${print.title}`;

  let proposals = (await apiJson(`/api/v1/admin/cards/${card.id}/prints`)).items;
  let proposal = proposals.find((item) => item.title === proposalTitle);
  if (proposal?.approved_edition) {
    summary.skipped.push({ key, reason: "proposal already linked" });
    continue;
  }

  const dir = path.join(root, ".foilbury/generated/prints", subject.slug, selection.print);
  const artworkPath = path.join(dir, `candidate-${selection.candidate}.png`);
  if (!fs.existsSync(artworkPath)) throw new Error(`Missing selected artwork ${artworkPath}`);
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, `candidate-${selection.candidate}.json`), "utf8"),
  );
  const backgroundPath = path.join(dir, "background.jpg");
  if (!fs.existsSync(backgroundPath)) {
    await sharp(artworkPath)
      .resize(750, 1050, { fit: "cover", position: "attention" })
      .blur(24)
      .modulate({ brightness: 0.42, saturation: 0.72 })
      .jpeg({ quality: 86 })
      .toFile(backgroundPath);
  }

  const provenance = {
    note: "Original Foilbury character. AI-assisted alternate print generated from the reviewed identity reference, then visually reviewed by the agent under delegated authority.",
    provider: "fal.ai",
    endpoint: meta.endpoint,
    request_id: meta.request_id ?? null,
    prompt_sha256: meta.prompt_sha256 ?? null,
    reference_sha256: meta.reference_sha256 ?? null,
    cost_usd: meta.cost_usd ?? 0.15,
    generated_at: meta.created_at ?? null,
    review: selection.note,
    reviewer: "agent-delegated",
    review_date: selections.reviewed_at,
  };

  let artworkId = proposal?.artwork_asset_id ?? null;
  let backgroundId = null;
  if (!artworkId) {
    const artwork = await upload("subject", artworkPath, `${editionName} · print artwork`, {
      role: print.role,
      provenance,
      credit:
        "Original Foilbury character; AI-assisted print reviewed by agent under delegated authority.",
      sourceRepo: "loftwah/card-collector-bot",
      sourcePath: path.relative(root, artworkPath),
      sourceCommit: plan.source_commit,
    });
    artworkId = artwork.id;
  }
  const background = await upload("background", backgroundPath, `${editionName} · derived background`, {
    provenance: {
      note: "Deterministic blurred/darkened derivative of the reviewed print artwork.",
    },
    sourceRepo: "loftwah/card-collector-bot",
    sourcePath: path.relative(root, backgroundPath),
    sourceCommit: plan.source_commit,
  });
  backgroundId = background.id;

  if (!proposal) {
    const source =
      card.editions.find((item) => item.name.toLowerCase().includes("source edition")) ??
      card.editions[0];
    proposal = (
      await apiJson(`/api/v1/admin/cards/${card.id}/prints`, {
        method: "POST",
        body: {
          printNumber: print.print_number,
          role: print.role,
          title: proposalTitle,
          creativeDirection: `${print.prompt}\n\nReviewed note: ${selection.note}`,
          sourceAssetId: source.subject_asset_id,
          artworkAssetId: artworkId,
          rightsNote:
            "Original Foilbury character and original composition. Not official artwork for any third-party property.",
          sourceRefs: [
            "https://fal.ai/models/fal-ai/nano-banana-pro/edit",
            "https://foilbury.loftwah.com/brand-kit",
          ],
          provenance: {
            print_set: "original-ip-second-print",
            review_note: selection.note,
            generation: provenance,
          },
          finishKeys: ["plain", "silver", "gold", "holographic"],
          status: "proposed",
        },
      })
    ).proposal;
  }
  if (proposal.status === "draft") {
    proposal = (
      await apiJson(`/api/v1/admin/prints/${proposal.id}/submit`, {
        method: "POST",
        body: { expectedRevision: proposal.revision, note: "Submitted from the delegated print run." },
      })
    ).proposal;
  }
  if (proposal.status === "proposed") {
    proposal = (
      await apiJson(`/api/v1/admin/prints/${proposal.id}/review`, {
        method: "POST",
        body: {
          decision: "approved",
          expectedRevision: proposal.revision,
          note: `Agent review under delegated authority: ${selection.note}`,
        },
      })
    ).proposal;
  }
  if (proposal.status !== "approved") {
    throw new Error(`Print ${key} is ${proposal.status}; it cannot be linked.`);
  }

  let edition = cards
    .flatMap((item) => item.editions)
    .find((item) => item.name === editionName);
  if (!edition) {
    const created = await apiJson(`/api/v1/admin/cards/${card.id}/editions`, {
      method: "POST",
      body: {
        name: editionName,
        subjectAssetId: artworkId,
        backgroundAssetId: backgroundId,
        materials: ["plain", "silver", "gold", "diamond"],
        status: "published",
      },
    });
    edition = created.card.editions.find((item) => item.name === editionName);
  }
  if (!edition) throw new Error(`Edition ${editionName} was not returned by the API.`);
  if (!proposal.approved_edition) {
    proposal = (
      await apiJson(`/api/v1/admin/prints/${proposal.id}/link`, {
        method: "POST",
        body: {
          editionId: edition.id,
          expectedRevision: proposal.revision,
        },
      })
    ).proposal;
  }

  summary.created.push({
    key,
    card: card.name,
    edition: edition.name,
    variants: edition.variants.map((variant) => ({
      id: variant.id,
      material_key: variant.material_key,
    })),
    proposal: proposal.id,
    artwork_asset_id: artworkId,
  });
  console.log(`OK ${key} · ${edition.name} · ${edition.variants.length} finishes`);
}

if (!skipPool && summary.created.length) {
  const entries = [];
  for (const item of summary.created) {
    for (const variant of item.variants) {
      const weight =
        variant.material_key === "plain"
          ? 100
          : variant.material_key === "silver"
            ? 30
            : variant.material_key === "gold"
              ? 10
              : 3;
      entries.push({ variantId: variant.id, weight });
    }
  }
  const pools = (await apiJson("/api/v1/admin/pools")).items;
  const existing = pools.find((pool) => pool.slug === "second-print-capsule");
  if (!existing) {
    const pool = await apiJson("/api/v1/admin/pools", {
      method: "POST",
      body: {
        slug: "second-print-capsule",
        name: "Second Print — Original IP",
        description:
          "Alternate prints of Tux, Gabe and Drop Bear. Each copy is a different artwork edition, not a finish recolour. Real odds are shown before opening.",
        price: 80,
        entries,
      },
    });
    await apiJson(`/api/v1/admin/pools/${pool.pool.id}/publish`, { method: "POST", body: {} });
    summary.pool = { id: pool.pool.id, slug: pool.pool.slug, entries: entries.length };
    console.log(`OK pool second-print-capsule · ${entries.length} entries`);
  } else {
    summary.pool = { id: existing.id, slug: existing.slug, entries: existing.entry_count ?? null, existing: true };
    console.log("SKIP pool second-print-capsule already exists");
  }
}

if (!skipQueue) {
  const queued = await apiJson("/api/v1/admin/renders/queue", { method: "POST", body: {} });
  summary.queued = queued;
}
console.log(JSON.stringify(summary, null, 2));
fs.mkdirSync(path.join(root, ".foilbury/evidence"), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(root, ".foilbury/evidence/print-provision.json"),
  JSON.stringify(summary, null, 2),
  { mode: 0o600 },
);
