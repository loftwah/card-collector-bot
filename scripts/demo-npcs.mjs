#!/usr/bin/env node
/**
 * Local demo cast for the NPC lounge. Creates or refreshes three clearly
 * labelled synthetic collectors with original Foilbury portraits, then records a
 * small number of genuine ordinary draws so their profiles contain real cards,
 * serials and ledger history. It never runs against production and never
 * fabricates an award.
 */
import fs from "node:fs";

const baseURL = process.env.FOILBURY_URL ?? "http://localhost:5173";
if (!["localhost", "127.0.0.1", "::1"].includes(new URL(baseURL).hostname)) {
  console.error("Refusing to seed NPC demo data outside localhost.");
  process.exit(2);
}

const CAST = [
  {
    name: "Nova Ledger",
    presetKey: "variety_collector",
    poolSlug: "cabinet-draw",
    avatarUrl: "/brand/npc/nova-ledger.webp",
    bio: "An archivist who treats every new subject as a missing entry in a catalogue. Prefers variety over duplicates.",
    draws: 3,
  },
  {
    name: "Mira Circuit",
    presetKey: "holo_hunter",
    poolSlug: "protocol-draw",
    avatarUrl: "/brand/npc/mira-circuit.webp",
    bio: "A patient finish-hunter chasing Holographic mastery through ordinary eligible capsules, never better odds.",
    draws: 2,
  },
  {
    name: "Kite Runner",
    presetKey: "established_rival",
    poolSlug: "total-drama-island-capsule",
    avatarUrl: "/brand/npc/kite-runner.webp",
    bio: "A courier with an accumulated, auditable cabinet. Every card and serial on this profile came from a real recorded draw.",
    draws: 4,
  },
];

const jar = [];
let csrf = "";
async function request(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(jar.length ? { cookie: jar.join("; ") } : {}),
      ...(csrf && options.method && options.method !== "GET" ? { "x-foilbury-csrf": csrf } : {}),
      ...(options.headers ?? {}),
    },
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const pair = cookie.split(";")[0];
    const name = pair?.split("=")[0];
    if (!name) continue;
    const index = jar.findIndex((item) => item.startsWith(`${name}=`));
    if (index >= 0) jar.splice(index, 1);
    jar.push(pair);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

const login = await request("/api/v1/dev/login", { method: "POST", body: JSON.stringify({ email: "owner@foilbury.local" }) });
if (login.status !== 200) {
  console.error(`Local owner sign-in failed: ${login.status}`);
  process.exit(1);
}
csrf = login.body?.csrf_token ?? "";

const overview = await request("/api/v1/npcs/admin");
const existing = new Map((overview.body?.items ?? []).map((npc) => [npc.name, npc]));
const collections = (await request("/api/v1/collections")).body?.items ?? [];
const focus = collections.find((collection) => collection.card_count > 0 && collection.enabled) ?? collections[0] ?? null;
const created = [];

for (const entry of CAST) {
  const current = existing.get(entry.name);
  if (current) {
    const patch = await request(`/api/v1/npcs/${current.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        bio: entry.bio,
        avatarUrl: entry.avatarUrl,
        presetKey: entry.presetKey,
        poolSlug: entry.poolSlug,
        scheduleEnabled: false,
      }),
    });
    if (patch.status !== 200) console.error(`Could not update ${entry.name}: ${patch.status} ${JSON.stringify(patch.body)}`);
    else console.log(`refreshed ${entry.name}`);
    continue;
  }
  const result = await request("/api/v1/npcs", {
    method: "POST",
    body: JSON.stringify({
      name: entry.name,
      presetKey: entry.presetKey,
      bio: entry.bio,
      avatarUrl: entry.avatarUrl,
      poolSlug: entry.poolSlug,
      goalCollectionId: focus?.id ?? null,
    }),
  });
  if (result.status !== 201) {
    console.error(`Could not create ${entry.name}: ${result.status} ${JSON.stringify(result.body)}`);
    continue;
  }
  console.log(`created ${entry.name}`);
  created.push(result.body.id);
  for (let index = 0; index < entry.draws; index += 1) {
    const play = await request(`/api/v1/npcs/${result.body.id}/play`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: `demo-${entry.name.toLowerCase().replaceAll(" ", "-")}-${Date.now()}-${index}` }),
    });
    if (play.status === 200) {
      console.log(`  draw ${index + 1}: ${play.body.receipt?.card_name} · ${play.body.receipt?.serial}`);
    } else {
      console.log(`  draw ${index + 1} skipped: ${play.body?.error?.message ?? play.status}`);
      break;
    }
  }
}

fs.mkdirSync(".foilbury/evidence", { recursive: true });
fs.writeFileSync(".foilbury/evidence/npc-demo-cast.json", JSON.stringify({ generated_at: new Date().toISOString(), cast: CAST.map(({ name, presetKey }) => ({ name, presetKey })), created }, null, 2));
console.log(`NPC demo cast ready · ${created.length} new`);
