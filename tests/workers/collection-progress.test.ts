import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { collectionProgress } from "../../src/server/modules/collections";

describe("collection progress invariants", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("never reports more owned subjects than the published roster", async () => {
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(ctx);
    await makeInstance(ctx, ctx.user!.id, fixture);
    const before = await collectionProgress(ctx, "col_test_public");
    expect(before.owned_cards).toBeLessThanOrEqual(before.total_cards);
    expect(before.owned_cards).toBe(1);
    expect(before.total_cards).toBe(1);

    /* Retiring a card removes it from the published roster. An owned instance
       of a retired card must not make the collection look over-complete. */
    await runtime.DB.prepare("UPDATE fb_card_definitions SET status = 'retired' WHERE id = ?")
      .bind(fixture.cardId)
      .run();
    const after = await collectionProgress(ctx, "col_test_public");
    expect(after.owned_cards).toBe(0);
    expect(after.total_cards).toBe(0);
    expect(after.owned_cards).toBeLessThanOrEqual(after.total_cards);
    expect(after.complete).toBe(false);
  });
});
