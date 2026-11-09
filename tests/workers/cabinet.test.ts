import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance } from "./helpers";
import { getCabinet } from "../../src/server/modules/cabinet";

describe("cabinet landing", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("groups owned copies by collection and never uses a card render as identity", async () => {
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const fixture = await fixturePool(player);
    await makeInstance(player, player.user!.id, fixture, "CABINET-ONE");

    const cabinet = await getCabinet(player);
    expect(cabinet.stats.copies).toBe(1);
    expect(cabinet.stats.subjects).toBe(1);
    expect(cabinet.recent).toHaveLength(1);
    expect(cabinet.shelves).toHaveLength(1);
    expect(cabinet.shelves[0]!.collection.slug).toBe("test-public");
    expect(cabinet.shelves[0]!.cards[0]!.serial).toBe("CABINET-ONE");
    expect(cabinet.shelves[0]!.completionPct).toBeGreaterThan(0);
  });
});
