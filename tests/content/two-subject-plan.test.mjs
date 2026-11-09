import { test } from "node:test";
import assert from "node:assert/strict";
import { planTwoSubjects, subjects } from "../../scripts/content/two-subject-plan.mjs";
const manifests = Object.fromEntries(subjects.map(s => [s.file, { collection: { slug: s.collection, scope: "global", owner_tenant_id: "tenant" }, cards: [{ slug: s.slug, logical_id: s.logicalId, name: s.names[0] }] }]));
function snapshot() { return { tables: { fb_card_definitions: [], fb_card_name_aliases: [], fb_collections: subjects.map((s, i) => ({ id: `collection-${i}`, slug: s.collection, scope: "global", owner_tenant_id: "tenant" })), fb_collection_cards: [] } }; }
test("proposes only two bounded candidates with record JSON digests and no write authority", () => {
  const result = planTwoSubjects({ snapshot: snapshot(), tenantId: "tenant", manifests });
  assert.equal(result.write_authorized, false);
  assert.deepEqual(result.results.map(x => x.status), ["candidate", "candidate"]);
  assert.match(result.results[0].card_record_json_sha256, /^[a-f0-9]{64}$/);
});
test("finds existing registry aliases and blocks ambiguous identities", () => {
  const s = snapshot();
  s.tables.fb_card_definitions.push({ id: "existing", tenant_id: "tenant", logical_id: "other", slug: "other", name: "Other" });
  s.tables.fb_card_name_aliases.push({ tenant_id: "tenant", card_id: "existing", alias: "Ｃａｍｕｉ　Ｇａｃｋｐｏ", normalized: "camui gackpo" });
  let plan = planTwoSubjects({ snapshot: s, tenantId: "tenant", manifests });
  assert.equal(plan.results[1].status, "existing");
  s.tables.fb_card_definitions.push({ id: "duplicate", tenant_id: "tenant", logical_id: "vocaloid:kamui-gakupo", slug: "gakupo", name: "Different" });
  plan = planTwoSubjects({ snapshot: s, tenantId: "tenant", manifests });
  assert.equal(plan.results[1].reason, "ambiguous_identity");
});
test("requires the alias registry and exact manifest identity", () => {
  const s = snapshot(); delete s.tables.fb_card_name_aliases;
  assert.throws(() => planTwoSubjects({ snapshot: s, tenantId: "tenant", manifests }), /fb_card_name_aliases/);
  const wrong = structuredClone(manifests); wrong[subjects[0].file].cards[0].logical_id = "other";
  assert.equal(planTwoSubjects({ snapshot: snapshot(), tenantId: "tenant", manifests: wrong }).results[0].reason, "manifest_identity_mismatch");
});

test("blocks a same-slug collection owned by another Bot or with private scope", () => {
  const s = snapshot();
  s.tables.fb_collections[0].owner_tenant_id = "other";
  s.tables.fb_collections[1].scope = "bot";
  assert.deepEqual(planTwoSubjects({ snapshot: s, tenantId: "tenant", manifests }).results.map(r => r.reason), ["collection_missing_or_ambiguous", "collection_missing_or_ambiguous"]);
});
