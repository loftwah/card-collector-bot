import { expect, it } from "vitest";
import { countInventory, getInventory } from "../../src/server/modules/collection";
import {
  addCollectionCards,
  collectionBinder,
  collectionProgress,
  createCollection,
} from "../../src/server/modules/collections";
import { getCollectorProgress, progressPeriod } from "../../src/server/modules/progress";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

it("reads complete UTC buckets and only the active collector's visible binder and ledger", async () => {
  await bootstrap();
  const member = await ctxFor("cabinet", "player@foilbury.local");
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const otherBot = await ctxFor("harbour", "harbour.owner@foilbury.test");
  const fixture = await fixturePool(member);
  await makeInstance(member, member.user!.id, fixture);
  const reserved = await makeInstance(member, member.user!.id, fixture);
  await runtime.DB.prepare("UPDATE fb_card_instances SET status = 'reserved' WHERE id = ?")
    .bind(reserved)
    .run();
  await runtime.DB.prepare(
    "UPDATE fb_bot_collections SET enabled = 0 WHERE collection_id = 'col_test_public'",
  ).run();

  const period = progressPeriod("7", "2025-12-31", new Date("2026-01-02T00:00:00Z"));
  const insert = (id: string, ctx: typeof member, time: string, amount: number) =>
    runtime.DB.prepare(
      `INSERT INTO fb_ledger_entries (id, tenant_id, user_id, kind, amount, balance_after,
      reference_type, description, actor_type, created_at) VALUES (?, ?, ?, 'correction', ?, 350, NULL, 'internal note', 'system', ?)`,
    ).bind(id, ctx.tenant.id, ctx.user!.id, amount, time);
  await runtime.DB.batch([
    insert("old", member, "2025-12-26T23:59:59.999Z", 900),
    insert("start", member, "2025-12-27T00:00:00.000Z", 5),
    ...Array.from({ length: 26 }, (_, i) =>
      insert(`credit-${i}`, member, "2025-12-31T23:59:59.999Z", 1),
    ),
    insert("midnight", member, "2026-01-01T00:00:00.000Z", -10),
    insert("end", member, "2026-01-03T00:00:00.000Z", 900),
    insert("someone-else", owner, "2025-12-31T12:00:00.000Z", 1000),
    insert("other-bot", otherBot, "2025-12-31T12:00:00.000Z", 1000),
  ]);
  const result = await getCollectorProgress(member, period);
  expect(result.binders).toEqual([
    expect.objectContaining({ slug: "test-public", owned: 1, total: 1 }),
  ]);
  expect(result.activity?.buckets.map(({ credited, debited }) => [credited, debited])).toEqual([
    [5, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [26, 0],
    [0, 10],
    [0, 0],
  ]);
  expect(result.activity?.entries).toHaveLength(25);
  expect(result.activity?.entries[0]).toEqual({
    label: "Correction",
    amount: 1,
    balance: 350,
    time: "2025-12-31T23:59:59.999Z",
  });

  const hidden = await createCollection(owner, {
    name: "Private",
    scope: "global",
    status: "published",
    viewAudience: "private",
  });
  await addCollectionCards(owner, hidden.id, [fixture.cardId]);
  expect((await getCollectorProgress(member, period)).binders).toEqual([]);
  expect((await collectionProgress(member, "col_test_public")).total_cards).toBe(0);
  expect((await collectionBinder(member, "col_test_public")).cards).toEqual([]);
  expect(await countInventory(member, { collection: "col_test_public" })).toBe(0);
  expect(await getInventory(member, { collection: "col_test_public" })).toEqual([]);

  await expect(getCollectorProgress({ ...member, user: null }, period)).rejects.toMatchObject({
    status: 401,
  });
  await runtime.DB.prepare(
    "UPDATE fb_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?",
  )
    .bind(member.tenant.id, member.user!.id)
    .run();
  await expect(getCollectorProgress(member, period)).rejects.toMatchObject({ status: 403 });
});
