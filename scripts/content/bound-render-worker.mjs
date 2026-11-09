#!/usr/bin/env node
// Explicit, resumable operator command. It never approves a review or starts a
// server. The target routes remain held until the complete protocol is qualified.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { describeBoundRenderer, executeBoundRender } from "./bound-render-executor.mjs";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const n = arg.indexOf("=");
    return n > 2 && arg.startsWith("--") ? [arg.slice(2, n), arg.slice(n + 1)] : ["", ""];
  }),
);
const token = process.env.FOILBURY_AGENT_TOKEN,
  runtimeDigest = process.env.FOILBURY_RENDER_RUNTIME_SHA256;
const root = process.cwd(),
  baseText = process.env.FOILBURY_URL;
if (
  !token ||
  !baseText ||
  !options.variant ||
  !options.collection ||
  !options.material ||
  !options.effect ||
  !options["request-key"]
) {
  console.error(
    "Provide FOILBURY_URL, FOILBURY_AGENT_TOKEN, FOILBURY_RENDER_RUNTIME_SHA256 and --variant= --collection= --material= --effect= --request-key=.",
  );
  process.exit(2);
}
const base = new URL(baseText);
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/" ||
  !(
    base.protocol === "https:" ||
    (base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))
  )
)
  throw new Error("Use an explicit HTTPS or loopback Foilbury origin.");
const origin = base.origin,
  headers = { authorization: `Bearer ${token}` };
async function call(route, { method = "GET", body, extra = {} } = {}) {
  const h = new Headers({ ...headers, ...extra });
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${origin}/api/v1/admin/bound-renders/${route}`, {
    method,
    headers: h,
    body: payload,
    redirect: "error",
  });
  if (!response.ok) {
    let code = "request_failed";
    try {
      let x = await response.json();
      if (/^[a-z0-9_]{1,80}$/.test(x?.error?.code ?? "")) code = x.error.code;
    } catch {}
    throw new Error(`${response.status} ${code}`);
  }
  return response;
}
async function bytes(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing render bytes.");
  const parts = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Render input exceeds the size limit.");
    }
    parts.push(next.value);
  }
  return Buffer.concat(
    parts.map((x) => Buffer.from(x)),
    size,
  );
}
const asJson = async (response) => response.json();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
try {
  const renderer = describeBoundRenderer(root, options.material, options.effect, runtimeDigest);
  const prepared = await asJson(
    await call("prepare", {
      method: "POST",
      body: { variantId: options.variant, collectionId: options.collection, renderer },
    }),
  );
  const queued = await asJson(
    await call("queue", {
      method: "POST",
      body: { manifest: prepared.manifest },
      extra: { "idempotency-key": options["request-key"] },
    }),
  );
  const id = queued.id;
  let status = await asJson(await call(`${id}/status`));
  if (status.manifestSha256 !== prepared.sha256)
    throw new Error("The request key belongs to different inputs.");
  if (status.status === "pending") {
    try {
      await call(`${id}/claim`, { method: "POST" });
    } catch {
      /* Resolve the same job, never create a second one. */
    }
    status = await asJson(await call(`${id}/status`));
  }
  if (status.status === "running") {
    const inputs = {};
    for (const role of ["subject", "background", "back", "mark"])
      inputs[role] = status.manifest.assets[role]
        ? await bytes(await call(`${id}/inputs/${role}?attempt=${status.attempt}`))
        : null;
    const output = await executeBoundRender({
      root,
      tempParent: path.join(root, ".foilbury/tmp"),
      manifest: status.manifest,
      inputs,
      trustedRuntimeImageSha256: runtimeDigest,
    });
    const form = new FormData();
    form.set("attempt", String(status.attempt));
    form.set("front", new Blob([output.front], { type: "image/webp" }), "front.webp");
    form.set("back", new Blob([output.back], { type: "image/webp" }), "back.webp");
    await call(`${id}/stage`, { method: "POST", body: form });
    status = await asJson(await call(`${id}/status`));
  }
  if (status.status === "approved" || status.status === "succeeded") {
    const receipt = await asJson(
      await call(`${id}/publish`, { method: "POST", body: { attempt: status.attempt } }),
    );
    const source = await bytes(await call(`${id}/published/front`));
    if (digest(source) !== receipt.front.sha256)
      throw new Error("Published front no longer matches its receipt.");
    for (const [size, width, height] of [
      ["thumb", 300, 420],
      ["preview", 600, 840],
    ]) {
      const derivative = await sharp(source)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, effort: 5 })
        .toBuffer();
      const form = new FormData();
      form.set("sourceAssetId", receipt.front.assetId);
      form.set("sizeKey", size);
      form.set("file", new Blob([derivative], { type: "image/webp" }), `${size}.webp`);
      await call(`${id}/derivatives`, { method: "POST", body: form });
    }
    status = await asJson(await call(`${id}/status`));
  }
  console.log(
    JSON.stringify({
      jobId: id,
      status: status.status,
      attempt: status.attempt,
      manifestSha256: status.manifestSha256,
      next:
        status.status === "awaiting_review"
          ? "Inspect both pinned sides and record an authorised review."
          : status.status === "failed"
            ? "The attempt was cancelled; start a new request only after checking its history."
            : null,
    }),
  );
} catch (error) {
  // Do not echo tokens, provider responses or arbitrary file contents.
  console.error(
    `Bound render stopped (${error instanceof Error && /^\d{3} [a-z0-9_]+$/.test(error.message) ? error.message : "operation_failed"}). Retry the same request key or inspect its status.`,
  );
  process.exitCode = 1;
}
