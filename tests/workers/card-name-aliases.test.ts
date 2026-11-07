import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { listCards } from "../../src/server/modules/catalogue";
import { getInventory } from "../../src/server/modules/collection";
import { normalizeCardName } from "../../src/server/modules/card-name-aliases";

describe("card alternate names", () => {
  it("resolves a width/spacing variant through the alias table without a second card", async () => {
    await bootstrap();
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(ctx);
    await makeInstance(ctx, ctx.user!.id, fixture);
    await runtime.DB.prepare(
      "INSERT INTO fb_card_name_aliases (tenant_id, card_id, alias, normalized, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(ctx.tenant.id, fixture.cardId, "Camui Gackpo", "camui gackpo", new Date().toISOString())
      .run();

    const catalogue = await listCards(ctx, { search: "  ＣＡＭＵＩ   GACKPO  " });
    expect(catalogue.map((card) => card.id)).toEqual([fixture.cardId]);
    const inventory = await getInventory(ctx, { search: "CAMUI gackpo" });
    expect(inventory.map((item) => item.card_id)).toEqual([fixture.cardId]);
    expect(normalizeCardName("  ＣＡＭＵＩ   GACKPO  ")).toBe("camui gackpo");
  });
});
