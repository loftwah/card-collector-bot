import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/server/context";
import { adjustWallet } from "../../src/server/modules/economy";
import { getWalletSummary } from "../../src/server/modules/wallet";
import { bootstrap, ctxFor, runtime, setBalance, walletBalance } from "./helpers";
import { routeApi } from "../../src/server/api/router";

async function configure(
  userId: string,
  tenantId: string,
  input: {
    capabilities: string[];
    selfGrantsEnabled: boolean;
    grantLimit: number;
  },
) {
  await runtime.DB.prepare(
    `UPDATE fb_memberships
        SET capabilities_json = ?, self_grants_enabled = ?, grant_limit = ?,
            capability_revision = capability_revision + 1
      WHERE tenant_id = ? AND user_id = ?`,
  )
    .bind(
      JSON.stringify(input.capabilities),
      input.selfGrantsEnabled ? 1 : 0,
      input.grantLimit,
      tenantId,
      userId,
    )
    .run();
}

describe("scoped Admin Foil grants", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("grants with one ledger and audit receipt when the capability and policy allow it", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["content", "grants"],
      selfGrantsEnabled: true,
      grantLimit: 250,
    });
    const admin = await ctxFor("cabinet", "player@foilbury.local");
    const result = await adjustWallet(admin, {
      userId: admin.user!.id,
      amount: 100,
      reason: "Reviewed fixture: content and money authority together.",
      idempotency: { key: "scoped-self-grant-001", digest: "self-grant" },
    });
    expect(result.balance_after).toBe(400);
    expect(await walletBalance(admin, admin.user!.id)).toBe(400);
    const ledger = await runtime.DB.prepare(
      "SELECT amount, idempotency_key FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    )
      .bind(owner.tenant.id, admin.user!.id, "adjust:scoped-self-grant-001")
      .first<{ amount: number; idempotency_key: string }>();
    expect(ledger?.amount).toBe(100);
    const audit = await runtime.DB.prepare(
      "SELECT action, metadata_json FROM fb_audit_events WHERE tenant_id = ? AND action = 'wallet.adjusted' ORDER BY created_at DESC LIMIT 1",
    )
      .bind(owner.tenant.id)
      .first<{ action: string; metadata_json: string }>();
    expect(audit?.action).toBe("wallet.adjusted");
    expect(audit?.metadata_json).toContain("content and money authority");
  });

  it("enforces the visible ceiling and positive whole-number rule without mutation", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["grants"],
      selfGrantsEnabled: true,
      grantLimit: 250,
    });
    const admin = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      adjustWallet(admin, {
        userId: admin.user!.id,
        amount: 251,
        reason: "Over the visible ceiling.",
        idempotency: { key: "scoped-over-limit", digest: "limit" },
      }),
    ).rejects.toMatchObject({ code: "grant_limit_exceeded" });
    await expect(
      adjustWallet(admin, {
        userId: admin.user!.id,
        amount: -100,
        reason: "Negative self grant attempt.",
        idempotency: { key: "scoped-negative", digest: "negative" },
      }),
    ).rejects.toMatchObject({ code: "amount_invalid" });
    expect(await walletBalance(admin, admin.user!.id)).toBe(300);
  });

  it("revocation and self-grant disablement apply to a stale session on the next mutation", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["grants"],
      selfGrantsEnabled: true,
      grantLimit: 250,
    });
    const stale = await ctxFor("cabinet", "player@foilbury.local");

    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["content"],
      selfGrantsEnabled: false,
      grantLimit: 0,
    });
    await expect(
      adjustWallet(stale, {
        userId: stale.user!.id,
        amount: 100,
        reason: "Stale form after capability removal.",
        idempotency: { key: "scoped-stale-revoked", digest: "stale" },
      }),
    ).rejects.toMatchObject({ code: "grants_capability_required" });
    expect(await walletBalance(stale, stale.user!.id)).toBe(300);

    await configure(player.user!.id, owner.tenant.id, {
      capabilities: ["grants"],
      selfGrantsEnabled: false,
      grantLimit: 250,
    });
    const fresh = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      adjustWallet(fresh, {
        userId: fresh.user!.id,
        amount: 100,
        reason: "Self-grants disabled.",
        idempotency: { key: "scoped-self-disabled", digest: "disabled" },
      }),
    ).rejects.toMatchObject({ code: "self_grants_disabled" });
    expect(await walletBalance(fresh, fresh.user!.id)).toBe(300);
  });

  it("lets the Super Admin edit an existing Admin's capability and policy through the API", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    // Make the player a real Bot Admin row without creating a duplicate account.
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ? LIMIT 1")
      .bind(owner.tenant.id)
      .first<{ id: string }>();
    await runtime.DB.prepare(
      `INSERT INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at, accepted_at)
       VALUES ('badm_scoped_test', ?, ?, 'admin', '["content"]', 'active', ?, ?)`,
    )
      .bind(bot!.id, player.user!.id, new Date().toISOString(), new Date().toISOString())
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET role = 'editor', capabilities_json = '[\"content\"]' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(owner.tenant.id, player.user!.id)
      .run();

    const request = new Request("https://foilbury.test/api/v1/admin/bot/admins/" + player.user!.id, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
      body: JSON.stringify({
        capabilities: ["content", "grants"],
        selfGrantsEnabled: true,
        grantLimit: 300,
        reason: "Owner enables the requested scoped Admin self-grant.",
      }),
    });
    const ownerCtx = { ...owner, sessionAssurance: "passkey" as const, sessionAuthTime: new Date().toISOString() };
    const response = await routeApi(request, ownerCtx, "/admin/bot/admins/" + player.user!.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      capabilities: string[];
      self_grants_enabled: boolean;
      grant_limit: number;
    };
    expect(body.capabilities).toEqual(["content", "grants"]);
    expect(body.self_grants_enabled).toBe(true);
    expect(body.grant_limit).toBe(300);
    const updated = await ctxFor("cabinet", "player@foilbury.local");
    expect(updated.user!.capabilities).toEqual(["content", "grants"]);
    expect(updated.user!.selfGrantsEnabled).toBe(true);
    expect(updated.user!.grantLimit).toBe(300);
    const audit = await runtime.DB.prepare(
      "SELECT metadata_json FROM fb_audit_events WHERE action = 'bot.admin.capabilities.updated' ORDER BY created_at DESC LIMIT 1",
    ).first<{ metadata_json: string }>();
    expect(audit?.metadata_json).toContain("Owner enables the requested");
  });

  it("keeps a revoked Admin's account, cards and ledger intact", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    await setBalance(owner, player.user!.id, 300);
    const before = await getWalletSummary(owner.db, owner.tenant.id, player.user!.id, 10);
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status = 'revoked', revoked_at = ?, capabilities_json = '[]' WHERE tenant_id = ? AND user_id = ?",
    )
      .bind(new Date().toISOString(), owner.tenant.id, player.user!.id)
      .run();
    const stale = await ctxFor("cabinet", "player@foilbury.local");
    await expect(
      adjustWallet(stale, {
        userId: stale.user!.id,
        amount: 100,
        reason: "Revoked admin attempt.",
        idempotency: { key: "scoped-revoked", digest: "revoked" },
      }),
    ).rejects.toMatchObject({ code: "membership_revoked" });
    const after = await getWalletSummary(owner.db, owner.tenant.id, player.user!.id, 10);
    expect(after.balance).toBe(before.balance);
  });
});
