#!/usr/bin/env node
/**
 * Read back the retained persistent demonstration.
 *
 * Verifies every message still exists with the same id, the expected stage
 * number, an image (where required) and no mentions. Downloads each embed image
 * so a human can inspect the exact bytes the client receives.
 *
 *   node scripts/discord/verify-persistent-demo.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/local.mjs";

const stateFile = path.join(ROOT, ".foilbury", "demo", "foilbury-demo-2026-11-04.json");
if (!fs.existsSync(stateFile)) throw new Error("Run the publisher first.");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].trim();
}
const token = env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN is missing.");
const outDir = path.join(ROOT, ".foilbury", "demo-readback", "verified");
fs.mkdirSync(outDir, { recursive: true });

async function discord(endpoint, attempt = 0) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    headers: { authorization: `Bot ${token}` },
  });
  if (response.status === 429 && attempt < 4) {
    let retryAfter = 1;
    try {
      retryAfter = Number((await response.json()).retry_after ?? 1);
    } catch {
      // Keep the conservative default.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(retryAfter * 1000) + 250));
    return discord(endpoint, attempt + 1);
  }
  if (!response.ok) throw new Error(`${endpoint}: ${response.status} ${await response.text()}`);
  return response.json();
}

const expectedImages = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 13, 14, 15, 16]);
const FINAL_STAGE = 21;
const results = [];
let failures = 0;
for (let stage = 1; stage <= FINAL_STAGE; stage += 1) {
  const id = state.stages[String(stage)]?.message_id;
  if (!id) {
    failures += 1;
    results.push({ stage, status: "FAIL", detail: "missing message id in state" });
    continue;
  }
  const message = await discord(`/channels/${state.channel_id}/messages/${id}`);
  const embed = (message.embeds ?? [])[0];
  const footer = embed?.footer?.text ?? "";
  const hasStage = footer.includes(`stage ${stage}`);
  const imageUrl = embed?.image?.url;
  const images = [];
  if (imageUrl) {
    const response = await fetch(imageUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = path.join(outDir, `stage-${stage}.png`);
    fs.writeFileSync(file, bytes);
    images.push({
      file,
      status: response.status,
      bytes: bytes.length,
      contentType: response.headers.get("content-type"),
    });
  }
  const extraImages = [];
  for (const [index, extra] of (message.embeds ?? []).slice(1).entries()) {
    if (!extra.image?.url) continue;
    const response = await fetch(extra.image.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = path.join(outDir, `stage-${stage}-extra-${index + 1}.png`);
    fs.writeFileSync(file, bytes);
    extraImages.push({ file, status: response.status, bytes: bytes.length });
  }
  const text = JSON.stringify({ embeds: message.embeds, components: message.components });
  const problems = [];
  if (message.author?.id !== state.application_id && message.author?.id !== "1566702936615026769")
    problems.push("unexpected author");
  if (message.type !== 0) problems.push(`unexpected message type ${message.type}`);
  if (message.flags & 64) problems.push("ephemeral message");
  if (!hasStage) problems.push("footer stage mismatch");
  if (expectedImages.has(stage) && !imageUrl) problems.push("required image missing");
  if (stage === 12 || stage === FINAL_STAGE) {
    const indexText = JSON.stringify(message.embeds);
    const lastLinked = stage === 12 ? 17 : FINAL_STAGE;
    for (let linked = 1; linked <= lastLinked; linked += 1) {
      const linkedId = state.stages[String(linked)]?.message_id;
      if (linkedId && !indexText.includes(linkedId)) problems.push(`index missing stage ${linked}`);
    }
  }
  if (message.mentions?.length) problems.push("mentions present");
  if (/everyone|here/.test(message.content ?? "")) problems.push("mass mention text");
  if (/dean@|@players|usr_|ten_|dci_/.test(text))
    problems.push("private identifier in public message");
  const rows = message.components ?? [];
  if (rows.length > 5) problems.push("more than five component rows");
  for (const row of rows) {
    if ((row.components ?? []).length > 5) problems.push("more than five buttons in a row");
    for (const component of row.components ?? []) {
      if ((component.label ?? "").length > 80) problems.push("button label over 80 characters");
    }
  }
  if (problems.length) {
    failures += 1;
    results.push({ stage, id, status: "FAIL", problems });
  } else {
    results.push({ stage, id, status: "PASS", title: embed?.title ?? null, images, extraImages });
  }
}

fs.writeFileSync(
  path.join(outDir, "readback.json"),
  JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2),
);
console.log(JSON.stringify({ results, failures }, null, 2));
if (failures) process.exit(1);
