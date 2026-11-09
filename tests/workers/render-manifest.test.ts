import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, runtime } from "./helpers";
import { sha256Hex } from "../../src/server/ids";
import { resolveAgent } from "../../src/server/context";
import { createAgentGrant } from "../../src/server/modules/identity";
import {
  queueBoundRender,
  claimBoundRender,
  readBoundRenderInputs,
  stageBoundRenderOutputs,
  publishBoundRender,
  createBoundDerivative,
  setBoundRenderOperator,
  prepareBoundRender,
  cancelBoundRender,
} from "../../src/server/modules/bound-render-jobs";
import { boundRenderImage, boundRenderThumb } from "./fixtures/bound-render-image";
import { BOUND_LINEAGE_TRIGGER_DEFINITIONS } from "../../src/server/modules/bound-lineage-trigger-definitions";
import {
  renderResponse,
  backRenderResponse,
  derivativeResponse,
} from "../../src/server/modules/media";
import { serveAsset } from "../../src/pages/media/asset/[id]";
import { readBoundDiscordAttachment } from "../../src/server/discord/delivery";
import { routeBoundRender } from "../../src/server/api/bound-render-router";
import type { DiscordEnv, DiscordInteraction } from "../../src/server/discord/types";
import {
  inspectBoundRender,
  reviewBoundRender,
} from "../../src/server/modules/bound-render-review";
import {
  commitRenderManifest,
  checkRenderManifestReferences,
  readRenderManifestInputs,
  renderManifestReferenceFence,
} from "../../src/server/modules/render-manifest";

async function example(existingTenantId?: string) {
  const tenantId = existingTenantId ?? `ten_${crypto.randomUUID()}`,
    bytes = new TextEncoder().encode("fixture input"),
    digest = await sha256Hex(bytes);
  async function asset(role: string) {
    const key = `tenants/${tenantId}/${role}`,
      object = await runtime.MEDIA.put(key, bytes);
    return {
      id: role,
      revision: 1,
      key,
      version: object.version,
      etag: object.etag,
      sha256: digest,
      kind:
        role === "back"
          ? ("brand" as const)
          : role === "background"
            ? ("background" as const)
            : ("subject" as const),
      processingState: "ready" as const,
      reviewStatus: "unreviewed",
      accessClassification: "private" as const,
      provenanceJson: "{}",
      dependenciesJson: "[]",
      bytes: bytes.length,
      mime: "image/png" as const,
    };
  }
  const [subject, background, back] = await Promise.all(
    ["subject", "background", "back"].map(asset),
  );
  return {
    bytes,
    input: {
      protocol: "foilbury-render-inputs-v1" as const,
      tenantId,
      cardId: "card",
      collectionId: "collection",
      variantId: "variant",
      editionId: "edition",
      editionName: "Test edition",
      recipeId: "recipe",
      cardVersion: 1,
      editionSourceHash: null,
      recipeVersion: 1,
      recipeConfig: "{}",
      metadata: {
        name: "Name",
        subtitle: "Subtitle",
        setName: "Album",
        serial: "MEMBER EDITION" as const,
        className: "Class",
        rarity: "Rare",
        material: "gold" as const,
        effect: "none" as const,
        composition: { mode: "contain" as const, zoom: 1, offsetX: 0, offsetY: 0 },
      },
      assets: { subject, background, back, mark: null },
      renderer: {
        bundleSha256: digest,
        lockfileSha256: digest,
        runtimeImageSha256: digest,
        fonts: { fraunces: digest, manrope: digest, monoRegular: digest, monoSemibold: digest },
        layers: { material: digest, frame: digest, effect: null },
      },
    },
  };
}
describe("versioned render manifest prerequisite", () => {
  it("rejects changed or cross-linked database references without publishing", async () => {
    await bootstrap();
    const ctx = await ctxFor("cabinet", "owner@foilbury.local"),
      fixture = await fixturePool(ctx);
    const { input } = await example(ctx.tenant.id),
      now = new Date().toISOString();
    input.cardId = fixture.cardId;
    input.variantId = fixture.variantId;
    input.editionId = fixture.editionId;
    input.recipeId = fixture.recipeId;
    input.collectionId = "col_test_public";
    const records = [input.assets.subject, input.assets.background, input.assets.back];
    for (const [index, record] of records.entries()) {
      await runtime.DB.prepare(
        `INSERT INTO fb_assets(id,tenant_id,kind,name,mime,bytes,r2_key,sha256,visibility,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          record.id,
          ctx.tenant.id,
          index === 0 ? "subject" : index === 1 ? "background" : "brand",
          record.id,
          record.mime,
          record.bytes,
          record.key,
          record.sha256,
          "private",
          now,
        )
        .run();
    }
    await runtime.DB.prepare(
      "UPDATE fb_artwork_editions SET subject_asset_id=?,background_asset_id=? WHERE id=?",
    )
      .bind(input.assets.subject.id, input.assets.background.id, fixture.editionId)
      .run();
    await runtime.DB.prepare("UPDATE fb_card_definitions SET card_back_asset_id=? WHERE id=?")
      .bind(input.assets.back.id, fixture.cardId)
      .run();
    const recipe = await runtime.DB.prepare("SELECT version,config_json FROM fb_recipes WHERE id=?")
      .bind(fixture.recipeId)
      .first<{ version: number; config_json: string }>();
    await runtime.DB.prepare(
      "UPDATE fb_artwork_editions SET composition_json=?,source_hash=NULL WHERE id=?",
    )
      .bind(JSON.stringify({ mode: "contain", zoom: 1, offsetX: 0, offsetY: 0 }), fixture.editionId)
      .run();
    const edition = await runtime.DB.prepare(
      "SELECT source_hash FROM fb_artwork_editions WHERE id=?",
    )
      .bind(fixture.editionId)
      .first<{ source_hash: string | null }>();
    const candidate = {
      ...input,
      editionSourceHash: edition!.source_hash,
      recipeVersion: recipe!.version,
      recipeConfig: recipe!.config_json,
      metadata: {
        ...input.metadata,
        name: "Test One",
        subtitle: "Test subject",
        setName: "Test Public",
        className: "",
        rarity: "",
        serial: "PUBLIC SHOWCASE" as const,
        material: "plain" as const,
      },
    };
    expect(await checkRenderManifestReferences(runtime.DB, candidate)).toEqual({ matched: true });
    // The reference query must also be usable inside a D1 mutation, where a
    // preceding update in the same batch has to make a stale snapshot fail.
    const fence = await renderManifestReferenceFence(candidate);
    await runtime.DB.prepare(
      "CREATE TABLE IF NOT EXISTS test_render_reference_fence (id TEXT PRIMARY KEY)",
    ).run();
    await runtime.DB.prepare(
      `INSERT INTO test_render_reference_fence (id) SELECT ? WHERE ${fence.predicate}`,
    )
      .bind("current", ...fence.args)
      .run();
    await runtime.DB.batch([
      runtime.DB.prepare(
        "UPDATE fb_card_definitions SET name='Changed in transaction' WHERE id=?",
      ).bind(fixture.cardId),
      runtime.DB.prepare(
        `INSERT INTO test_render_reference_fence (id) SELECT ? WHERE ${fence.predicate}`,
      ).bind("stale", ...fence.args),
    ]);
    expect(
      await runtime.DB.prepare("SELECT id FROM test_render_reference_fence ORDER BY id").all(),
    ).toMatchObject({ results: [{ id: "current" }] });
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name='Test One' WHERE id=?")
      .bind(fixture.cardId)
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_artwork_editions SET name='Test One — Night Print' WHERE id=?",
    )
      .bind(fixture.editionId)
      .run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    const printCandidate = {
      ...candidate,
      editionName: "Test One — Night Print",
      metadata: { ...candidate.metadata, subtitle: "Night Print", className: "Print" },
    };
    expect(await checkRenderManifestReferences(runtime.DB, printCandidate)).toEqual({
      matched: true,
    });
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET name='Test edition' WHERE id=?")
      .bind(fixture.editionId)
      .run();
    await runtime.DB.prepare("UPDATE fb_assets SET revision=revision+1 WHERE id=?")
      .bind(input.assets.subject.id)
      .run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare("UPDATE fb_assets SET revision=revision-1 WHERE id=?")
      .bind(input.assets.subject.id)
      .run();
    await runtime.DB.prepare("UPDATE fb_assets SET review_status='rejected' WHERE id=?")
      .bind(input.assets.subject.id)
      .run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare("UPDATE fb_assets SET review_status='unreviewed' WHERE id=?")
      .bind(input.assets.subject.id)
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_collections SET logo_url='/some-mark.svg' WHERE id='col_test_public'",
    ).run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare(
      "UPDATE fb_collections SET logo_url=NULL WHERE id='col_test_public'",
    ).run();
    const wrong = structuredClone(candidate);
    wrong.collectionId = "other";
    await expect(checkRenderManifestReferences(runtime.DB, wrong)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name='Changed' WHERE id=?")
      .bind(fixture.cardId)
      .run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name='Test One' WHERE id=?")
      .bind(fixture.cardId)
      .run();
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET composition_json=? WHERE id=?")
      .bind(JSON.stringify({ mode: "contain", zoom: 1, offsetX: 1, offsetY: 0 }), fixture.editionId)
      .run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare("UPDATE fb_artwork_editions SET composition_json=? WHERE id=?")
      .bind(JSON.stringify({ mode: "contain", zoom: 1, offsetX: 0, offsetY: 0 }), fixture.editionId)
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'",
    ).run();
    await expect(checkRenderManifestReferences(runtime.DB, candidate)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    const memberCandidate = {
      ...candidate,
      metadata: { ...candidate.metadata, serial: "MEMBER EDITION" as const },
    };
    expect(await checkRenderManifestReferences(runtime.DB, memberCandidate)).toEqual({
      matched: true,
    });

    // The new protocol has no default operator or automatic art review.
    const reviewed = structuredClone(memberCandidate);
    for (const record of [
      reviewed.assets.subject,
      reviewed.assets.background,
      reviewed.assets.back,
    ]) {
      record.reviewStatus = "approved";
      await runtime.DB.prepare("UPDATE fb_assets SET review_status='approved' WHERE id=?")
        .bind(record.id)
        .run();
    }
    const issued = await createAgentGrant(ctx, {
      agentName: "renderer",
      representedUserId: ctx.user!.id,
      scopes: ["render:write"],
      expiresInDays: 1,
    });
    const resolved = await resolveAgent(runtime.DB, ctx.config, issued.token, ctx.tenant);
    const agent = { ...ctx, ...resolved, agentCredential: resolved.credential };
    await expect(queueBoundRender(agent, reviewed, "render-request-1")).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await expect(
      setBoundRenderOperator(ctx, issued.grantId, resolved.credential.tokenId, true),
    ).rejects.toMatchObject({ code: "strong_auth_required" });
    const sessionId = `render-review-${crypto.randomUUID()}`;
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions(id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        sessionId,
        `${sessionId}-hash`,
        ctx.user!.id,
        ctx.tenant.id,
        "test",
        now,
        new Date(Date.now() + 3600000).toISOString(),
        now,
        "passkey",
        now,
      )
      .run();
    const human = { ...ctx, sessionId, sessionAssurance: "passkey", sessionAuthTime: now };
    expect(
      await setBoundRenderOperator(human, issued.grantId, resolved.credential.tokenId, true),
    ).toMatchObject({ status: "active" });
    const prepared = await prepareBoundRender(
      agent,
      fixture.variantId,
      "col_test_public",
      reviewed.renderer,
    );
    expect(prepared.manifest).toEqual(reviewed);
    const prepareRequest = new Request(
      "https://fixture.invalid/api/v1/admin/bound-renders/prepare",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variantId: fixture.variantId,
          collectionId: "col_test_public",
          renderer: reviewed.renderer,
        }),
      },
    );
    expect(
      await (
        await routeBoundRender(prepareRequest, agent, ["admin", "bound-renders", "prepare"])
      ).json(),
    ).toEqual(prepared);
    const queued = await queueBoundRender(agent, reviewed, "render-request-1");
    expect(await queueBoundRender(agent, reviewed, "render-request-1")).toEqual(queued);
    const queueRequest = new Request("https://fixture.invalid/queue", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "render-request-1" },
      body: JSON.stringify({ manifest: reviewed }),
    });
    expect(
      await (
        await routeBoundRender(queueRequest, agent, ["admin", "bound-renders", "queue"])
      ).json(),
    ).toEqual(queued);
    await expect(
      queueBoundRender(
        agent,
        { ...reviewed, metadata: { ...reviewed.metadata, name: "Changed" } },
        "render-request-1",
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const claimResponse = await routeBoundRender(
      new Request("https://fixture.invalid/claim", { method: "POST" }),
      agent,
      ["admin", "bound-renders", queued.id, "claim"],
    );
    const claimed = await claimResponse.json();
    expect(claimed).toMatchObject({ id: queued.id, attempt: 1, manifest: reviewed });
    const inputResponse = await routeBoundRender(
      new Request("https://fixture.invalid/input?attempt=1"),
      agent,
      ["admin", "bound-renders", queued.id, "inputs", "subject"],
    );
    expect(new Uint8Array(await inputResponse.arrayBuffer())).toEqual(
      new TextEncoder().encode("fixture input"),
    );
    await expect(claimBoundRender(agent, queued.id)).rejects.toMatchObject({
      code: "render_job_unavailable",
    });
    expect((await readBoundRenderInputs(agent, queued.id, 1)).bytes.subject).toEqual(
      new TextEncoder().encode("fixture input"),
    );
    let revoked = false;
    const media = new Proxy(runtime.MEDIA, {
      get(target, property) {
        if (property === "get")
          return async (...args: Parameters<R2Bucket["get"]>) => {
            if (!revoked) {
              revoked = true;
              await runtime.DB.prepare(
                "UPDATE fb_render_operators SET status='revoked' WHERE token_id=?",
              )
                .bind(resolved.credential.tokenId)
                .run();
            }
            return target.get(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(readBoundRenderInputs({ ...agent, media }, queued.id, 1)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare("UPDATE fb_render_operators SET status='active' WHERE token_id=?")
      .bind(resolved.credential.tokenId)
      .run();
    const renderBefore = await runtime.DB.prepare(
      "SELECT asset_id FROM fb_variant_renders WHERE variant_id=?",
    )
      .bind(fixture.variantId)
      .first();
    const form = new FormData();
    form.set("front", new File([boundRenderImage], "front.webp", { type: "image/webp" }));
    form.set("back", new File([boundRenderImage], "back.webp", { type: "image/webp" }));
    form.set("attempt", "1");
    const stageResponse = await routeBoundRender(
      new Request("https://fixture.invalid/stage", { method: "POST", body: form }),
      agent,
      ["admin", "bound-renders", queued.id, "stage"],
    );
    expect(await stageResponse.json()).toEqual({
      id: queued.id,
      attempt: 1,
      status: "awaiting_review",
    });
    const reviewRoute = await routeBoundRender(
      new Request("https://fixture.invalid/review"),
      human,
      ["admin", "bound-renders", queued.id, "review"],
    );
    expect(await reviewRoute.json()).toMatchObject({ manifestSha256: prepared.sha256, attempt: 1 });
    const previewRoute = await routeBoundRender(
      new Request("https://fixture.invalid/preview"),
      human,
      ["admin", "bound-renders", queued.id, "preview", "front"],
    );
    expect(new Uint8Array(await previewRoute.arrayBuffer())).toEqual(boundRenderImage);
    await expect(
      routeBoundRender(new Request("https://fixture.invalid/extra"), human, [
        "admin",
        "bound-renders",
        queued.id,
        "preview",
        "front",
        "extra",
      ]),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await stageBoundRenderOutputs(agent, queued.id, 1, boundRenderImage, boundRenderImage),
    ).toEqual({ id: queued.id, attempt: 1, status: "awaiting_review" });
    expect(
      await runtime.DB.prepare(
        "SELECT count(*) AS n FROM fb_bound_render_candidates WHERE job_id=?",
      )
        .bind(queued.id)
        .first(),
    ).toMatchObject({ n: 2 });
    expect(
      await runtime.DB.prepare("SELECT asset_id FROM fb_variant_renders WHERE variant_id=?")
        .bind(fixture.variantId)
        .first(),
    ).toEqual(renderBefore);
    const staged = await runtime.DB.prepare(
      "SELECT r2_key FROM fb_bound_render_candidates WHERE job_id=? AND side='front'",
    )
      .bind(queued.id)
      .first<{ r2_key: string }>();
    await runtime.MEDIA.put(staged!.r2_key, new TextEncoder().encode("replacement"));
    await expect(
      stageBoundRenderOutputs(agent, queued.id, 1, boundRenderImage, boundRenderImage),
    ).rejects.toMatchObject({ code: "render_input_changed" });
    await expect(
      queueBoundRender(agent, reviewed, "render-concurrent-variant"),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    expect(await cancelBoundRender(human, queued.id)).toMatchObject({ status: "failed" });
    expect(await cancelBoundRender(human, queued.id)).toMatchObject({ status: "failed" });

    const next = await queueBoundRender(agent, reviewed, "render-request-race");
    await claimBoundRender(agent, next.id);
    const changingDb = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            await target
              .prepare(
                "UPDATE fb_card_definitions SET name='Changed during output staging' WHERE id=?",
              )
              .bind(fixture.cardId)
              .run();
            return target.batch(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      stageBoundRenderOutputs(
        { ...agent, db: changingDb },
        next.id,
        1,
        boundRenderImage,
        boundRenderImage,
      ),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    expect(
      await runtime.DB.prepare(
        "SELECT count(*) AS n FROM fb_bound_render_candidates WHERE job_id=?",
      )
        .bind(next.id)
        .first(),
    ).toMatchObject({ n: 0 });
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name='Test One' WHERE id=?")
      .bind(fixture.cardId)
      .run();
    const failingDb = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) =>
            target.batch([...statements, target.prepare("SELECT json('invalid')")]);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      stageBoundRenderOutputs(
        { ...agent, db: failingDb },
        next.id,
        1,
        boundRenderImage,
        boundRenderImage,
      ),
    ).rejects.toThrow();
    expect(
      await runtime.DB.prepare("SELECT status FROM fb_bound_render_jobs WHERE id=?")
        .bind(next.id)
        .first(),
    ).toMatchObject({ status: "running" });
    expect(
      await runtime.DB.prepare(
        "SELECT count(*) AS n FROM fb_bound_render_candidates WHERE job_id=?",
      )
        .bind(next.id)
        .first(),
    ).toMatchObject({ n: 0 });
    expect(
      await stageBoundRenderOutputs(agent, next.id, 1, boundRenderImage, boundRenderImage),
    ).toMatchObject({ status: "awaiting_review" });

    const reviewerGrant = await createAgentGrant(ctx, {
      agentName: "creative-reviewer",
      representedUserId: ctx.user!.id,
      scopes: ["content:write"],
      expiresInDays: 1,
    });
    const reviewerResolved = await resolveAgent(
      runtime.DB,
      ctx.config,
      reviewerGrant.token,
      ctx.tenant,
    );
    const reviewer = { ...ctx, ...reviewerResolved, agentCredential: reviewerResolved.credential };
    // A delegated bearer does not gain platform root from its represented user.
    await expect(inspectBoundRender(reviewer,next.id)).rejects.toMatchObject({code:'render_review_forbidden'});
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments(id,user_id,role,scopes_json,status,granted_by,granted_at,reason) VALUES ('render-review-scope',?,'global_collection_admin',?,'active',?,?,'Fixture')")
      .bind(ctx.user!.id,JSON.stringify({all:false,collectionIds:['col_test_public']}),ctx.user!.id,now).run();
    const reviewPreview = await inspectBoundRender(reviewer, next.id);
    const reviewInput = {
      decision: "approved" as const,
      manifestSha256: reviewPreview.manifestSha256,
      frontSha256: reviewPreview.front.sha256,
      backSha256: reviewPreview.back.sha256,
      note: "Reviewed both synthetic sides.",
    };
    const revokedReviewDb = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            await target
              .prepare("UPDATE fb_agent_tokens SET token_hash='reviewer-rotated' WHERE id=?")
              .bind(reviewerResolved.credential.tokenId)
              .run();
            return target.batch(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      reviewBoundRender({ ...reviewer, db: revokedReviewDb }, next.id, reviewInput),
    ).rejects.toMatchObject({ code: "render_review_forbidden" });
    expect(
      await runtime.DB.prepare("SELECT count(*) n FROM fb_bound_render_reviews WHERE job_id=?")
        .bind(next.id)
        .first(),
    ).toMatchObject({ n: 0 });
    await runtime.DB.prepare("UPDATE fb_agent_tokens SET token_hash=? WHERE id=?")
      .bind(reviewerResolved.credential.verifiedTokenHash, reviewerResolved.credential.tokenId)
      .run();
    const reviewedResult = await reviewBoundRender(reviewer, next.id, reviewInput);
    expect(reviewedResult).toMatchObject({ decision: "approved" });
    expect(await reviewBoundRender(reviewer, next.id, reviewInput)).toEqual(reviewedResult);
    await expect(
      reviewBoundRender(reviewer, next.id, { ...reviewInput, note: "Different review" }),
    ).rejects.toMatchObject({ code: "render_review_changed" });
    expect(
      await runtime.DB.prepare(
        "SELECT actor_type,actor_id FROM fb_bound_render_reviews WHERE job_id=?",
      )
        .bind(next.id)
        .first(),
    ).toMatchObject({ actor_type: "agent", actor_id: reviewer.actor.id });
    expect(await cancelBoundRender(human, next.id)).toMatchObject({ status: "failed" });

    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'",
    ).run();
    await runtime.DB.prepare(
      "DELETE FROM fb_platform_role_assignments WHERE user_id=? AND role='global_collection_admin'",
    )
      .bind(ctx.user!.id)
      .run();
    await expect(
      prepareBoundRender(agent, fixture.variantId, "col_test_public", reviewed.renderer),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    await runtime.DB.prepare(
      "INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES ('col_test_public',?,?,?)",
    )
      .bind(ctx.user!.id, ctx.user!.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_collections(id,slug,name,scope,status,view_audience,created_by,created_at,updated_at) VALUES ('render_other_private','render-other-private','Other private','global','published','private',?,?,?)",
    )
      .bind(ctx.user!.id, now, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_collection_cards(collection_id,card_id,tenant_id,added_by,added_at) VALUES ('render_other_private',?,?,?,?)",
    )
      .bind(fixture.cardId, ctx.tenant.id, ctx.user!.id, now)
      .run();
    await expect(
      prepareBoundRender(agent, fixture.variantId, "col_test_public", reviewed.renderer),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    await runtime.DB.prepare(
      "INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES ('render_other_private',?,?,?)",
    )
      .bind(ctx.user!.id, ctx.user!.id, now)
      .run();
    const privatePrepared = await prepareBoundRender(
      agent,
      fixture.variantId,
      "col_test_public",
      reviewed.renderer,
    );
    expect(privatePrepared.manifest.metadata.serial).toBe("PRIVATE EDITION");
    const privateJob = await queueBoundRender(
      agent,
      privatePrepared.manifest,
      "render-private-test",
    );
    await claimBoundRender(agent, privateJob.id);
    // The same subject is also used by a different, restricted card. Its
    // audience must be checked before the executor receives any source bytes.
    await runtime.DB.batch([
      runtime.DB.prepare("INSERT INTO fb_collections(id,slug,name,scope,status,view_audience,created_by,created_at,updated_at) VALUES ('render_shared_private','render-shared-private','Shared private','global','published','private',?,?,?)").bind(ctx.user!.id, now, now),
      runtime.DB.prepare("INSERT INTO fb_card_definitions(id,tenant_id,logical_id,slug,name,subtitle,description,status,created_at,updated_at,version) VALUES ('render_shared_card',?,'render:shared','render-shared','Shared','Shared','Shared','published',?,?,1)").bind(ctx.tenant.id,now,now),
      runtime.DB.prepare("INSERT INTO fb_collection_cards(collection_id,card_id,tenant_id,added_by,added_at) VALUES ('render_shared_private','render_shared_card',?,?,?)").bind(ctx.tenant.id,ctx.user!.id,now),
      runtime.DB.prepare("INSERT INTO fb_artwork_editions(id,tenant_id,card_id,name,subject_asset_id,recipe_id,status,source_repo,source_path,source_commit,source_hash,created_at) VALUES ('render_shared_edition',?,'render_shared_card','Shared',?,?,'published','fixture','fixture','fixture','fixture',?)").bind(ctx.tenant.id,input.assets.subject.id,fixture.recipeId,now),
    ]);
    await expect(readBoundRenderInputs(agent, privateJob.id, 1)).rejects.toMatchObject({code:'render_inputs_changed'});
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments(id,user_id,role,scopes_json,status,granted_by,granted_at,reason) VALUES ('render-source-scope',?,'global_collection_admin',?,'active',?,?,'Fixture')")
      .bind(ctx.user!.id,JSON.stringify({all:false,collectionIds:['render_shared_private']}),ctx.user!.id,now).run();
    expect((await readBoundRenderInputs(agent,privateJob.id,1)).bytes.subject).toBeTruthy();
    await runtime.DB.prepare("DELETE FROM fb_platform_role_assignments WHERE id='render-source-scope'").run();
    await expect(readBoundRenderInputs(agent, privateJob.id, 1)).rejects.toMatchObject({code:'render_inputs_changed'});
    // Bot ownership permits the bound Bot's private source, but not a global
    // private source merely owned by the same tenant.
    await runtime.DB.prepare("UPDATE fb_collections SET scope='bot',owner_tenant_id=? WHERE id='render_shared_private'").bind(ctx.tenant.id).run();
    expect((await readBoundRenderInputs(agent,privateJob.id,1)).bytes.subject).toBeTruthy();
    const otherOwner=await runtime.DB.prepare('SELECT id FROM fb_users WHERE id<>? LIMIT 1').bind(ctx.user!.id).first<{id:string}>();
    expect(otherOwner).toBeTruthy();
    await runtime.DB.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(otherOwner!.id,ctx.tenant.id).run();
    await expect(readBoundRenderInputs(agent,privateJob.id,1)).rejects.toMatchObject({code:'render_job_unavailable'});
    await runtime.DB.prepare('UPDATE fb_bots SET owner_user_id=? WHERE tenant_id=?').bind(ctx.user!.id,ctx.tenant.id).run();
    await runtime.DB.prepare("UPDATE fb_collections SET scope='global' WHERE id='render_shared_private'").run();
    await expect(readBoundRenderInputs(agent,privateJob.id,1)).rejects.toMatchObject({code:'render_inputs_changed'});
    await runtime.DB.prepare("INSERT INTO fb_collection_viewers(collection_id,user_id,granted_by,created_at) VALUES ('render_shared_private',?,?,?)").bind(ctx.user!.id,ctx.user!.id,now).run();
    expect((await readBoundRenderInputs(agent, privateJob.id, 1)).bytes.subject).toBeTruthy();
    const [missingTrigger, triggerSql] = BOUND_LINEAGE_TRIGGER_DEFINITIONS[0];
    await runtime.DB.prepare(`DROP TRIGGER "${missingTrigger}"`).run();
    await expect(readBoundRenderInputs(agent,privateJob.id,1)).rejects.toMatchObject({code:'render_lineage_unavailable'});
    // Trusted repair invalidates prior snapshots; this does not claim that an
    // identical out-of-band drop/recreate can be detected automatically.
    await runtime.DB.batch([runtime.DB.prepare(triggerSql),runtime.DB.prepare('UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1')]);
    let revokedDuringRead = false;
    const revokeMedia = new Proxy(runtime.MEDIA, { get(target, property) {
      if (property === 'get') return async (...args: Parameters<typeof target.get>) => {
        if (!revokedDuringRead) { revokedDuringRead = true; await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='render_shared_private' AND user_id=?").bind(now,ctx.user!.id).run(); }
        return target.get(...args);
      };
      const value=Reflect.get(target,property,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(readBoundRenderInputs({...agent,media:revokeMedia},privateJob.id,1)).rejects.toMatchObject({code:'render_inputs_changed'});
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='render_shared_private' AND user_id=?").bind(ctx.user!.id).run();
    await runtime.DB.prepare(
      "UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?",
    )
      .bind(now, ctx.user!.id)
      .run();
    await expect(readBoundRenderInputs(agent, privateJob.id, 1)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare(
      "UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='col_test_public' AND user_id=?",
    )
      .bind(ctx.user!.id)
      .run();
    await stageBoundRenderOutputs(agent, privateJob.id, 1, boundRenderImage, boundRenderImage);
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments(id,user_id,role,scopes_json,status,granted_by,granted_at,reason) VALUES ('render-review-scope-private',?,'global_collection_admin',?,'active',?,?,'Fixture')")
      .bind(ctx.user!.id,JSON.stringify({all:false,collectionIds:['col_test_public']}),ctx.user!.id,now).run();
    const privatePreview = await inspectBoundRender(reviewer, privateJob.id);
    const privateInput = {
      decision: "approved" as const,
      manifestSha256: privatePreview.manifestSha256,
      frontSha256: privatePreview.front.sha256,
      backSha256: privatePreview.back.sha256,
      note: "Reviewed private fixture.",
    };
    const revokeSharedAtBatch = new Proxy(runtime.DB, {get(target,property) {
      if (property === 'batch') return async (...args: Parameters<D1Database['batch']>) => {
        await target.prepare("UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='render_shared_private' AND user_id=?").bind(now,ctx.user!.id).run();
        return target.batch(...args);
      };
      const value=Reflect.get(target,property,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    await expect(reviewBoundRender({...reviewer,db:revokeSharedAtBatch},privateJob.id,privateInput)).rejects.toMatchObject({code:'render_inputs_changed'});
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='render_shared_private' AND user_id=?").bind(ctx.user!.id).run();
    expect(await reviewBoundRender(reviewer, privateJob.id, privateInput)).toMatchObject({
      decision: "approved",
    });
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET status='revoked' WHERE id='render-review-scope-private'").run();
    await runtime.DB.prepare(
      "UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='col_test_public' AND user_id=?",
    )
      .bind(now, ctx.user!.id)
      .run();
    await expect(publishBoundRender(agent, privateJob.id, 1)).rejects.toMatchObject({
      code: "render_inputs_changed",
    });
    await runtime.DB.prepare(
      "UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='col_test_public' AND user_id=?",
    )
      .bind(ctx.user!.id)
      .run();
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET status='active' WHERE id='render-review-scope-private'").run();
    const revokeSecondDb = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            await target
              .prepare(
                "UPDATE fb_collection_viewers SET revoked_at=? WHERE collection_id='render_other_private' AND user_id=?",
              )
              .bind(now, ctx.user!.id)
              .run();
            return target.batch(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      publishBoundRender({ ...agent, db: revokeSecondDb }, privateJob.id, 1),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    expect(
      await runtime.DB.prepare("SELECT count(*) n FROM fb_bound_render_outputs WHERE job_id=?")
        .bind(privateJob.id)
        .first(),
    ).toMatchObject({ n: 0 });
    await runtime.DB.prepare(
      "UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='render_other_private' AND user_id=?",
    )
      .bind(ctx.user!.id)
      .run();
    await expect(publishBoundRender({...agent,db:revokeSharedAtBatch},privateJob.id,1)).rejects.toMatchObject({code:'render_inputs_changed'});
    await runtime.DB.prepare("UPDATE fb_collection_viewers SET revoked_at=NULL WHERE collection_id='render_shared_private' AND user_id=?").bind(ctx.user!.id).run();
    expect(await publishBoundRender(agent, privateJob.id, 1)).toHaveProperty("front");
    await runtime.DB.batch([
      runtime.DB.prepare("DELETE FROM fb_collection_viewers WHERE collection_id='render_shared_private'"),
      runtime.DB.prepare("DELETE FROM fb_artwork_editions WHERE id='render_shared_edition'"),
      runtime.DB.prepare("DELETE FROM fb_collection_cards WHERE collection_id='render_shared_private'"),
      runtime.DB.prepare("DELETE FROM fb_card_definitions WHERE id='render_shared_card'"),
      runtime.DB.prepare("DELETE FROM fb_collections WHERE id='render_shared_private'"),
    ]);
    const beforePublic = await runtime.DB.prepare(
      "SELECT asset_id FROM fb_variant_renders WHERE variant_id=?",
    )
      .bind(fixture.variantId)
      .first<{ asset_id: string }>();
    await runtime.DB.prepare(
      "DELETE FROM fb_collection_cards WHERE collection_id='render_other_private' AND card_id=?",
    )
      .bind(fixture.cardId)
      .run();

    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='public' WHERE id='col_test_public'",
    ).run();
    const publicCandidate = {
      ...reviewed,
      metadata: { ...reviewed.metadata, serial: "PUBLIC SHOWCASE" as const },
    };
    const pub = await queueBoundRender(agent, publicCandidate, "render-public-test");
    await claimBoundRender(agent, pub.id);
    await stageBoundRenderOutputs(agent, pub.id, 1, boundRenderImage, boundRenderImage);
    const publicPreview = await inspectBoundRender(reviewer, pub.id);
    const publicInput = {
      decision: "approved" as const,
      manifestSha256: publicPreview.manifestSha256,
      frontSha256: publicPreview.front.sha256,
      backSha256: publicPreview.back.sha256,
      note: "Reviewed public fixture.",
    };
    await expect(reviewBoundRender(reviewer, pub.id, publicInput)).rejects.toMatchObject({
      code: "human_public_approval_required",
    });
    const reviewRequest = new Request("https://fixture.invalid/review", {
      method: "POST",
      headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
      body: JSON.stringify(publicInput),
    });
    expect(
      await (
        await routeBoundRender(reviewRequest, human, ["admin", "bound-renders", pub.id, "review"])
      ).json(),
    ).toMatchObject({
      decision: "approved",
    });

    const publicationFailureDb = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) =>
            target.batch([...statements, target.prepare("SELECT json('invalid')")]);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      publishBoundRender({ ...agent, db: publicationFailureDb }, pub.id, 1),
    ).rejects.toThrow();
    expect(
      await runtime.DB.prepare("SELECT status FROM fb_bound_render_jobs WHERE id=?")
        .bind(pub.id)
        .first(),
    ).toMatchObject({ status: "approved" });
    expect(
      await runtime.DB.prepare("SELECT count(*) n FROM fb_bound_render_outputs WHERE job_id=?")
        .bind(pub.id)
        .first(),
    ).toMatchObject({ n: 0 });
    expect(
      await runtime.DB.prepare("SELECT asset_id FROM fb_variant_renders WHERE variant_id=?")
        .bind(fixture.variantId)
        .first(),
    ).toEqual(beforePublic);
    const revokePublishDb = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            await target
              .prepare("UPDATE fb_render_operators SET status='revoked' WHERE token_id=?")
              .bind(resolved.credential.tokenId)
              .run();
            return target.batch(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      publishBoundRender({ ...agent, db: revokePublishDb }, pub.id, 1),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    expect(
      await runtime.DB.prepare("SELECT count(*) n FROM fb_bound_render_outputs WHERE job_id=?")
        .bind(pub.id)
        .first(),
    ).toMatchObject({ n: 0 });
    await runtime.DB.prepare("UPDATE fb_render_operators SET status='active' WHERE token_id=?")
      .bind(resolved.credential.tokenId)
      .run();
    const publishRequest = new Request("https://fixture.invalid/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt: 1 }),
    });
    const published = await (
      await routeBoundRender(publishRequest, agent, ["admin", "bound-renders", pub.id, "publish"])
    ).json();
    expect(await publishBoundRender(agent, pub.id, 1)).toEqual(published);
    expect(
      await runtime.DB.prepare("SELECT count(*) n FROM fb_bound_render_outputs WHERE job_id=?")
        .bind(pub.id)
        .first(),
    ).toMatchObject({ n: 2 });
    expect(
      await runtime.DB.prepare(
        "SELECT count(*) n FROM fb_outbox WHERE topic='render.completed' AND json_extract(payload_json,'$.job_id')=?",
      )
        .bind(pub.id)
        .first(),
    ).toMatchObject({ n: 1 });
    const pair = published as { front: { assetId: string }; back: { assetId: string } };
    const response = () =>
      renderResponse(human, runtime.MEDIA, pair.front.assetId, {
        publicOnly: false,
        request: new Request("https://fixture.invalid/media"),
      });
    // A dirty but unrelated URL does not hide the new rendition. A legacy
    // encoded use of the retained old output must instead keep it in the
    // shared graph and withhold the new output until that use is removed.
    expect((await response()).status).toBe(200);
    const anonymous = {...human,user:null,actor:{type:'system' as const,id:'anonymous',representedUserId:null,label:'Anonymous'},sessionId:null,sessionAssurance:null,accessIdentity:null,accessStatus:null};
    expect((await renderResponse(anonymous,runtime.MEDIA,pair.front.assetId,{publicOnly:true,request:new Request('https://fixture.invalid/media')})).status).toBe(200);
    expect((await renderResponse(agent,runtime.MEDIA,pair.front.assetId,{publicOnly:true,request:new Request('https://fixture.invalid/media')})).status).toBe(200);
    let tokenRotatedOnServe=false;
    const rotatedServeMedia = new Proxy(runtime.MEDIA,{get(target,property) {
      if (property === 'get') return async (...args: Parameters<typeof target.get>) => {
        if (!tokenRotatedOnServe) { tokenRotatedOnServe=true; await runtime.DB.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind('rotated-hash',resolved.credential.tokenId).run(); }
        return target.get(...args);
      };
      const value=Reflect.get(target,property,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    expect((await renderResponse(agent,rotatedServeMedia,pair.front.assetId,{publicOnly:true,request:new Request('https://fixture.invalid/media')})).status).toBe(404);
    await runtime.DB.prepare('UPDATE fb_agent_tokens SET token_hash=? WHERE id=?').bind(resolved.credential.verifiedTokenHash,resolved.credential.tokenId).run();
    let sessionRevokedOnServe=false;
    const revokedServeMedia = new Proxy(runtime.MEDIA, { get(target,property) {
      if (property === 'get') return async (...args: Parameters<typeof target.get>) => {
        if (!sessionRevokedOnServe) { sessionRevokedOnServe=true; await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=? WHERE id=?').bind(now,sessionId).run(); }
        return target.get(...args);
      };
      const value=Reflect.get(target,property,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    expect((await renderResponse(human,revokedServeMedia,pair.front.assetId,{publicOnly:false,request:new Request('https://fixture.invalid/media')})).status).toBe(404);
    await runtime.DB.prepare('UPDATE fb_sessions SET revoked_at=NULL WHERE id=?').bind(sessionId).run();
    expect((await response()).status).toBe(200);
    const originalSession = await runtime.DB.prepare('SELECT expires_at FROM fb_sessions WHERE id=?').bind(sessionId).first<{expires_at:string}>();
    let expiredAtFinalRead = false;
    const expiryDb = (table:'fb_sessions'|'fb_agent_grants',id:string) => new Proxy(runtime.DB, { get(target,property) {
      if (property === 'prepare') return (sql:string) => {
        const statement=target.prepare(sql);
        if (!sql.includes('FROM fb_variant_renders vr JOIN fb_assets a') || !sql.includes('p.content_sha256')) return statement;
        return new Proxy(statement,{ get(stmt,member) {
          if (member === 'bind') return (...args:unknown[]) => {
            const bound=stmt.bind(...args);
            return new Proxy(bound,{ get(inner,method) {
              if (method === 'first') return async (...firstArgs:unknown[]) => {
                if (!expiredAtFinalRead) {
                  expiredAtFinalRead=true;
                  const expiry=Date.now()+50;
                  await target.prepare(`UPDATE ${table} SET expires_at=? WHERE id=?`).bind(new Date(expiry).toISOString(),id).run();
                  while (Date.now() <= expiry) await new Promise(resolve=>setTimeout(resolve,10));
                }
                return inner.first(...firstArgs);
              };
              const value=Reflect.get(inner,method,inner);return typeof value==='function'?value.bind(inner):value;
            }});
          };
          const value=Reflect.get(stmt,member,stmt);return typeof value==='function'?value.bind(stmt):value;
        }});
      };
      const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
    }});
    try {
      expect((await renderResponse({...human,db:expiryDb('fb_sessions',sessionId)},runtime.MEDIA,pair.front.assetId,{publicOnly:false,request:new Request('https://fixture.invalid/media')})).status).toBe(404);
      expect(expiredAtFinalRead).toBe(true);
    } finally { await runtime.DB.prepare('UPDATE fb_sessions SET expires_at=? WHERE id=?').bind(originalSession!.expires_at,sessionId).run(); }
    const originalGrant=await runtime.DB.prepare('SELECT expires_at FROM fb_agent_grants WHERE id=?').bind(resolved.credential.grantId).first<{expires_at:string}>();
    expiredAtFinalRead=false;
    try {
      expect((await renderResponse({...agent,db:expiryDb('fb_agent_grants',resolved.credential.grantId)},runtime.MEDIA,pair.front.assetId,{publicOnly:true,request:new Request('https://fixture.invalid/media')})).status).toBe(404);
      expect(expiredAtFinalRead).toBe(true);
    } finally { await runtime.DB.prepare('UPDATE fb_agent_grants SET expires_at=? WHERE id=?').bind(originalGrant!.expires_at,resolved.credential.grantId).run(); }
    let audienceRevokedOnServe=false;
    const changedAudienceMedia = new Proxy(runtime.MEDIA, { get(target,property) {
      if (property === 'get') return async (...args: Parameters<typeof target.get>) => {
        if (!audienceRevokedOnServe) { audienceRevokedOnServe=true; await runtime.DB.prepare("UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'").run(); }
        return target.get(...args);
      };
      const value=Reflect.get(target,property,target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    expect((await renderResponse(anonymous,changedAudienceMedia,pair.front.assetId,{publicOnly:true,request:new Request('https://fixture.invalid/media')})).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience='public' WHERE id='col_test_public'").run();
    expect((await response()).status).toBe(200);
    await runtime.DB.prepare("UPDATE fb_collections SET back_url=? WHERE id='render_other_private'")
      .bind(`/media/asset/${beforePublic!.asset_id.replace('_', '%255F')}`)
      .run();
    expect((await response()).status).toBe(404);
    await runtime.DB.prepare("UPDATE fb_collections SET back_url=NULL WHERE id='render_other_private'").run();
    expect((await response()).status).toBe(200);
    expect((await backRenderResponse(human, pair.back.assetId)).status).toBe(200);
    const derivative = await createBoundDerivative(
      agent,
      pair.front.assetId,
      "thumb",
      boundRenderThumb,
    );
    expect(
      await createBoundDerivative(agent, pair.front.assetId, "thumb", boundRenderThumb),
    ).toEqual(derivative);
    expect(
      (
        await derivativeResponse(
          human,
          runtime.MEDIA,
          derivative.id,
          new Request("https://fixture.invalid/media"),
        )
      ).status,
    ).toBe(200);
    const derivativePin = await runtime.DB.prepare(
      "SELECT r2_key FROM fb_bound_render_derivatives WHERE derivative_id=?",
    )
      .bind(derivative.id)
      .first<{ r2_key: string }>();
    await runtime.MEDIA.put(derivativePin!.r2_key, new TextEncoder().encode("replacement"));
    expect(
      (
        await derivativeResponse(
          human,
          runtime.MEDIA,
          derivative.id,
          new Request("https://fixture.invalid/media"),
        )
      ).status,
    ).toBe(404);
    const output = await runtime.DB.prepare(
      "SELECT r2_key FROM fb_bound_render_outputs WHERE asset_id=?",
    )
      .bind(pair.front.assetId)
      .first<{ r2_key: string }>();
    const app = "1566702936615026769",
      guild = "997734945206313041",
      channel = "1566700752385081355",
      discordUser = "707281352818425929";
    await runtime.DB.prepare(
      `INSERT INTO fb_discord_installations (id,tenant_id,application_id,guild_id,guild_name,channel_allowlist_json,game_enabled,website_enabled,api_enabled,public_catalogue_enabled,admin_gui_enabled,active,created_at,updated_at)
      VALUES ('render_discord',?,?,?,'Fixture','[]',1,1,1,1,1,1,?,?)`,
    )
      .bind(ctx.tenant.id, app, guild, now, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_discord_identities(id,tenant_id,discord_user_id,user_id,username,linked_at,last_seen_at) VALUES ('render_discord_identity',?,?,?,?,?,?)",
    )
      .bind(ctx.tenant.id, discordUser, ctx.user!.id, "fixture", now, now)
      .run();
    const interaction = {
      id: "1566702936615026768",
      application_id: app,
      type: 2,
      token: "fixture",
      version: 1,
      guild_id: guild,
      channel_id: channel,
      member: { user: { id: discordUser, username: "fixture" } },
    } as DiscordInteraction;
    const discordEnv = runtime as unknown as DiscordEnv;
    expect(
      (await readBoundDiscordAttachment(discordEnv, interaction, output!.r2_key, true))?.bytes,
    ).toEqual(boundRenderImage);
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'",
    ).run();
    expect(
      await readBoundDiscordAttachment(discordEnv, interaction, output!.r2_key, true),
    ).toBeNull();
    expect(
      (await readBoundDiscordAttachment(discordEnv, interaction, output!.r2_key, false))?.bytes,
    ).toEqual(boundRenderImage);
    let identityRevoked = false;
    const discordMedia = new Proxy(runtime.MEDIA, {
      get(target, property) {
        if (property === "get")
          return async (...args: Parameters<R2Bucket["get"]>) => {
            if (!identityRevoked) {
              identityRevoked = true;
              await runtime.DB.prepare(
                "UPDATE fb_discord_identities SET revoked_at=? WHERE id='render_discord_identity'",
              )
                .bind(now)
                .run();
            }
            return target.get(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const revokedEnv = new Proxy(discordEnv, {
      get(target, property) {
        if (property === "MEDIA") return discordMedia;
        return Reflect.get(target, property, target);
      },
    });
    expect(
      await readBoundDiscordAttachment(revokedEnv, interaction, output!.r2_key, false),
    ).toBeNull();
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='public' WHERE id='col_test_public'",
    ).run();
    await runtime.MEDIA.put(output!.r2_key, new TextEncoder().encode("replaced"));
    expect((await response()).status).toBe(404);
    expect((await serveAsset(ctx, pair.front.assetId)).status).toBe(404);

    const db = new Proxy(runtime.DB, {
      get(target, property) {
        if (property === "batch")
          return async (...args: Parameters<D1Database["batch"]>) => {
            await target
              .prepare("UPDATE fb_agent_tokens SET token_hash=? WHERE id=?")
              .bind("rotated-fixture", resolved.credential.tokenId)
              .run();
            return target.batch(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      queueBoundRender({ ...agent, db }, reviewed, "render-request-2"),
    ).rejects.toMatchObject({ code: "render_inputs_changed" });
    expect(
      await runtime.DB.prepare(
        "SELECT id FROM fb_bound_render_jobs WHERE idempotency_key='render-request-2'",
      ).first(),
    ).toBeNull();
  });
  it("commits explicit metadata and returns only bytes matching every recorded version", async () => {
    const { input, bytes } = await example(),
      result = await commitRenderManifest(input);
    const fetched = await readRenderManifestInputs(runtime.MEDIA, result.manifest);
    expect(fetched.sha256).toBe(result.sha256);
    expect(fetched.bytes).toEqual({ subject: bytes, background: bytes, back: bytes, mark: null });
    const reordered = { ...input, metadata: { ...input.metadata, subtitle: "Changed" } };
    expect((await commitRenderManifest(reordered)).sha256).not.toBe(result.sha256);
    await runtime.MEDIA.put(input.assets.subject.key, bytes);
    await expect(readRenderManifestInputs(runtime.MEDIA, result.manifest)).rejects.toMatchObject({
      code: "render_input_changed",
    });
  });
  it("rejects missing or inconsistent dependencies and cross-tenant keys", async () => {
    const { input } = await example();
    const missing = structuredClone(input) as Record<string, any>;
    delete missing.assets.back;
    await expect(commitRenderManifest(missing)).rejects.toMatchObject({
      code: "render_manifest_invalid",
    });
    const foreign = structuredClone(input);
    foreign.assets.subject.key = "tenants/other/subject";
    await expect(commitRenderManifest(foreign)).rejects.toMatchObject({
      code: "render_manifest_invalid",
    });
    const pathTenant = structuredClone(input);
    pathTenant.tenantId = "../foreign";
    await expect(commitRenderManifest(pathTenant)).rejects.toMatchObject({
      code: "render_manifest_invalid",
    });
    const pathKey = structuredClone(input);
    pathKey.assets.subject.key = `tenants/${input.tenantId}/../foreign`;
    await expect(commitRenderManifest(pathKey)).rejects.toMatchObject({
      code: "render_manifest_invalid",
    });
    const inconsistent = structuredClone(input) as Record<string, any>;
    inconsistent.metadata.effect = "holographic";
    await expect(commitRenderManifest(inconsistent)).rejects.toMatchObject({
      code: "render_manifest_invalid",
    });
    const hidden = structuredClone(input) as Record<string, any>;
    hidden.metadata.uncommitted = "not allowed";
    await expect(commitRenderManifest(hidden)).rejects.toMatchObject({
      code: "render_manifest_invalid",
    });
  });
});
