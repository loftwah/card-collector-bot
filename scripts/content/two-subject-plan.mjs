#!/usr/bin/env node
// Advisory, offline plan only. A snapshot cannot authorize an import: the
// catalogue and grants can change after it was taken.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

export const subjects = [
  { file: "danganronpa.json", slug: "gonta-gokuhara", logicalId: "danganronpa:gonta-gokuhara", collection: "danganronpa-three-games", names: ["Gonta Gokuhara", "Gonta"] },
  { file: "vocaloid.json", slug: "kamui-gakupo", logicalId: "vocaloid:kamui-gakupo", collection: "vocaloid", names: ["Kamui Gakupo", "Camui Gackpo", "Gackpoid", "神威がくぽ"] },
];
// Must remain identical to normalizeCardName in card-name-aliases.ts.
export function normalizeName(value) { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(); }

export function planTwoSubjects({ snapshot, tenantId, manifests }) {
  if (!tenantId || !snapshot?.tables) throw new Error("An explicit tenant and complete snapshot are required.");
  for (const name of ["fb_card_definitions", "fb_card_name_aliases", "fb_collections", "fb_collection_cards"]) {
    if (!Array.isArray(snapshot.tables[name])) throw new Error(`Snapshot is missing ${name}; identity checks cannot proceed.`);
  }
  const cards = snapshot.tables.fb_card_definitions.filter((c) => c.tenant_id === tenantId);
  const aliases = snapshot.tables.fb_card_name_aliases.filter((a) => a.tenant_id === tenantId);
  if (aliases.some((a) => typeof a.alias !== "string" || a.normalized !== normalizeName(a.alias))) throw new Error("Alias registry contains invalid normalization; identity checks cannot proceed.");
  const results = subjects.map((subject) => {
    const manifest = manifests[subject.file];
    const found = manifest?.cards?.filter((c) => c.slug === subject.slug) ?? [];
    if (found.length !== 1 || found[0].logical_id !== subject.logicalId || manifest?.collection?.slug !== subject.collection)
      return { slug: subject.slug, status: "blocked", reason: "manifest_identity_mismatch" };
    const names = new Set([...subject.names, found[0].name].map(normalizeName));
    const matches = new Set(cards.filter((c) => c.logical_id === subject.logicalId || c.slug === subject.slug || names.has(normalizeName(c.name))).map((c) => c.id));
    for (const a of aliases) if (names.has(a.normalized)) matches.add(a.card_id);
    if ([...matches].some((id) => !cards.some((card) => card.id === id))) return { slug: subject.slug, status: "blocked", reason: "orphan_alias" };
    if (matches.size > 1) return { slug: subject.slug, status: "blocked", reason: "ambiguous_identity" };
    const collections = snapshot.tables.fb_collections.filter((c) => c.slug === subject.collection && c.scope === "global" && c.owner_tenant_id === tenantId && !c.archived_at);
    if (collections.length !== 1) return { slug: subject.slug, status: "blocked", reason: "collection_missing_or_ambiguous" };
    const id = [...matches][0];
    if (id) {
      const linked = snapshot.tables.fb_collection_cards.some((c) => c.card_id === id && c.collection_id === collections[0].id);
      return { slug: subject.slug, status: "existing", card_id: id, linked_to_collection: linked, action: "no_write" };
    }
    return { slug: subject.slug, status: "candidate", logical_id: subject.logicalId, collection_id: collections[0].id, card_record_json_sha256: createHash("sha256").update(JSON.stringify(found[0])).digest("hex"), action: "review_required" };
  });
  return { mode: "offline_advisory", tenant_id: tenantId, results, write_authorized: false,
    blockers: ["Live identity and authority must be rechecked atomically.", "Artwork requires a verified visual review bound to exact bytes.", "Production requires backup, rollback and explicit deployment approval."] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--snapshot" || args[2] !== "--tenant" || args[4] !== "--manifest-dir") throw new Error("Usage: node scripts/content/two-subject-plan.mjs --snapshot LOCAL_JSON --tenant TENANT_ID --manifest-dir LOCAL_DIR");
    const snapshot = JSON.parse(fs.readFileSync(args[1], "utf8"));
    const manifests = Object.fromEntries(subjects.map(({ file }) => [file, JSON.parse(fs.readFileSync(path.join(args[5], file), "utf8"))]));
    const plan = planTwoSubjects({ snapshot, tenantId: args[3], manifests });
    console.log(JSON.stringify(plan, null, 2));
    if (plan.results.some((r) => r.status === "blocked")) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
