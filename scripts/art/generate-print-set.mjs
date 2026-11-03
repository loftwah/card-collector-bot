#!/usr/bin/env node
/**
 * Bounded, resumable fal.ai print-generation runner.
 *
 *   node scripts/art/generate-print-set.mjs --dry-run
 *   node scripts/art/generate-print-set.mjs
 *   node scripts/art/generate-print-set.mjs --only=tux
 *
 * The plan lives in `.foilbury/content/print-set.json`. Source references and
 * generated candidates stay private under `.foilbury/`. Every submission is
 * recorded in `.foilbury/evidence/art-budget-ledger.json` before dispatch, and
 * the script refuses to exceed the plan's budget cap. A completed candidate is
 * never resubmitted on a later run. No key is printed or written to evidence.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const planPath = path.join(root, ".foilbury/content/print-set.json");
const ledgerPath = path.join(root, ".foilbury/evidence/art-budget-ledger.json");
const outputRoot = path.join(root, ".foilbury/generated/prints");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1] : null;
const candidatesArg = process.argv.find((arg) => arg.startsWith("--candidates="));
const candidateLimit = candidatesArg ? Math.max(1, Number(candidatesArg.split("=")[1])) : null;

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function readLedger() {
  if (!fs.existsSync(ledgerPath)) {
    return {
      schema: 1,
      currency: "USD",
      cap_usd: plan.budget_cap_usd,
      entries: [],
    };
  }
  return JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

const ledger = readLedger();
ledger.cap_usd = plan.budget_cap_usd;
const spent = () =>
  Math.round(
    ledger.entries
      .filter((entry) => entry.status === "succeeded" || entry.status === "submitted")
      .reduce((sum, entry) => sum + Number(entry.cost_usd ?? 0), 0) * 100,
  ) / 100;

function alreadyGenerated(file) {
  try {
    return fs.statSync(file).size > 1024;
  } catch {
    return false;
  }
}

function dataUri(file) {
  const bytes = fs.readFileSync(file);
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  return { url: `data:${mime};base64,${bytes.toString("base64")}`, sha256: sha256(bytes) };
}

async function submitAndWait({ prompt, referenceUrl, aspectRatio }) {
  const body = {
    prompt,
    image_urls: [referenceUrl],
    num_images: 1,
    aspect_ratio: aspectRatio,
    resolution: plan.provider.resolution,
    output_format: plan.provider.output_format,
    safety_tolerance: plan.provider.safety_tolerance,
  };
  const submit = await fetch(`https://queue.fal.run/${plan.provider.endpoint}`, {
    method: "POST",
    headers: { authorization: `Key ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const submitted = await submit.json().catch(() => ({}));
  if (!submit.ok || !submitted.request_id) {
    throw new Error(`fal submit failed (${submit.status}): ${JSON.stringify(submitted).slice(0, 400)}`);
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
      return { requestId: submitted.request_id, image: output.images[0] };
    }
    if (state.status === "FAILED") {
      throw new Error(`fal job failed: ${JSON.stringify(state).slice(0, 400)}`);
    }
  }
  throw new Error(`fal job ${submitted.request_id} timed out; it may still be queued. Do not blind-retry.`);
}

const selected = plan.subjects.filter((subject) => !only || subject.slug === only);
if (!selected.length) throw new Error(`No subject matches --only=${only}.`);

let generated = 0;
let skipped = 0;
let failed = 0;
for (const subject of selected) {
  const referencePath = path.join(root, subject.reference);
  if (!fs.existsSync(referencePath)) throw new Error(`Missing reference ${subject.reference}`);
  const reference = dataUri(referencePath);
  for (const print of subject.prints) {
    const dir = path.join(outputRoot, subject.slug, `${print.print_number}-${slugify(print.title)}`);
    fs.mkdirSync(dir, { recursive: true });
    const wanted = candidateLimit ? Math.min(candidateLimit, print.candidates) : print.candidates;
    for (let index = 1; index <= wanted; index += 1) {
      const imageFile = path.join(dir, `candidate-${index}.png`);
      const metaFile = path.join(dir, `candidate-${index}.json`);
      if (alreadyGenerated(imageFile) && fs.existsSync(metaFile)) {
        skipped += 1;
        continue;
      }
      const projected = Math.round((spent() + plan.provider.unit_cost_usd) * 100) / 100;
      if (projected > plan.budget_cap_usd) {
        throw new Error(
          `Budget cap reached: spent ${spent().toFixed(2)} USD, next job would reach ${projected.toFixed(2)} USD, cap ${plan.budget_cap_usd.toFixed(2)} USD.`,
        );
      }
      const prompt = `${subject.identity}\n\n${print.prompt}\n\nStrict constraints: original character and original composition; no text, letters, numbers, logos, watermarks, signatures, card frames, borders, UI or captions. Do not add extra limbs, fingers, props or duplicate characters. Keep anatomy coherent and the subject recognisable.`;
      const record = {
        id: crypto.randomUUID(),
        subject: subject.slug,
        card_slug: subject.card_slug,
        print_number: print.print_number,
        role: print.role,
        title: print.title,
        candidate: index,
        endpoint: plan.provider.endpoint,
        resolution: plan.provider.resolution,
        cost_usd: plan.provider.unit_cost_usd,
        prompt_sha256: sha256(prompt),
        reference_sha256: reference.sha256,
        prompt,
        status: "planned",
        created_at: new Date().toISOString(),
      };
      if (dryRun) {
        console.log(`DRY ${subject.slug}/${print.print_number}-${slugify(print.title)} candidate ${index} · $${plan.provider.unit_cost_usd.toFixed(2)} · projected $${projected.toFixed(2)}`);
        continue;
      }
      ledger.entries.push(record);
      writeLedger(ledger);
      try {
        const result = await submitAndWait({
          prompt,
          referenceUrl: reference.url,
          aspectRatio: "3:4",
        });
        const download = await fetch(result.image.url);
        if (!download.ok) throw new Error(`Image download failed (${download.status}).`);
        const bytes = Buffer.from(await download.arrayBuffer());
        fs.writeFileSync(imageFile, bytes);
        fs.writeFileSync(
          metaFile,
          JSON.stringify(
            {
              ...record,
              status: "succeeded",
              request_id: result.requestId,
              output_url: result.image.url,
              width: result.image.width ?? null,
              height: result.image.height ?? null,
              bytes: bytes.length,
              sha256: sha256(bytes),
              completed_at: new Date().toISOString(),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        record.status = "succeeded";
        record.request_id = result.requestId;
        record.output_sha256 = sha256(bytes);
        record.completed_at = new Date().toISOString();
        generated += 1;
        console.log(`OK  ${subject.slug}/${print.print_number}-${slugify(print.title)} candidate ${index} · $${plan.provider.unit_cost_usd.toFixed(2)} · spent $${spent().toFixed(2)}`);
      } catch (error) {
        record.status = "failed";
        record.error = String(error?.message ?? error).slice(0, 800);
        failed += 1;
        console.error(`ERR ${subject.slug}/${print.print_number} candidate ${index}: ${record.error}`);
      }
      writeLedger(ledger);
    }
  }
}

const summary = {
  dry_run: dryRun,
  generated,
  skipped,
  failed,
  spent_usd: spent(),
  cap_usd: plan.budget_cap_usd,
  remaining_usd: Math.round((plan.budget_cap_usd - spent()) * 100) / 100,
  ledger: path.relative(root, ledgerPath),
};
console.log(JSON.stringify(summary, null, 2));
if (failed > 0) process.exitCode = 1;
