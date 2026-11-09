import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrap, ctxFor, runtime } from "./helpers";
import { createCollection } from "../../src/server/modules/collections";
import { routeApi } from "../../src/server/api/router";
import { sha256Hex } from "../../src/server/ids";

describe("local additive subject drafts", () => {
  beforeEach(async () => { await bootstrap(); });
  it("imports one draft once through the API without changing collection switches or existing records", async () => {
    const base = await ctxFor("cabinet", "owner@foilbury.local");
    const initialTime=new Date().toISOString(),initialSession=`subject-collection-${crypto.randomUUID()}`;
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,'test',?,?,?,'passkey',?)").bind(initialSession,initialSession,base.user!.id,base.tenant.id,initialTime,new Date(Date.now()+60000).toISOString(),initialTime,initialTime).run();
    const owner={...base,sessionId:initialSession,sessionAssurance:'passkey',sessionAuthTime:initialTime};
    const collection = await createCollection(owner, { name: "Vocaloid", scope: "global", status: "published", viewAudience: "private" });
    await runtime.DB.prepare("UPDATE fb_collections SET slug = 'vocaloid' WHERE id = ?").bind(collection.id).run();
    const now = new Date().toISOString(), expires = new Date(Date.now() + 3600000).toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('subject_session','subject_hash',?,?,'test',?,?,?,'mfa',?)").bind(owner.user!.id, owner.tenant.id, now, expires, now, now).run();
    const ctx = { ...owner, config: { ...owner.config, environment: "local" as const, localMode: true }, sessionId: "subject_session", sessionAssurance: "mfa", sessionAuthTime: now };
    const recordJson = JSON.stringify({ slug: "kamui-gakupo", logical_id: "vocaloid:kamui-gakupo", name: "Kamui Gakupo", description: "Draft fixture" });
    const payload = { recordJson, sha256: await sha256Hex(recordJson) };
    const call = () => routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(payload) }), ctx, "admin/local-subject-drafts");
    const before = await runtime.DB.prepare("SELECT * FROM fb_bot_collections ORDER BY bot_id,collection_id").all();
    expect((await call()).status).toBe(201);
    await expect(call()).rejects.toMatchObject({ code: "identity_conflict" });
    const row = await runtime.DB.prepare("SELECT status,review_status FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = ?").bind(owner.tenant.id, "vocaloid:kamui-gakupo").first();
    expect(row).toEqual({ status: "draft", review_status: "draft" });
    const aliases = await runtime.DB.prepare("SELECT alias FROM fb_card_name_aliases WHERE tenant_id = ? ORDER BY alias").bind(owner.tenant.id).all();
    expect(aliases.results).toHaveLength(3);
    const linked = await runtime.DB.prepare("SELECT count(*) AS n FROM fb_collection_cards WHERE collection_id = ? AND card_id IN (SELECT id FROM fb_card_definitions WHERE logical_id = 'vocaloid:kamui-gakupo' AND tenant_id = ?)").bind(collection.id, owner.tenant.id).first<{ n: number }>();
    expect(linked?.n).toBe(1);
    const audits = await runtime.DB.prepare("SELECT count(*) AS n FROM fb_audit_events WHERE tenant_id = ? AND action = 'local_subject.draft_created'").bind(owner.tenant.id).first<{ n: number }>();
    expect(audits?.n).toBe(1);
    expect((await runtime.DB.prepare("SELECT * FROM fb_bot_collections ORDER BY bot_id,collection_id").all()).results).toEqual(before.results);
    const danganronpa = await createCollection(owner, { name: "Danganronpa", scope: "global", status: "published", viewAudience: "private" });
    await runtime.DB.prepare("UPDATE fb_collections SET slug = 'danganronpa-three-games' WHERE id = ?").bind(danganronpa.id).run();
    const imported = await runtime.DB.prepare("SELECT id FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = ?").bind(owner.tenant.id, "vocaloid:kamui-gakupo").first<{ id: string }>();
    let injected = false;
    const racingDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!injected) { injected = true; await target.prepare("INSERT INTO fb_card_name_aliases (tenant_id,card_id,alias,normalized,created_at) VALUES (?,?, 'Gonta', 'gonta', ?)").bind(owner.tenant.id, imported!.id, now).run(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const gontaJson = JSON.stringify({ slug: "gonta-gokuhara", logical_id: "danganronpa:gonta-gokuhara", name: "Gonta Gokuhara", description: "Draft fixture" });
    const gontaBody = { recordJson: gontaJson, sha256: await sha256Hex(gontaJson) };
    await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(gontaBody) }), { ...ctx, db: racingDb }, "admin/local-subject-drafts")).rejects.toMatchObject({ code: "import_conflict" });
    expect(await runtime.DB.prepare("SELECT id FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = 'danganronpa:gonta-gokuhara'").bind(owner.tenant.id).first()).toBeNull();
    await runtime.DB.prepare("DELETE FROM fb_card_name_aliases WHERE tenant_id = ? AND normalized = 'gonta'").bind(owner.tenant.id).run();
    let revoked = false;
    const revokedDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!revoked) { revoked = true; await target.prepare("UPDATE fb_sessions SET revoked_at = ? WHERE id = 'subject_session'").bind(now).run(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(gontaBody) }), { ...ctx, db: revokedDb }, "admin/local-subject-drafts")).rejects.toMatchObject({ code: "import_conflict" });
    expect(await runtime.DB.prepare("SELECT id FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = 'danganronpa:gonta-gokuhara'").bind(owner.tenant.id).first()).toBeNull();
    const races = [
      ["UPDATE fb_sessions SET expires_at = ? WHERE id = 'subject_session'", "UPDATE fb_sessions SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = 'subject_session' AND ? IS NOT NULL", ["2000-01-01T00:00:00.000Z"]],
      ["UPDATE fb_sessions SET auth_time = ? WHERE id = 'subject_session'", "UPDATE fb_sessions SET auth_time = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'subject_session' AND ? IS NOT NULL", ["2000-01-01T00:00:00.000Z"]],
      ["UPDATE fb_sessions SET assurance = 'password' WHERE id = 'subject_session'", "UPDATE fb_sessions SET assurance = 'mfa' WHERE id = 'subject_session'", []],
      ["UPDATE fb_memberships SET status = 'revoked' WHERE tenant_id = ? AND user_id = ?", "UPDATE fb_memberships SET status = 'active' WHERE tenant_id = ? AND user_id = ?", [owner.tenant.id, owner.user!.id]],
      ["UPDATE fb_bots SET owner_user_id = (SELECT id FROM fb_users WHERE id <> ? LIMIT 1) WHERE tenant_id = ?", "UPDATE fb_bots SET owner_user_id = ? WHERE tenant_id = ?", [owner.user!.id, owner.tenant.id]],
      ["UPDATE fb_collections SET archived_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", "UPDATE fb_collections SET archived_at = NULL WHERE id = ?", [danganronpa.id]],
      ["UPDATE fb_card_definitions SET name = 'Gonta' WHERE id = ?", "UPDATE fb_card_definitions SET name = 'Kamui Gakupo' WHERE id = ?", [imported!.id]],
    ] as const;
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at = NULL WHERE id = 'subject_session'").run();
    for (const [mutate, restore, params] of races) {
      let fired = false;
      const db = new Proxy(runtime.DB, { get(target, key) {
        if (key === "batch") return async (statements: D1PreparedStatement[]) => {
          if (!fired) { fired = true; await target.prepare(mutate).bind(...params).run(); }
          return target.batch(statements);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(gontaBody) }), { ...ctx, db }, "admin/local-subject-drafts")).rejects.toMatchObject({ code: "import_conflict" });
      expect(await runtime.DB.prepare("SELECT id FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = 'danganronpa:gonta-gokuhara'").bind(owner.tenant.id).first()).toBeNull();
      await runtime.DB.prepare(restore).bind(...params).run();
    }
    const failingDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async () => { throw new Error("fixture storage failure"); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(gontaBody) }), { ...ctx, db: failingDb }, "admin/local-subject-drafts")).rejects.toThrow("fixture storage failure");
    const rollbackDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => target.batch([...statements, target.prepare("INSERT INTO fb_card_name_aliases (tenant_id,card_id,alias,normalized,created_at) VALUES (?,?, 'Gackpoid', 'gackpoid', ?)").bind(owner.tenant.id, imported!.id, now)]);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(gontaBody) }), { ...ctx, db: rollbackDb }, "admin/local-subject-drafts")).rejects.toThrow();
    expect(await runtime.DB.prepare("SELECT id FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = 'danganronpa:gonta-gokuhara'").bind(owner.tenant.id).first()).toBeNull();
    const gontaResponse = await routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(gontaBody) }), ctx, "admin/local-subject-drafts");
    expect(gontaResponse.status).toBe(201);
    expect(await runtime.DB.prepare("SELECT status,review_status FROM fb_card_definitions WHERE tenant_id = ? AND logical_id = 'danganronpa:gonta-gokuhara'").bind(owner.tenant.id).first()).toEqual({ status: "draft", review_status: "draft" });
    const production = { ...ctx, config: { ...ctx.config, environment: "production" as const } };
    await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(payload) }), production, "admin/local-subject-drafts")).rejects.toMatchObject({ code: "local_only" });
    const disabledLocal = { ...ctx, config: { ...ctx.config, environment: "local" as const, localMode: false } };
    await expect(routeApi(new Request("http://localhost:5173/api/v1/admin/local-subject-drafts", { method: "POST", headers: { "content-type": "application/json", "x-foilbury-csrf": "test" }, body: JSON.stringify(payload) }), disabledLocal, "admin/local-subject-drafts")).rejects.toMatchObject({ code: "local_only" });
  });
});
