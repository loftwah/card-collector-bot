import { describe, expect, it } from "vitest";
import { createCard, getCard, listCards, listSets, mergeCards, publishCatalogue, publishSet, replaceSetMembership, setCardStatus } from "../../src/server/modules/catalogue";
import { commitImport } from "../../src/server/modules/imports";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

describe("catalogue lifecycle", () => {
  it("rejects invalid transitions and publishes an immutable release", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);

    const draft = await createCard(owner, {
      slug: "draft-card",
      name: "Draft Card",
      description: "A draft with no published variant.",
      logicalId: "test:draft",
    });
    await expect(setCardStatus(owner, draft.id, "published")).rejects.toMatchObject({ code: "no_published_variant" });
    await expect(setCardStatus(owner, draft.id, "retired")).rejects.toMatchObject({ code: "invalid_transition" });

    const release = await publishCatalogue(owner);
    expect(release.version).toBe(1);
    expect(release.checksum).toMatch(/^[a-f0-9]{64}$/);
    const publicCards = await listCards(owner, { publicOnly: true });
    expect(publicCards).toHaveLength(1);
    expect(publicCards[0]!.slug).toBe("test-one");
  });

  it("blocks a release when a published card has no finished render", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const material = await runtime.DB.prepare("SELECT id FROM fb_materials WHERE tenant_id = ? AND key = 'plain'").bind(owner.tenant.id).first<{ id: string }>();
    const effect = await runtime.DB.prepare("SELECT id FROM fb_effects WHERE tenant_id = ? AND key = 'none'").bind(owner.tenant.id).first<{ id: string }>();
    const recipe = await runtime.DB.prepare("SELECT id FROM fb_recipes WHERE tenant_id = ? LIMIT 1").bind(owner.tenant.id).first<{ id: string }>();
    const card = await createCard(owner, { slug: "unrendered", name: "Unrendered", description: "Published without a render.", logicalId: "test:unrendered" });
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO fb_artwork_editions (id, tenant_id, card_id, name, subject_asset_id, recipe_id, status, created_at) VALUES ('edt_unrendered', ?, ?, 'Unrendered edition', 'ast_test_subject', ?, 'published', ?)").bind(owner.tenant.id, card.id, recipe!.id, now),
      runtime.DB.prepare("INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES ('var_unrendered', ?, ?, 'edt_unrendered', ?, ?, 'Plain', 'published', ?)").bind(owner.tenant.id, card.id, material!.id, effect!.id, now),
    ]);
    await setCardStatus(owner, card.id, "published");
    await expect(publishCatalogue(owner)).rejects.toMatchObject({ code: "catalogue_invalid" });
  });
});

describe("source imports", () => {
  it("is idempotent for the same source hash and creates a reviewable edition for a change", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const base = {
      source: "test-source",
      sourceRepo: "test/repo",
      sourceCommit: "test-commit",
      items: [
        {
          source: "test-source",
          sourceRepo: "test/repo",
          sourceCommit: "test-commit",
          sourcePath: "art/import-one.png",
          sourceHash: "hash-a",
          logicalId: "import:one",
          slug: "import-one",
          name: "Import One",
          description: "An imported test identity.",
          classKey: undefined,
          categorySlug: undefined,
          rarityKey: undefined,
          tags: [],
          subjectAssetId: fixture.subjectAsset,
          variants: [{ material: "plain", effect: "none" }],
          sets: [],
        },
      ],
    };
    const first = await commitImport(owner, base);
    expect(first.summary.imported).toBe(1);
    expect(first.summary.failed).toBe(0);
    const second = await commitImport(owner, base);
    expect(second.summary.unchanged).toBe(1);
    expect(second.summary.imported).toBe(0);

    const changed = {
      ...base,
      items: [{ ...base.items[0]!, sourceHash: "hash-b", sourcePath: "art/import-one-revised.png" }],
    };
    const third = await commitImport(owner, changed);
    expect(third.summary.revised).toBe(1);
    expect(third.summary.failed).toBe(0);
    const card = await getCard(owner, "import-one");
    expect(card.editions).toHaveLength(2);
    expect(card.name).toBe("Import One");
    const importItems = await runtime.DB.prepare("SELECT status, hash FROM fb_import_items WHERE tenant_id = ? AND logical_id = 'import:one' ORDER BY created_at").bind(owner.tenant.id).all<{ status: string; hash: string }>();
    expect(importItems.results.length).toBeGreaterThanOrEqual(2);
    expect(importItems.results.some((row) => row.hash === "hash-a")).toBe(true);
    expect(importItems.results.some((row) => row.hash === "hash-b")).toBe(true);
  });
});


describe("set versioning", () => {
  it("keeps the prior checklist version and creates a new draft when membership changes", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const set = (await listSets(owner)).find((item) => item.slug === "first-cabinet");
    expect(set).toBeTruthy();
    await replaceSetMembership(owner, set!.id, [fixture.cardId]);
    const published = await publishSet(owner, set!.id);
    expect(published.version).toBe(1);
    const extra = await createCard(owner, { slug: "set-extra", name: "Set Extra", description: "A second checklist member.", logicalId: "test:set-extra" });
    const revised = await replaceSetMembership(owner, set!.id, [fixture.cardId, extra.id]);
    expect(revised.version).toBe(2);
    expect(revised.status).toBe("draft");
    const rows = await runtime.DB.prepare("SELECT set_version, COUNT(*) AS count FROM fb_set_memberships WHERE tenant_id = ? AND set_id = ? GROUP BY set_version ORDER BY set_version").bind(owner.tenant.id, set!.id).all<{ set_version: number; count: number }>();
    expect(rows.results.find((row) => row.set_version === 1)?.count).toBe(1);
    expect(rows.results.find((row) => row.set_version === 2)?.count).toBe(2);
  });
});

describe("card merging", () => {
  it("moves editions, variants, instances and aliases without losing history", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const target = await createCard(owner, { slug: "merge-target", name: "Merge Target", description: "A target identity.", logicalId: "test:merge-target" });
    const instance = await makeInstance(owner, owner.user!.id, fixture, "MERGE-KEEP-1");
    const result = await mergeCards(owner, fixture.cardId, target.id);
    expect(result.status).toBe("merged");
    const moved = await runtime.DB.prepare("SELECT card_id FROM fb_card_instances WHERE id = ?").bind(instance).first<{ card_id: string }>();
    expect(moved?.card_id).toBe(target.id);
    const edition = await runtime.DB.prepare("SELECT card_id FROM fb_artwork_editions WHERE id = ?").bind(fixture.editionId).first<{ card_id: string }>();
    expect(edition?.card_id).toBe(target.id);
    const alias = await runtime.DB.prepare("SELECT target_card_id FROM fb_card_aliases WHERE tenant_id = ? AND source_card_id = ?").bind(owner.tenant.id, fixture.cardId).first<{ target_card_id: string }>();
    expect(alias?.target_card_id).toBe(target.id);
    const viaAlias = await getCard(owner, fixture.cardId);
    expect(viaAlias.id).toBe(target.id);
    const sourceStatus = await runtime.DB.prepare("SELECT status, archived_at FROM fb_card_definitions WHERE id = ?").bind(fixture.cardId).first<{ status: string; archived_at: string | null }>();
    expect(sourceStatus?.status).toBe("retired");
    expect(sourceStatus?.archived_at).toBeTruthy();
  });
});
