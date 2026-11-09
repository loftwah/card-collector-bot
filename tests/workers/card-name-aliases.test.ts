import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { replaceCardNameAliases, listCardNameAliases } from "../../src/server/modules/card-name-aliases";
import { listCards, mergeCards } from "../../src/server/modules/catalogue";
import { countInventory, getInventory } from "../../src/server/modules/collection";
import type { Ctx } from "../../src/server/context";
import { addMembership, createUser } from "../../src/server/modules/identity";
import { routeApi } from "../../src/server/api/router";
import { uniqueCardSearchMatch } from "../../src/server/discord/commands";

describe("card alternate names", () => {
  it("persists exact normalized aliases for catalogue and owned inventory without disclosure", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString(), session = `alias-session-${crypto.randomUUID()}`;
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?, 'test',?,?,?,'password',?)")
      .bind(session,session,base.user!.id,base.tenant.id,now,new Date(Date.now()+3600000).toISOString(),now,now).run();
    const ctx = {...base,sessionId:session,sessionAssurance:'password' as const,sessionAuthTime:now};
    const f = await fixturePool(ctx);
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name = 'Kamui Gakupo' WHERE id = ?").bind(f.cardId).run();
    await makeInstance(ctx, ctx.user!.id, f);
    const changed = await replaceCardNameAliases(ctx, f.cardId, 1, ["Camui Gackpo", "Gackpoid"]);
    expect(changed.version).toBe(2);
    expect((await listCardNameAliases(ctx, f.cardId)).aliases).toEqual(["Camui Gackpo", "Gackpoid"]);
    expect((await listCards(ctx, { search: "  ＣＡＭＵＩ   GACKPO  " })).map(x => x.id)).toEqual([f.cardId]);
    expect((await getInventory(ctx, { search: "CAMUI gackpo" })).map(x => x.card_id)).toEqual([f.cardId]);
    expect(await countInventory(ctx, { search: "camui gackpo" })).toBe(1);
    await runtime.DB.prepare("UPDATE fb_collections SET view_audience = 'members' WHERE id = 'col_test_public'").run();
    const anonymous: Ctx = { ...ctx, user: null, actor: { type: "system", id: "anon", representedUserId: null, label: "Anonymous" }, sessionId: null, sessionAssurance: null, accessIdentity: null, accessStatus: null };
    expect(await listCards(anonymous, { search: "Camui Gackpo" })).toEqual([]);
    await expect(replaceCardNameAliases(ctx, f.cardId, 1, ["another"])).rejects.toMatchObject({code: "stale_card"});
    expect((await listCardNameAliases(ctx, f.cardId)).aliases).toEqual(["Camui Gackpo", "Gackpoid"]);
  });

  it("rejects ambiguous or duplicate aliases and preserves the previous names", async () => {
    await bootstrap();
    const ctx = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(ctx);
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at) VALUES ('gonta_fixture',?,'fixture:gonta','gonta','Gonta Gokuhara','fixture','published',?,?)").bind(ctx.tenant.id, now, now).run();
    await replaceCardNameAliases(ctx, f.cardId, 1, ["Camui Gackpo"]);
    await expect(replaceCardNameAliases(ctx, f.cardId, 2, ["Gonta Gokuhara"])).rejects.toMatchObject({code: "alias_conflict"});
    await expect(replaceCardNameAliases(ctx, "gonta_fixture", 1, ["CAMUI GACKPO"])).rejects.toMatchObject({code: "alias_conflict"});
    await expect(replaceCardNameAliases(ctx, f.cardId, 2, ["Camui Gackpo", " camui   gackpo "])).rejects.toMatchObject({code: "alias_invalid"});
    expect((await listCardNameAliases(ctx, f.cardId)).aliases).toEqual(["Camui Gackpo"]);
  });

  it("rechecks live scoped Bot content authority for writes", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(owner);
    const user = await createUser(runtime.DB, { email: "alias-editor@example.test", displayName: "Editor", password: "a-long-test-password" });
    await addMembership(runtime.DB, owner.tenant.id, user.id, "editor", { capabilities: ["content"] });
    const bot = await runtime.DB.prepare("SELECT id FROM fb_bots WHERE tenant_id = ?").bind(owner.tenant.id).first<{id: string}>();
    await runtime.DB.prepare("INSERT INTO fb_bot_admins (id,bot_id,user_id,role,capabilities_json,status,created_at) VALUES ('alias_admin',?,?,'admin','[\"content\"]','active',?)").bind(bot!.id, user.id, new Date().toISOString()).run();
    const editor: Ctx = { ...owner, user: { ...owner.user!, id: user.id, email: user.email, role: "editor", platformAdmin: false, capabilities: ["content"] }, actor: { type: "user", id: user.id, representedUserId: user.id, label: "Editor" }, sessionId: null };
    await replaceCardNameAliases(editor, f.cardId, 1, ["Gonta Gokuhara"]);
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"economy\"]' WHERE id = 'alias_admin'").run();
    await expect(replaceCardNameAliases(editor, f.cardId, 2, ["Gonta"])).rejects.toMatchObject({code: "insufficient_role"});
    await runtime.DB.prepare("UPDATE fb_bot_admins SET capabilities_json = '[\"content\"]', status = 'revoked', revoked_at = ? WHERE id = 'alias_admin'").bind(new Date().toISOString()).run();
    await expect(replaceCardNameAliases(editor, f.cardId, 2, ["Gonta"])).rejects.toMatchObject({code: "insufficient_role"});
    expect((await listCardNameAliases(owner, f.cardId)).aliases).toEqual(["Gonta Gokuhara"]);
  });

  it("requires strong authentication at the alias mutation route", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(owner);
    const path = `admin/cards/${f.cardId}/aliases`;
    const get = await routeApi(new Request(`https://test.local/api/v1/${path}`), owner, path);
    expect(await get.json()).toEqual({ aliases: [], version: 1 });
    const request = () => new Request(`https://test.local/api/v1/${path}`, { method: "PUT", headers: { "content-type": "application/json", "x-foilbury-csrf": owner.csrfToken! }, body: JSON.stringify({ expectedVersion: 1, aliases: ["Camui Gackpo"] }) });
    await expect(routeApi(request(), owner, path)).rejects.toMatchObject({status: 403});
    const agent: Ctx = { ...owner, actor: { type: "agent", id: "agent_test", representedUserId: owner.user!.id, label: "Agent" }, scopes: ["content:write"] };
    await expect(routeApi(request(), agent, path)).rejects.toMatchObject({ code: "human_strong_auth_required" });
    const strong: Ctx = { ...owner, sessionAssurance: "passkey", sessionAuthTime: new Date().toISOString() };
    const put = await routeApi(request(), strong, path);
    expect(await put.json()).toEqual({ aliases: ["Camui Gackpo"], version: 2 });
  });

  it("moves aliases on merge and invalidates an earlier target edit", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(owner);
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at) VALUES ('merge_target',?,'fixture:target','merge-target','Target','fixture','published',?,?)").bind(owner.tenant.id, now, now).run();
    await replaceCardNameAliases(owner, f.cardId, 1, ["Camui Gackpo"]);
    await mergeCards(owner, f.cardId, "merge_target");
    await expect(replaceCardNameAliases(owner, "merge_target", 1, [])).rejects.toMatchObject({ code: "stale_card" });
    expect((await listCardNameAliases(owner, "merge_target")).aliases).toEqual(["Camui Gackpo"]);
  });

  it("refuses to resolve an alias if a later canonical name makes it ambiguous", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const f = await fixturePool(owner);
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,created_at,updated_at) VALUES ('other_card',?,'fixture:other','other-card','Other','fixture','published',?,?)").bind(owner.tenant.id, now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_artwork_editions (id,tenant_id,card_id,name,subject_asset_id,recipe_id,status,created_at) VALUES ('other_edition',?,'other_card','Other',?,?,'published',?)").bind(owner.tenant.id, f.subjectAsset, f.recipeId, now).run();
    await runtime.DB.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) VALUES ('col_test_public','other_card',?,1,'test',?)").bind(owner.tenant.id, now).run();
    await replaceCardNameAliases(owner, f.cardId, 1, ["Camui Gackpo"]);
    await runtime.DB.prepare("UPDATE fb_card_definitions SET description = 'Mentions Camui Gackpo' WHERE id = 'other_card'").run();
    const exact = await listCards(owner, { search: "Camui Gackpo", exactName: true });
    expect(uniqueCardSearchMatch(exact)?.id).toBe(f.cardId);
    expect((await listCards(owner, { search: "Camui Gackpo" })).length).toBe(2);
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name = 'Camui Gackpo' WHERE id = 'other_card'").run();
    const matches = await listCards(owner, { search: " ＣＡＭＵＩ   GACKPO ", exactName: true });
    expect(matches.map(card => card.id).sort()).toEqual([f.cardId, "other_card"].sort());
    expect(() => uniqueCardSearchMatch(matches)).toThrowError(/more than one card/i);
  });
});
