import { describe, expect, it } from "vitest";
import type { Ctx } from "../../src/server/context";
import { nowIso } from "../../src/server/db";
import {
  assertDistinctPrintCandidate,
  createOriginalIpVerticalSlice,
  createPrintProposal,
  findPrintConflict,
  linkApprovedEdition,
  listPrintProposalReviews,
  originalIpVerticalSlicePlan,
  printCoverageForCard,
  reviewPrintProposal,
  revisePrintProposal,
  submitPrintProposal,
  type PrintCandidate,
  type PrintProposalInput,
} from "../../src/server/modules/prints";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

async function addAsset(
  ctx: Ctx,
  id: string,
  sha: string,
  options: {
    kind?: string;
    reviewStatus?: string;
    processingState?: string;
    credit?: string;
  } = {},
): Promise<string> {
  const now = nowIso();
  await runtime.DB.prepare(
    `INSERT INTO fb_assets
      (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256,
       visibility, access_classification, processing_state, review_status, credit,
       provenance_json, created_at)
     VALUES (?, ?, ?, ?, 'image/png', 500, 700, 100, ?, ?, 'private', 'private', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      ctx.tenant.id,
      options.kind ?? "subject",
      id,
      `test/${id}.png`,
      sha,
      options.processingState ?? "ready",
      options.reviewStatus ?? "approved",
      options.credit ?? "Foilbury original test artwork.",
      JSON.stringify({ source: "test-fixture", licence: "internal" }),
      now,
    )
    .run();
  return id;
}

async function addEdition(
  ctx: Ctx,
  id: string,
  cardId: string,
  artworkAssetId: string,
  status: "draft" | "published" = "draft",
) {
  const recipe = await runtime.DB.prepare(
    "SELECT id FROM fb_recipes WHERE tenant_id = ? ORDER BY version DESC LIMIT 1",
  )
    .bind(ctx.tenant.id)
    .first<{ id: string }>();
  if (!recipe) throw new Error("Fixture recipe missing");
  await runtime.DB.prepare(
    `INSERT INTO fb_artwork_editions
      (id, tenant_id, card_id, name, subject_asset_id, recipe_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, ctx.tenant.id, cardId, id, artworkAssetId, recipe.id, status, nowIso())
    .run();
  return id;
}

function baseProposal(
  fixture: { cardId: string; subjectAsset: string },
  artworkAssetId: string,
): PrintProposalInput {
  return {
    cardId: fixture.cardId,
    printNumber: "01",
    role: "portrait",
    title: "Test One · Portrait",
    creativeDirection:
      "A confident three-quarter portrait with a restrained graphic ground and a clear silhouette for thumbnail legibility.",
    sourceAssetId: fixture.subjectAsset,
    artworkAssetId,
    sourceRefs: ["https://example.test/foilbury-original-source"],
    rightsNote: "Foilbury original artwork; internal review.",
    finishKeys: ["plain", "silver", "gold", "holographic"],
    status: "proposed",
  };
}

describe("multi-print proposals", () => {
  it("creates a proposal with provenance and validates the required print fields", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const art = await addAsset(owner, "ast_print_a", "sha-print-a");

    const draft = await createPrintProposal(owner, {
      ...baseProposal(fixture, art),
      printNumber: "01",
      title: "Test One · Portrait",
      status: "draft",
    });
    expect(draft.status).toBe("draft");
    expect(draft.revision).toBe(1);
    expect(draft.print_number).toBe("01");
    expect(draft.print_key).toBe("test:one:01");
    expect(draft.role).toBe("portrait");
    expect(draft.source_refs).toEqual(["https://example.test/foilbury-original-source"]);
    expect(draft.finish_keys).toEqual(["plain", "silver", "gold", "holographic"]);
    expect(draft.approved_edition).toBeNull();
    expect((draft.provenance.source_asset as Record<string, unknown>).sha256).toBeTruthy();
    expect((draft.provenance.artwork_asset as Record<string, unknown>).sha256).toBe("sha-print-a");

    await expect(
      createPrintProposal(owner, { ...baseProposal(fixture, art), role: "finish" }),
    ).rejects.toMatchObject({ code: "print_role_invalid" });
    await expect(
      createPrintProposal(owner, { ...baseProposal(fixture, art), title: "Gold" }),
    ).rejects.toMatchObject({ code: "finish_is_not_a_print" });
    await expect(
      createPrintProposal(owner, { ...baseProposal(fixture, art), creativeDirection: "Short." }),
    ).rejects.toMatchObject({ code: "print_direction_too_short" });
    await expect(
      createPrintProposal(owner, { ...baseProposal(fixture, art), printNumber: "zero" }),
    ).rejects.toMatchObject({ code: "print_number_invalid" });
    await expect(
      createPrintProposal(owner, { ...baseProposal(fixture, art), sourceAssetId: "ast_missing" }),
    ).rejects.toMatchObject({ code: "print_source_asset_invalid" });
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, art),
        sourceRefs: ["javascript:alert(1)"],
      }),
    ).rejects.toMatchObject({ code: "print_source_ref_invalid" });
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, art),
        printNumber: "02",
        artworkAssetId: null,
        status: "proposed",
      }),
    ).rejects.toMatchObject({ code: "print_artwork_required" });

    const noCredit = await addAsset(owner, "ast_print_nocredit", "sha-print-nocredit", {
      credit: "",
    });
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, noCredit),
        printNumber: "07",
        sourceRefs: [],
        rightsNote: null,
        status: "proposed",
      }),
    ).rejects.toMatchObject({ code: "print_provenance_required" });
  });

  it("rejects duplicate and near-duplicate proposals against proposals and editions", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const artA = await addAsset(owner, "ast_print_a", "sha-print-a");
    const artB = await addAsset(owner, "ast_print_b", "sha-print-b");
    const artC = await addAsset(owner, "ast_print_c", "sha-print-c");

    await createPrintProposal(owner, baseProposal(fixture, artA));

    // Same artwork, role and title with only a different finish list.
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artA),
        printNumber: "02",
        finishKeys: ["gold", "holographic"],
      }),
    ).rejects.toMatchObject({ code: "finish_is_not_a_print" });

    // The same artwork cannot become another print just by changing role/title.
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artA),
        printNumber: "03",
        role: "action_scene",
        title: "Test One · Action",
        creativeDirection:
          "A new narrative action moment with a dynamic diagonal composition and environmental depth.",
      }),
    ).rejects.toMatchObject({ code: "print_duplicate" });

    // Same role and title with different artwork is still the same print identity.
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artB),
        printNumber: "04",
      }),
    ).rejects.toMatchObject({ code: "print_duplicate" });

    // Different artwork, but a near-identical title and direction.
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artB),
        printNumber: "05",
        title: "Test One · Portrait Redux",
      }),
    ).rejects.toMatchObject({ code: "print_near_duplicate" });

    // The existing legacy edition is an existing print: reusing its artwork is
    // a duplicate even when the proposal has a new title and direction.
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, fixture.subjectAsset),
        printNumber: "06",
        title: "Test Edition Restrike",
        creativeDirection:
          "A different mood and composition written to disguise a source image that is already published.",
      }),
    ).rejects.toMatchObject({ code: "print_duplicate" });

    // Stable numbers are never recycled, even for rejected proposals.
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artC),
        printNumber: "01",
        title: "Test One · Another Portrait",
        role: "alternate_art",
      }),
    ).rejects.toMatchObject({ code: "print_number_in_use" });

    const existing: PrintCandidate[] = [
      {
        id: "prp_existing",
        kind: "proposal",
        role: "portrait",
        title: "Hero Portrait",
        creativeDirection:
          "A three-quarter portrait with a restrained ground and a clear silhouette.",
        artworkFingerprint: "sha-print-a",
        finishKeys: ["plain"],
      },
    ];
    expect(
      findPrintConflict(existing, {
        ...existing[0]!,
        id: "prp_candidate",
        finishKeys: ["gold"],
      })?.code,
    ).toBe("finish_is_not_a_print");
    expect(() =>
      assertDistinctPrintCandidate(existing, {
        ...existing[0]!,
        id: "prp_candidate",
        title: "Hero Portrait Redux",
        artworkFingerprint: "sha-print-b",
        creativeDirection: existing[0]!.creativeDirection,
      }),
    ).toThrowError(/too close/);
  });

  it("records an explicitly scoped agent review as an agent decision", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const art = await addAsset(owner, "ast_print_agent", "sha-print-agent");
    const proposal = await createPrintProposal(owner, baseProposal(fixture, art));
    const agent = {
      ...owner,
      actor: {
        type: "agent" as const,
        id: "grant_print_review",
        representedUserId: owner.user!.id,
        label: "Delegated print reviewer",
      },
      scopes: ["content:write"],
    };
    await expect(
      reviewPrintProposal(agent, proposal.id, "approved", { note: "No review scope." }),
    ).rejects.toMatchObject({ code: "print_review_scope_required" });
    const scoped = { ...agent, scopes: ["content:write", "print:review"] };
    const approved = await reviewPrintProposal(scoped, proposal.id, "approved", {
      note: "Agent review under delegated authority: identity and provenance checked.",
      expectedRevision: proposal.revision,
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewer_kind).toBe("agent");
    const history = await listPrintProposalReviews(owner, proposal.id);
    expect(history.at(-1)?.reviewer_kind).toBe("agent");
  });

  it("requires an authorised reviewer and records approval, rejection and revision history", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const artA = await addAsset(owner, "ast_print_a", "sha-print-a");
    const artB = await addAsset(owner, "ast_print_b", "sha-print-b");
    const artC = await addAsset(owner, "ast_print_c", "sha-print-c");

    const first = await createPrintProposal(owner, baseProposal(fixture, artA));
    expect(first.status).toBe("proposed");
    await expect(
      reviewPrintProposal(player, first.id, "approved", { note: "Player cannot review." }),
    ).rejects.toMatchObject({ code: "print_review_forbidden" });

    const approved = await reviewPrintProposal(owner, first.id, "approved", {
      note: "Distinct portrait, provenance checked.",
      expectedRevision: 1,
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewed_by).toBe(owner.user!.id);
    expect(approved.revision).toBe(2);
    expect(approved.review_note).toContain("Distinct portrait");
    const firstHistory = await listPrintProposalReviews(owner, first.id);
    expect(firstHistory.map((row) => row.decision)).toEqual(["submitted", "approved"]);
    expect(firstHistory.map((row) => row.revision)).toEqual([1, 2]);

    await expect(
      reviewPrintProposal(owner, first.id, "approved", { note: "Again." }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const second = await createPrintProposal(owner, {
      ...baseProposal(fixture, artB),
      printNumber: "02",
      role: "action_scene",
      title: "Test One · Action",
      creativeDirection:
        "A new narrative action moment with a dynamic diagonal composition, environmental depth and motion cues.",
    });
    await expect(
      reviewPrintProposal(owner, second.id, "rejected", { note: "   " }),
    ).rejects.toMatchObject({ code: "print_rejection_note_required" });
    const rejected = await reviewPrintProposal(owner, second.id, "rejected", {
      note: "Pose reads as the same portrait. Request a different scene.",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.revision).toBe(2);
    expect(rejected.reviewed_by).toBe(owner.user!.id);

    const stale = await createPrintProposal(owner, {
      ...baseProposal(fixture, artC),
      printNumber: "03",
      role: "alternate_art",
      title: "Test One · Alternate",
      creativeDirection:
        "A full-bleed illustrative alternate in a different medium, colour story and composition.",
    });
    await expect(
      reviewPrintProposal(owner, stale.id, "approved", {
        note: "Stale review.",
        expectedRevision: 99,
      }),
    ).rejects.toMatchObject({ code: "stale_print_proposal_revision" });

    const revised = await revisePrintProposal(
      owner,
      second.id,
      {
        artworkAssetId: artB,
        creativeDirection:
          "A clearly different action scene: the subject mid-motion in a new environment, with a diagonal camera and readable silhouette.",
        note: "New scene direction after rejection.",
      },
      { expectedRevision: 2 },
    );
    expect(revised.status).toBe("draft");
    expect(revised.revision).toBe(3);
    expect(revised.reviewed_by).toBeNull();

    const resubmitted = await submitPrintProposal(owner, second.id, {
      note: "Revised action scene ready for another review.",
      expectedRevision: 3,
    });
    expect(resubmitted.status).toBe("proposed");
    expect(resubmitted.revision).toBe(4);
    const reapproved = await reviewPrintProposal(owner, second.id, "approved", {
      note: "Revised scene is genuinely different.",
      expectedRevision: 4,
    });
    expect(reapproved.status).toBe("approved");
    expect(reapproved.revision).toBe(5);
    const secondHistory = await listPrintProposalReviews(owner, second.id);
    expect(secondHistory.map((row) => row.decision)).toEqual([
      "submitted",
      "rejected",
      "revised",
      "submitted",
      "approved",
    ]);
  });

  it("links an approved proposal additively without touching editions, variants or copies", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const artA = await addAsset(owner, "ast_print_a", "sha-print-a");
    const artB = await addAsset(owner, "ast_print_b", "sha-print-b");
    const artC = await addAsset(owner, "ast_print_c", "sha-print-c");

    const proposal = await createPrintProposal(owner, baseProposal(fixture, artA));
    await reviewPrintProposal(owner, proposal.id, "approved", {
      note: "Approved for additive edition linkage.",
    });
    await makeInstance(owner, owner.user!.id, fixture, "TEST-PRINT-ADDITIVE");
    const originalEditionBefore = await runtime.DB.prepare(
      "SELECT * FROM fb_artwork_editions WHERE id = ?",
    )
      .bind(fixture.editionId)
      .first<Record<string, unknown>>();
    const variantsBefore = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_variants")
      .bind()
      .first<{ count: number }>();
    const instancesBefore = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances",
    )
      .bind()
      .first<{ count: number }>();

    const editionId = await addEdition(owner, "edt_print_a", fixture.cardId, artA);
    const linked = await linkApprovedEdition(owner, proposal.id, editionId, {
      expectedRevision: 2,
    });
    expect(linked.approved_edition_id).toBe(editionId);
    expect(linked.approved_edition?.id).toBe(editionId);
    expect(linked.revision).toBe(3);

    const originalEditionAfter = await runtime.DB.prepare(
      "SELECT * FROM fb_artwork_editions WHERE id = ?",
    )
      .bind(fixture.editionId)
      .first<Record<string, unknown>>();
    expect(originalEditionAfter).toEqual(originalEditionBefore);
    const variantsAfter = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_variants")
      .bind()
      .first<{ count: number }>();
    const instancesAfter = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances",
    )
      .bind()
      .first<{ count: number }>();
    expect(variantsAfter?.count).toBe(variantsBefore?.count);
    expect(instancesAfter?.count).toBe(instancesBefore?.count);

    const linkedAgain = await linkApprovedEdition(owner, proposal.id, editionId);
    expect(linkedAgain.revision).toBe(3);
    await expect(linkApprovedEdition(owner, proposal.id, fixture.editionId)).rejects.toMatchObject({
      code: "print_edition_already_linked",
    });

    const second = await createPrintProposal(owner, {
      ...baseProposal(fixture, artB),
      printNumber: "02",
      role: "action_scene",
      title: "Test One · Action",
      creativeDirection:
        "A new narrative action moment with a dynamic diagonal composition, environmental depth and motion cues.",
    });
    await reviewPrintProposal(owner, second.id, "approved", { note: "Approved second print." });
    await expect(linkApprovedEdition(owner, second.id, editionId)).rejects.toMatchObject({
      code: "print_edition_artwork_mismatch",
    });

    const draft = await createPrintProposal(owner, {
      ...baseProposal(fixture, artC),
      printNumber: "03",
      role: "alternate_art",
      title: "Test One · Alternate",
      creativeDirection:
        "A full-bleed illustrative alternate in a different medium, colour story and composition.",
      status: "draft",
    });
    await expect(linkApprovedEdition(owner, draft.id, editionId)).rejects.toMatchObject({
      code: "print_not_approved",
    });

    // A duplicate edition created after submission is caught again at approval.
    const artD = await addAsset(owner, "ast_print_d", "sha-print-d");
    const late = await createPrintProposal(owner, {
      ...baseProposal(fixture, artD),
      printNumber: "04",
      role: "special_release",
      title: "Test One · Special release",
      creativeDirection:
        "A special-release plate with its own event framing, a different composition and a distinct visual identity.",
    });
    await addEdition(owner, "edt_print_d", fixture.cardId, artD, "published");
    await expect(
      reviewPrintProposal(owner, late.id, "approved", {
        note: "This artwork now duplicates a published edition.",
      }),
    ).rejects.toMatchObject({ code: "print_duplicate" });
  });

  it("rejects a finish-only variation as a new print", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const artA = await addAsset(owner, "ast_print_a", "sha-print-a");

    const first = await createPrintProposal(owner, baseProposal(fixture, artA));
    expect(first.status).toBe("proposed");
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artA),
        printNumber: "02",
        finishKeys: ["silver"],
      }),
    ).rejects.toMatchObject({ code: "finish_is_not_a_print" });
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artA),
        printNumber: "02",
        title: "Test One · Gold Portrait",
        finishKeys: ["silver"],
      }),
    ).rejects.toMatchObject({ code: "finish_is_not_a_print" });
    await expect(
      createPrintProposal(owner, {
        ...baseProposal(fixture, artA),
        printNumber: "02",
        title: "Holographic",
        finishKeys: ["holographic"],
        status: "draft",
      }),
    ).rejects.toMatchObject({ code: "finish_is_not_a_print" });
  });

  it("builds and persists one bounded original-IP vertical slice with three print roles", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const artPortrait = await addAsset(owner, "ast_print_portrait", "sha-print-portrait");
    const artAction = await addAsset(owner, "ast_print_action", "sha-print-action");
    const artAlternate = await addAsset(owner, "ast_print_alternate", "sha-print-alternate");

    const planOnly = originalIpVerticalSlicePlan({
      cardId: fixture.cardId,
      subjectName: "Bubbles",
      sourceAssetId: fixture.subjectAsset,
    });
    expect(planOnly.prints).toHaveLength(3);
    expect(planOnly.prints.map((print) => print.role)).toEqual([
      "portrait",
      "action_scene",
      "alternate_art",
    ]);
    expect(planOnly.prints.map((print) => print.printNumber)).toEqual(["01", "02", "03"]);
    expect(new Set(planOnly.prints.map((print) => print.creativeDirection)).size).toBe(3);
    expect(planOnly.prints.every((print) => print.requiresNewArtwork)).toBe(true);
    expect(JSON.stringify(planOnly)).not.toMatch(/official artwork|licensed artwork|canon art/i);

    const editionsBefore = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_artwork_editions",
    )
      .bind()
      .first<{ count: number }>();
    const instancesBefore = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances",
    )
      .bind()
      .first<{ count: number }>();

    const slice = await createOriginalIpVerticalSlice(owner, {
      cardId: fixture.cardId,
      subjectName: "Bubbles",
      sourceAssetId: fixture.subjectAsset,
      artworkAssetIds: {
        portrait: artPortrait,
        action_scene: artAction,
        alternate_art: artAlternate,
      },
      sourceRefs: ["https://example.test/foilbury-original-source"],
    });
    expect(slice.plan.prints.every((print) => !print.requiresNewArtwork)).toBe(true);
    expect(slice.proposals).toHaveLength(3);
    expect(slice.proposals.map((proposal) => proposal.print_number)).toEqual(["01", "02", "03"]);
    expect(slice.proposals.every((proposal) => proposal.status === "draft")).toBe(true);
    expect(slice.proposals.every((proposal) => proposal.approved_edition_id === null)).toBe(true);
    expect(slice.proposals.map((proposal) => proposal.print_key)).toEqual([
      "test:one:01",
      "test:one:02",
      "test:one:03",
    ]);

    const editionsAfter = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_artwork_editions",
    )
      .bind()
      .first<{ count: number }>();
    const instancesAfter = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_card_instances",
    )
      .bind()
      .first<{ count: number }>();
    expect(editionsAfter?.count).toBe(editionsBefore?.count);
    expect(instancesAfter?.count).toBe(instancesBefore?.count);

    const coverage = await printCoverageForCard(owner, fixture.cardId);
    expect(coverage.by_status.draft).toBe(3);
    expect(coverage.approved_prints).toBe(0);
    expect(coverage.minimum_met).toBe(false);
    expect(coverage.label).toBe("planning");

    // One approved print is never silently a completed multi-print subject.
    await submitPrintProposal(owner, slice.proposals[0]!.id, { expectedRevision: 1 });
    const firstApproved = await reviewPrintProposal(owner, slice.proposals[0]!.id, "approved", {
      note: "Portrait approved after source and likeness review.",
      expectedRevision: 2,
    });
    expect(firstApproved.status).toBe("approved");
    const single = await printCoverageForCard(owner, fixture.cardId);
    expect(single.approved_prints).toBe(1);
    expect(single.minimum_met).toBe(false);
    expect(single.label).toBe("single_print_requires_exception");

    await submitPrintProposal(owner, slice.proposals[1]!.id, { expectedRevision: 1 });
    await reviewPrintProposal(owner, slice.proposals[1]!.id, "approved", {
      note: "Action scene approved as a genuinely different print.",
      expectedRevision: 2,
    });
    const pair = await printCoverageForCard(owner, fixture.cardId);
    expect(pair.approved_prints).toBe(2);
    expect(pair.distinct_approved_artwork).toBe(2);
    expect(pair.minimum_met).toBe(true);
    expect(pair.recommended_third).toBe(true);
    expect(pair.label).toBe("minimum_met");
    expect(pair.linked_editions).toBe(0);
  });

  it("keeps the proposal layer additive and free of inventory ownership", async () => {
    await bootstrap();
    const columns =
      (
        await runtime.DB.prepare(`PRAGMA table_info("fb_print_proposals")`).all<{
          name: string;
        }>()
      ).results ?? [];
    const names = columns.map((column) => column.name);
    expect(names).toContain("card_id");
    expect(names).toContain("source_asset_id");
    expect(names).toContain("approved_edition_id");
    expect(names).not.toContain("instance_id");
    expect(names).not.toContain("serial");
    expect(names).not.toContain("user_id");

    const editionColumns =
      (
        await runtime.DB.prepare(`PRAGMA table_info("fb_artwork_editions")`).all<{
          name: string;
        }>()
      ).results ?? [];
    expect(editionColumns.map((column) => column.name)).not.toContain("print_proposal_id");

    const reviewTable = await runtime.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fb_print_proposal_reviews'",
    ).first<{ name: string }>();
    expect(reviewTable?.name).toBe("fb_print_proposal_reviews");
  });
});
