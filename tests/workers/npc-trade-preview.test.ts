import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { createNpc, getNpc } from "../../src/server/modules/npcs";
import { previewNpcTrade } from "../../src/server/modules/npc-trade-preview";
import { routeApi } from "../../src/server/api/router";

describe("NPC trade assessment", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  async function setup() {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at) VALUES ('npc-preview-session','npc-preview-hash',?,?, 'test',?,?,?)",
    )
      .bind(
        player.user!.id,
        player.tenant.id,
        now,
        new Date(Date.now() + 60_000).toISOString(),
        now,
      )
      .run();
    player.sessionId = "npc-preview-session";
    const original = await fixturePool(owner);
    await runtime.DB.prepare(
      "UPDATE fb_assets SET origin='foilbury_original' WHERE id='ast_test_subject'",
    ).run();
    const npc = await createNpc(owner, { name: "Mira", presetKey: "completionist" });
    const npcUser = (await getNpc(owner, npc.id)).row.user_id;
    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at)
        SELECT 'crd_npc_want',tenant_id,'npc:want','npc-want','Wanted Card',description,status,created_at,updated_at FROM fb_card_definitions WHERE id=?`,
      ).bind(original.cardId),
      runtime.DB.prepare(
        `INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,background_asset_id,recipe_id,status,created_at)
        SELECT 'edt_npc_want',tenant_id,'crd_npc_want',name,subject_asset_id,background_asset_id,recipe_id,status,created_at FROM fb_artwork_editions WHERE card_id=?`,
      ).bind(original.cardId),
      runtime.DB.prepare(
        `INSERT INTO fb_variants (id,tenant_id,card_id,edition_id,material_id,effect_id,name,status,created_at)
        SELECT 'var_npc_want',tenant_id,'crd_npc_want','edt_npc_want',material_id,effect_id,name,status,created_at FROM fb_variants WHERE id=?`,
      ).bind(original.variantId),
      runtime.DB.prepare(
        "INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) SELECT collection_id,'crd_npc_want',tenant_id,1,'test',added_at FROM fb_collection_cards WHERE card_id=?",
      ).bind(original.cardId),
    ]);
    const offered = await makeInstance(
      player,
      player.user!.id,
      { cardId: "crd_npc_want", variantId: "var_npc_want" },
      "HUMAN-WANT",
    );
    const requested = await makeInstance(owner, npcUser, original, "NPC-SPARE-1");
    await makeInstance(owner, npcUser, original, "NPC-SPARE-2");
    return { owner, player, npc, npcUser, offered, requested };
  }

  it("assesses real copies without reserving, transferring or writing a trade", async () => {
    const f = await setup();
    const preview = await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested);
    expect(preview).toMatchObject({
      decision: "interested",
      preview_only: true,
      give: { serial: "HUMAN-WANT" },
      receive: { serial: "NPC-SPARE-1" },
    });
    const copies = await runtime.DB.prepare(
      "SELECT id,user_id,status,reserved_for FROM fb_card_instances WHERE id IN (?,?) ORDER BY id",
    )
      .bind(f.offered, f.requested)
      .all<{ id: string; user_id: string; status: string; reserved_for: string | null }>();
    expect(copies.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.offered,
          user_id: f.player.user!.id,
          status: "owned",
          reserved_for: null,
        }),
        expect.objectContaining({
          id: f.requested,
          user_id: f.npcUser,
          status: "owned",
          reserved_for: null,
        }),
      ]),
    );
    expect(
      (await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_trades").first<{ n: number }>())?.n,
    ).toBe(0);
    const path = `npcs/${f.npc.id}/trade-preview`;
    const response = await routeApi(
      new Request(`http://localhost/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
        body: JSON.stringify({ offeredInstanceId: f.offered, requestedInstanceId: f.requested }),
      }),
      f.player,
      path,
    );
    expect(await response.json()).toMatchObject({ decision: "interested", preview_only: true });
  });

  it("explains a decline when the NPC already owns the offered subject", async () => {
    const f = await setup();
    await makeInstance(
      f.owner,
      f.npcUser,
      { cardId: "crd_npc_want", variantId: "var_npc_want" },
      "NPC-HAS-WANT",
    );
    expect(await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).toMatchObject({
      decision: "declined",
      reason: "This collector already has that subject.",
    });
  });

  it("keeps the NPC's last copy", async () => {
    const f = await setup();
    await runtime.DB.prepare("UPDATE fb_card_instances SET locked=1 WHERE id=?")
      .bind(f.requested)
      .run();
    const spare = await runtime.DB.prepare(
      "SELECT id FROM fb_card_instances WHERE user_id=? AND serial='NPC-SPARE-2'",
    )
      .bind(f.npcUser)
      .first<{ id: string }>();
    await runtime.DB.prepare("UPDATE fb_card_instances SET status='surrendered' WHERE id=?")
      .bind(spare!.id)
      .run();
    await runtime.DB.prepare("UPDATE fb_card_instances SET locked=0 WHERE id=?")
      .bind(f.requested)
      .run();
    expect(await previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).toMatchObject({
      decision: "declined",
      reason: "This collector keeps their last copy of a subject.",
    });
  });

  it("rejects a different Bot and delegated agents", async () => {
    const f = await setup();
    const other = await ctxFor("harbour", "harbour.owner@foilbury.test");
    await expect(previewNpcTrade(other, f.npc.id, f.offered, f.requested)).rejects.toMatchObject({
      code: "npc_offer_unavailable",
    });
    const agent = {
      ...f.player,
      actor: {
        type: "agent" as const,
        id: "agent-fixture",
        representedUserId: f.player.user!.id,
        label: "fixture",
      },
      scopes: ["trade:write"],
    };
    await expect(previewNpcTrade(agent, f.npc.id, f.offered, f.requested)).rejects.toMatchObject({
      code: "human_player_required",
    });
  });

  it.each([
    "locked",
    "disabled collection",
    "private collection",
    "retired edition",
    "AI artwork",
    "revoked membership",
    "revoked session",
    "paused NPC",
    "foreign copy",
  ])("withholds unavailable offers: %s", async (condition) => {
    const f = await setup();
    if (condition === "locked")
      await runtime.DB.prepare("UPDATE fb_card_instances SET locked=1 WHERE id=?")
        .bind(f.requested)
        .run();
    if (condition === "disabled collection")
      await runtime.DB.prepare(
        "UPDATE fb_bot_collections SET enabled=0 WHERE collection_id='col_test_public'",
      ).run();
    if (condition === "private collection")
      await runtime.DB.prepare(
        "UPDATE fb_collections SET view_audience='private',public_approved_at=NULL WHERE id='col_test_public'",
      ).run();
    if (condition === "retired edition")
      await runtime.DB.prepare(
        "UPDATE fb_artwork_editions SET status='retired' WHERE id='edt_npc_want'",
      ).run();
    if (condition === "AI artwork")
      await runtime.DB.prepare(
        "UPDATE fb_assets SET origin='ai_generated' WHERE id='ast_test_subject'",
      ).run();
    if (condition === "revoked membership")
      await runtime.DB.prepare(
        "UPDATE fb_memberships SET status='revoked' WHERE tenant_id=? AND user_id=?",
      )
        .bind(f.player.tenant.id, f.player.user!.id)
        .run();
    if (condition === "revoked session")
      await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
        .bind(new Date().toISOString(), f.player.sessionId)
        .run();
    if (condition === "paused NPC")
      await runtime.DB.prepare("UPDATE fb_npc_collectors SET status='paused' WHERE id=?")
        .bind(f.npc.id)
        .run();
    if (condition === "foreign copy")
      await runtime.DB.prepare("UPDATE fb_card_instances SET user_id=? WHERE id=?")
        .bind(f.owner.user!.id, f.offered)
        .run();
    await expect(previewNpcTrade(f.player, f.npc.id, f.offered, f.requested)).rejects.toMatchObject(
      { code: "npc_offer_unavailable" },
    );
  });
});
