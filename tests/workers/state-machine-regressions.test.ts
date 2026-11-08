import { describe, expect, it } from "vitest";
import { acceptTrade, createTrade } from "../../src/server/modules/trades";
import { archiveCard, createCard, listCards, mergeCards, setCardStatus } from "../../src/server/modules/catalogue";
import { deletePasskey } from "../../src/server/modules/passkeys";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

describe("implicit state-machine regressions", () => {
  it("settles a trade left fully accepted but open by concurrent acceptances", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(owner);
    const ownerCard = await makeInstance(owner, owner.user!.id, fixture, "RACE-OWNER-1");
    const playerCard = await makeInstance(player, player.user!.id, fixture, "RACE-PLAYER-1");
    const trade = await createTrade(owner, {
      recipientEmail: "player@foilbury.local",
      proposerInstanceIds: [ownerCard],
      recipientInstanceIds: [playerCard],
    });

    // Both requests can read zero prior acceptances, commit their own row and
    // then each conclude it was not the second acceptance. The trade is left
    // open with two acceptances but nothing transferred.
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB
        .prepare(
          "INSERT INTO fb_trade_acceptances (tenant_id, trade_id, revision, user_id, accepted_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(owner.tenant.id, trade.id, trade.revision, owner.user!.id, now),
      runtime.DB
        .prepare(
          "INSERT INTO fb_trade_acceptances (tenant_id, trade_id, revision, user_id, accepted_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(owner.tenant.id, trade.id, trade.revision, player.user!.id, now),
    ]);

    const settled = await acceptTrade(player, trade.id);
    expect(settled.status).toBe("completed");
    const swapped = await runtime.DB.prepare(
      "SELECT id, user_id FROM fb_card_instances WHERE id IN (?, ?)",
    )
      .bind(ownerCard, playerCard)
      .all<{ id: string; user_id: string }>();
    expect(swapped.results.find((row) => row.id === ownerCard)?.user_id).toBe(player.user!.id);
    expect(swapped.results.find((row) => row.id === playerCard)?.user_id).toBe(owner.user!.id);
    const history = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_instance_history WHERE reference_id = ? AND event = 'traded'",
    )
      .bind(trade.id)
      .first<{ count: number }>();
    expect(history?.count).toBe(2);
  });

  it("archives a referenced draft instead of failing its foreign keys", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await fixturePool(owner);
    const draft = await createCard(owner, {
      slug: "referenced-draft",
      name: "Referenced Draft",
      description: "A draft linked to a collection.",
      logicalId: "test:referenced-draft",
    });
    const now = new Date().toISOString();
    await runtime.DB
      .prepare(
        "INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at) VALUES ('col_test_public', ?, ?, 0, 'test', ?)",
      )
      .bind(draft.id, owner.tenant.id, now)
      .run();

    await archiveCard(owner, draft.id);
    const archived = await runtime.DB.prepare(
      "SELECT status, archived_at FROM fb_card_definitions WHERE id = ?",
    )
      .bind(draft.id)
      .first<{ status: string; archived_at: string | null }>();
    expect(archived?.status).toBe("retired");
    expect(archived?.archived_at).toBeTruthy();
  });

  it("keeps collection membership when duplicate cards are merged", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const target = await createCard(owner, {
      slug: "merge-keep-collection",
      name: "Merge Collection Target",
      description: "A merge target that keeps collection links.",
      logicalId: "test:merge-collection-target",
    });
    await mergeCards(owner, fixture.cardId, target.id);
    const links = await runtime.DB.prepare(
      "SELECT card_id FROM fb_collection_cards WHERE collection_id = 'col_test_public' ORDER BY card_id",
    ).all<{ card_id: string }>();
    expect(links.results.map((row) => row.card_id)).toEqual([target.id]);
  });

  it("clears the archive marker when a retired card is restored", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    await archiveCard(owner, fixture.cardId);
    const archived = await runtime.DB.prepare(
      "SELECT status, archived_at FROM fb_card_definitions WHERE id = ?",
    )
      .bind(fixture.cardId)
      .first<{ status: string; archived_at: string | null }>();
    expect(archived?.status).toBe("retired");
    expect(archived?.archived_at).toBeTruthy();

    const restored = await setCardStatus(owner, fixture.cardId, "published");
    expect(restored.status).toBe("published");
    expect(restored.archived_at).toBeNull();
    const visible = await listCards(owner, { includeDrafts: true });
    expect(visible.some((card) => card.id === fixture.cardId)).toBe(true);
  });

  it("never removes the last passkey when two removals race", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.batch([
      runtime.DB
        .prepare(
          "INSERT INTO fb_webauthn_credentials (id, user_id, credential_id, public_key, name, created_at) VALUES (?, ?, ?, 'cHVibGlj', 'Test key one', ?)",
        )
        .bind("pk_race_one", player.user!.id, "cred_race_one", now),
      runtime.DB
        .prepare(
          "INSERT INTO fb_webauthn_credentials (id, user_id, credential_id, public_key, name, created_at) VALUES (?, ?, ?, 'cHVibGlj', 'Test key two', ?)",
        )
        .bind("pk_race_two", player.user!.id, "cred_race_two", now),
    ]);

    const outcomes = await Promise.allSettled([
      deletePasskey(runtime.DB, player.user!.id, "pk_race_one"),
      deletePasskey(runtime.DB, player.user!.id, "pk_race_two"),
    ]);
    const remaining = await runtime.DB.prepare(
      "SELECT COUNT(*) AS count FROM fb_webauthn_credentials WHERE user_id = ?",
    )
      .bind(player.user!.id)
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });
});
