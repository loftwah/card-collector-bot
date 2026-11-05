import { beforeEach, expect, it } from "vitest";
import type { APIContext } from "astro";
import { ALL } from "../../src/pages/api/v1/[...path]";
import { buildContext } from "../../src/server/context";
import { createAgentGrant, createSession } from "../../src/server/modules/identity";
import { getEconomy, updateEconomy } from "../../src/server/modules/economy";
import { bootstrap, ctxFor, runtime } from "./helpers";

beforeEach(async () => { await bootstrap(); });
async function request(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  const req = new Request(`http://localhost:5173/api/v1/${path}`, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const response = await ALL({ request: req, params: { path } } as unknown as APIContext);
  return { status: response.status, json: await response.json() as any };
}
it("allows a scoped agent to read but denies its settings mutation without changing data or audit", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const grant = await createAgentGrant(owner, { agentName: "economy-read-test", representedUserId: owner.user!.id, scopes: ["economy:read", "economy:write"], expiresInDays: 1 });
  const headers = { authorization: `Bearer ${grant.token}` };
  const read = await request("admin/economy", "GET", headers);
  expect(read.status).toBe(200);
  const before = await getEconomy(owner);
  const auditBefore = await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='economy.updated'").first();
  const result = await request("admin/economy", "PATCH", headers, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 });
  expect(result.status).toBe(403);
  expect(result.json.error.code).toBe("human_strong_auth_required");
  expect(await getEconomy(owner)).toEqual(before);
  expect(await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_audit_events WHERE action='economy.updated'").first()).toEqual(auditBefore);
  const ctx = await buildContext(new Request("http://localhost:5173/api/v1/admin/economy", { headers }));
  await expect(updateEconomy(ctx, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 })).rejects.toMatchObject({ code: "human_strong_auth_required" });
});
it("permits a recent MFA human and rejects an email-only human", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const before = await getEconomy(owner);
  for (const assurance of ["email", "mfa"] as const) {
    const session = await createSession(runtime.DB, owner.tenant, owner.user!, { authMethod: assurance, assurance });
    const headers = { cookie: `fb_session=${session.token}; fb_csrf=${session.csrf}`, "x-foilbury-csrf": session.csrf };
    const result = await request("studio/economy", "PATCH", headers, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 });
    expect(result.status).toBe(assurance === "mfa" ? 200 : 403);
  }
  expect((await getEconomy(owner)).daily_reward).toBe(before.daily_reward + 1);
});
it("rejects a stale MFA session without changing settings", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const before = await getEconomy(owner);
  const session = await createSession(runtime.DB, owner.tenant, owner.user!, { authMethod: "mfa", assurance: "mfa" });
  await runtime.DB.prepare("UPDATE fb_sessions SET auth_time = ? WHERE user_id = ? AND tenant_id = ?").bind(new Date(Date.now() - 31 * 60_000).toISOString(), owner.user!.id, owner.tenant.id).run();
  const headers = { cookie: `fb_session=${session.token}; fb_csrf=${session.csrf}`, "x-foilbury-csrf": session.csrf };
  const result = await request("studio/economy", "PATCH", headers, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 });
  expect(result.status).toBe(403);
  expect(result.json.error.code).toBe("strong_auth_stale");
  expect(await getEconomy(owner)).toEqual(before);
});
it("permits a recent passkey session", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const before = await getEconomy(owner);
  const session = await createSession(runtime.DB, owner.tenant, owner.user!, { authMethod: "passkey", assurance: "passkey" });
  const headers = { cookie: `fb_session=${session.token}; fb_csrf=${session.csrf}`, "x-foilbury-csrf": session.csrf };
  const result = await request("studio/economy", "PATCH", headers, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 });
  expect(result.status).toBe(200);
  expect((await getEconomy(owner)).daily_reward).toBe(before.daily_reward + 1);
});
it("requires a linked Access identity and accepts an already-verified Access context", async () => {
  const owner = await ctxFor("cabinet", "owner@foilbury.local");
  const before = await getEconomy(owner);
  owner.sessionAssurance = "access";
  owner.accessIdentity = { subject: "fixture-subject", email: owner.user!.email, audience: "fixture", payload: { exp: Math.floor(Date.now() / 1000) + 60 } };
  owner.accessStatus = "unlinked";
  await expect(updateEconomy(owner, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 })).rejects.toMatchObject({ code: "strong_auth_required" });
  owner.accessStatus = "linked";
  expect((await updateEconomy(owner, { expectedVersion: before.version, dailyReward: before.daily_reward + 1 })).daily_reward).toBe(before.daily_reward + 1);
});
