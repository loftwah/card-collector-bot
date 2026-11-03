#!/usr/bin/env node
/**
 * Provision the finish-mastery and collection-mastery achievement catalogue.
 *
 * Every definition freezes the collection roster card IDs and uses the same
 * normalised finish predicate as the runtime evaluator. A holographic Gold copy
 * is Holographic, never a second Gold award.
 *
 * Dry run by default. Existing keys are never rewritten: an earned version is
 * permanent and a changed rule needs a new explicit version.
 *
 *   node scripts/provision-mastery-achievements.mjs
 *   node scripts/provision-mastery-achievements.mjs --apply
 *   node scripts/provision-mastery-achievements.mjs --local --apply
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const local = args.includes("--local");
const wrangler = process.platform === "win32" ? "wrangler.cmd" : "npx";
const baseArgs = ["wrangler", "d1", "execute", local ? "foilbury-local" : "foilbury", local ? "--local" : "--remote"];
if (!local) baseArgs.push("--config", "wrangler.production.jsonc");
baseArgs.push("--json");

function query(sql) {
  const output = execFileSync(wrangler, [...baseArgs, "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(JSON.stringify(first.error ?? first));
  return first?.results ?? [];
}

function esc(value) {
  return String(value).replaceAll("'", "''");
}

const collections = query(`SELECT id, slug, name, release_version FROM fb_collections
  WHERE scope = 'global' AND status = 'published' AND archived_at IS NULL
  ORDER BY sort, name`);
const cards = query(`SELECT cc.collection_id, cc.card_id, cd.name AS card_name, cd.status
  FROM fb_collection_cards cc JOIN fb_card_definitions cd ON cd.id = cc.card_id
  WHERE cd.archived_at IS NULL ORDER BY cc.collection_id, cc.sort, cd.name`);
const owner = query("SELECT user_id FROM fb_platform_admins WHERE status = 'active' LIMIT 1")[0];
if (!owner) {
  console.error("No active provisioned Super Admin exists. Refusing to write achievement definitions without an accountable creator.");
  process.exit(1);
}

const byCollection = new Map();
for (const card of cards) {
  if (!byCollection.has(card.collection_id)) byCollection.set(card.collection_id, []);
  byCollection.get(card.collection_id).push(card);
}

const finishes = [
  { key: "plain", label: "Plain", art: "medal-first", reward: 60 },
  { key: "silver", label: "Silver", art: "medal-silver", reward: 90 },
  { key: "gold", label: "Gold", art: "medal-gold", reward: 160 },
  { key: "holographic", label: "Holographic", art: "medal-holo", reward: 240 },
];

const definitions = [];
for (const [index, collection] of collections.entries()) {
  const roster = byCollection.get(collection.id) ?? [];
  if (!roster.length) continue;
  const rosterIds = roster.map((card) => card.card_id);
  const base = {
    collection_id: collection.id,
    collection_slug: collection.slug,
    roster_card_ids: rosterIds,
    roster_release_version: collection.release_version,
    roster_size: rosterIds.length,
  };
  definitions.push({
    key: `${collection.slug}-first-card`,
    name: `${collection.name} · First card`,
    description: `Draw your first card from the frozen ${collection.name} release roster.`,
    category: "collection",
    criteria: { type: "first_in_collection", ...base, target: 1 },
    art_key: "medal-first",
    reward: 40,
    sort: 1000 + index * 10,
  });
  for (const finish of finishes) {
    definitions.push({
      key: `${collection.slug}-${finish.key}-mastery`,
      name: `${collection.name} · ${finish.label} run`,
      description: `Collect the ${finish.label} finish for every subject in the frozen ${collection.name} release roster. Duplicate subjects do not count.`,
      category: "finish",
      criteria: { type: "collection_finish_set", ...base, finish: finish.key, target: rosterIds.length },
      art_key: finish.art,
      reward: finish.reward,
      sort: 1100 + index * 10,
    });
  }
  definitions.push({
    key: `${collection.slug}-core-mastery`,
    name: `${collection.name} · Core mastery`,
    description: `Hold Plain, Silver, Gold and Holographic for every subject in the frozen ${collection.name} release roster. This is finish mastery, not roster completion.`,
    category: "collection",
    criteria: { type: "collection_core_set", ...base, target: rosterIds.length },
    art_key: "medal-collection",
    reward: 640,
    sort: 1200 + index * 10,
  });
}

const existingKeys = new Set(query(`SELECT key FROM fb_achievement_definitions WHERE scope = 'platform' AND archived_at IS NULL`).map((row) => row.key));
const pending = definitions.filter((definition) => !existingKeys.has(definition.key));
const now = new Date().toISOString();
const statements = pending.map((definition) => {
  const id = `ach_${definition.key.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  return `INSERT OR IGNORE INTO fb_achievement_definitions
    (id, scope, tenant_id, key, version, name, description, criteria_json, reward_json, visibility, art_key, category, sort, status, created_by, created_at, updated_at)
    VALUES ('${esc(id)}', 'platform', NULL, '${esc(definition.key)}', 1, '${esc(definition.name)}', '${esc(definition.description)}', '${esc(JSON.stringify(definition.criteria))}', '${esc(JSON.stringify({ foil: definition.reward }))}', 'member', '${esc(definition.art_key)}', '${esc(definition.category)}', ${definition.sort}, 'active', '${esc(owner.user_id)}', '${now}', '${now}');`;
});

console.log(JSON.stringify({
  mode: apply ? "APPLY" : "DRY RUN",
  environment: local ? "local" : "production",
  collections: collections.length,
  definitions: definitions.length,
  alreadyPresent: definitions.length - pending.length,
  pending: pending.length,
  byFamily: {
    first: pending.filter((definition) => definition.key.endsWith("-first-card")).length,
    plain: pending.filter((definition) => definition.key.endsWith("-plain-mastery")).length,
    silver: pending.filter((definition) => definition.key.endsWith("-silver-mastery")).length,
    gold: pending.filter((definition) => definition.key.endsWith("-gold-mastery")).length,
    holographic: pending.filter((definition) => definition.key.endsWith("-holographic-mastery")).length,
    core: pending.filter((definition) => definition.key.endsWith("-core-mastery")).length,
  },
  note: "Existing keys are skipped. This does not evaluate or grant rewards; the normal backfill/evaluator does that.",
}, null, 2));

if (!apply) {
  console.log("\nDry run only. Re-run with --apply after reviewing the counts and a D1 backup.");
  process.exit(0);
}

let inserted = 0;
for (const statement of statements) {
  query(statement);
  inserted += 1;
}
const verified = query(`SELECT key, name, category, status FROM fb_achievement_definitions
  WHERE key LIKE '%-plain-mastery' OR key LIKE '%-silver-mastery' OR key LIKE '%-gold-mastery' OR key LIKE '%-holographic-mastery' OR key LIKE '%-core-mastery' OR key LIKE '%-first-card'
  ORDER BY key LIMIT 500`);
console.log(JSON.stringify({ applied: true, inserted, verifiedDefinitions: verified.length, sample: verified.slice(0, 6) }, null, 2));
