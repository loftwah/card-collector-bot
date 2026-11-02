import { describe, expect, it } from "vitest";
import { createAgentGrant, revokeAgentGrant } from "../../src/server/modules/identity";
import { resolveAgent } from "../../src/server/context";
import { getCard } from "../../src/server/modules/catalogue";
import { getInventory } from "../../src/server/modules/collection";
import { getPoolPreview } from "../../src/server/modules/pools";
import { getWalletSummary } from "../../src/server/modules/wallet";
import { bootstrap, ctxFor, fixturePool } from "./helpers";

describe("tenant isolation", () => {
  it("does not resolve a cabinet object from another tenant", async () => {
    await bootstrap();
    const cabinet = await ctxFor("cabinet", "owner@foilbury.local");
    const harbour = await ctxFor("harbour", "harbour.owner@foilbury.test");
    const fixture = await fixturePool(cabinet);

    await expect(getCard(harbour, fixture.cardId)).rejects.toMatchObject({ code: "card_not_found" });
    await expect(getPoolPreview(harbour, "test-pool")).rejects.toMatchObject({ code: "pool_not_found" });
    expect((await getInventory(harbour)).length).toBe(0);
    expect((await getWalletSummary(harbour.db, harbour.tenant.id, harbour.user!.id, 1)).balance).toBe(200);
    expect((await getWalletSummary(cabinet.db, cabinet.tenant.id, cabinet.user!.id, 1)).balance).toBe(350);
  });

  it("keeps tenant ids and memberships separate even with a shared user email domain", async () => {
    await bootstrap();
    const cabinet = await ctxFor("cabinet", "player@foilbury.local");
    const attic = await ctxFor("attic", "attic.owner@foilbury.test");
    const cabinetWallet = await getWalletSummary(cabinet.db, cabinet.tenant.id, cabinet.user!.id, 1);
    const atticWallet = await getWalletSummary(attic.db, attic.tenant.id, attic.user!.id, 1);
    expect(cabinetWallet.balance).toBe(350);
    expect(atticWallet.balance).toBe(200);
    expect(cabinet.tenant.id).not.toBe(attic.tenant.id);
  });
});

describe("agent grants", () => {
  it("lets only a human owner create a grant and revokes it immediately", async () => {
    await bootstrap();
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    await expect(
      createAgentGrant(player, { agentName: "not-allowed", representedUserId: player.user!.id, scopes: ["inventory:read"], expiresInDays: 5 }),
    ).rejects.toMatchObject({ code: "owner_required" });

    const grant = await createAgentGrant(owner, {
      agentName: "test-reader",
      representedUserId: owner.user!.id,
      scopes: ["inventory:read", "content:read"],
      expiresInDays: 5,
    });
    const resolved = await resolveAgent(owner.db, owner.config, grant.token, owner.tenant);
    expect(resolved.user.id).toBe(owner.user!.id);
    expect(resolved.scopes).toEqual(["inventory:read", "content:read"]);

    await revokeAgentGrant(owner, grant.grantId);
    await expect(resolveAgent(owner.db, owner.config, grant.token, owner.tenant)).rejects.toMatchObject({
      code: "agent_unauthorised",
    });
  });

  it("rejects an expired grant even before revocation", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const grant = await createAgentGrant(owner, {
      agentName: "expiring-reader",
      representedUserId: owner.user!.id,
      scopes: ["inventory:read"],
      expiresInDays: 1,
    });
    await owner.db.prepare("UPDATE fb_agent_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(grant.grantId).run();
    await expect(resolveAgent(owner.db, owner.config, grant.token, owner.tenant)).rejects.toMatchObject({
      code: "agent_unauthorised",
    });
  });
});
