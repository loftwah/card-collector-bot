import { beforeEach, describe, expect, it } from "vitest";
import { recordCollectionArtReview } from "../../src/server/modules/collection-art-reviews";
import { sha256Hex } from "../../src/server/ids";
import { bootstrap, ctxFor, runtime } from "./helpers";

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII="), c => c.charCodeAt(0));
describe("collection artwork review evidence", () => {
  beforeEach(async () => { await bootstrap(); });
  it("records authenticated, byte-bound evidence without changing collection artwork and rejects replayed revoked sessions", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id, token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at, assurance, auth_time) VALUES ('review_session', 'review_hash', ?, ?, 'test', ?, ?, ?, 'passkey', ?)")
      .bind(owner.user!.id, owner.tenant.id, now, new Date(Date.now() + 60_000).toISOString(), now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_collections (id, slug, name, description, scope, owner_tenant_id, status, created_by, created_at, updated_at) VALUES ('col_review', 'review-fixture', 'Fixture', '', 'bot', ?, 'draft', ?, ?, ?)")
      .bind(owner.tenant.id, owner.user!.id, now, now).run();
    const sha = await sha256Hex(png);
    for (const role of ["mark", "cover", "back", "evidence"]) {
      await runtime.MEDIA.put(`fixture/${role}`, png);
      await runtime.DB.prepare("INSERT INTO fb_assets (id, tenant_id, kind, name, mime, bytes, r2_key, sha256, visibility, access_classification, processing_state, review_status, created_at) VALUES (?, ?, 'brand', ?, 'image/png', ?, ?, ?, 'private', 'private', 'ready', 'unreviewed', ?)")
        .bind(role, owner.tenant.id, role, png.length, `fixture/${role}`, sha, now).run();
    }
    const item = (id: string) => ({ id, sha256: sha });
    const body = { decision: "approved" as const, note: "Reviewed all four fixture images at full size.", mark: item("mark"), cover: item("cover"), back: item("back"), evidence: item("evidence") };
    const ctx = { ...owner, sessionId: "review_session", sessionAssurance: "passkey", sessionAuthTime: now };
    await expect(recordCollectionArtReview({ ...ctx, actor: { ...ctx.actor, type: "agent" } }, "col_review", body)).rejects.toMatchObject({ status: 403, code: "human_strong_auth_required" });
    await expect(recordCollectionArtReview(ctx, "col_review", { ...body, cover: { ...body.cover, sha256: "0".repeat(64) } })).rejects.toMatchObject({ status: 422, code: "review_asset_invalid" });
    const raceDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_assets SET r2_key = 'fixture/changed' WHERE id = 'cover'").run();
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(recordCollectionArtReview({ ...ctx, db: raceDb }, "col_review", body)).rejects.toMatchObject({ status: 409, code: "review_changed" });
    await runtime.DB.prepare("UPDATE fb_assets SET r2_key = 'fixture/cover' WHERE id = 'cover'").run();
    const expiryDb = new Proxy(runtime.DB, { get(target, key) {
      if (key === "batch") return async (...args: Parameters<typeof target.batch>) => {
        await target.prepare("UPDATE fb_sessions SET expires_at = ? WHERE id = 'review_session'").bind(new Date(Date.now() - 60_000).toISOString()).run();
        return target.batch(...args);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(recordCollectionArtReview({ ...ctx, db: expiryDb }, "col_review", body)).rejects.toMatchObject({ status: 409, code: "review_changed" });
    await runtime.DB.prepare("UPDATE fb_sessions SET expires_at = ? WHERE id = 'review_session'").bind(new Date(Date.now() + 60_000).toISOString()).run();
    const result = await recordCollectionArtReview(ctx, "col_review", body);
    expect(result.actor_kind).toBe("user");
    const collection = await runtime.DB.prepare("SELECT logo_url, banner_url, back_url FROM fb_collections WHERE id = 'col_review'").first();
    expect(collection).toEqual({ logo_url: null, banner_url: null, back_url: null });
    await expect(runtime.DB.prepare("DELETE FROM fb_collection_art_reviews WHERE id = ?").bind(result.id).run()).rejects.toThrow();
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at = ? WHERE id = 'review_session'").bind(now).run();
    await expect(recordCollectionArtReview(ctx, "col_review", body)).rejects.toMatchObject({ status: 403 });
  });
  it("fails closed on malformed and non-boolean global role scopes", async () => {
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const player = await ctxFor("cabinet", "player@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_sessions (id, token_hash, user_id, tenant_id, csrf_token, created_at, expires_at, last_seen_at, assurance, auth_time) VALUES ('scope_session', 'scope_hash', ?, ?, 'test', ?, ?, ?, 'passkey', ?)")
      .bind(player.user!.id, player.tenant.id, now, new Date(Date.now() + 60_000).toISOString(), now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_collections (id, slug, name, description, scope, status, created_by, created_at, updated_at) VALUES ('col_global_review', 'global-review-fixture', 'Fixture', '', 'global', 'draft', ?, ?, ?)")
      .bind(owner.user!.id, now, now).run();
    await runtime.DB.prepare("INSERT INTO fb_platform_role_assignments (id, user_id, role, scopes_json, status, granted_by, granted_at, reason) VALUES ('scope_fixture', ?, 'global_collection_admin', '{}', 'active', ?, ?, 'fixture')")
      .bind(player.user!.id, owner.user!.id, now).run();
    const selection = { id: "missing", sha256: "0".repeat(64) };
    const body = { decision: "approved" as const, note: "Reviewed all fixture artwork in context.", mark: selection, cover: selection, back: selection, evidence: selection };
    const ctx = { ...player, sessionId: "scope_session", sessionAssurance: "passkey", sessionAuthTime: now };
    for (const scope of ['not-json', '{}', '{"all":1}', '{"all":false,"collectionIds":"col_global_review"}', '{"all":false,"collectionIds":["col_global_review",1]}']) {
      await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json = ? WHERE id = 'scope_fixture'").bind(scope).run();
      await expect(recordCollectionArtReview(ctx, "col_global_review", body)).rejects.toMatchObject({ status: 403 });
    }
    await runtime.DB.prepare("UPDATE fb_platform_role_assignments SET scopes_json = ? WHERE id = 'scope_fixture'").bind('{"all":false,"collectionIds":["col_global_review"]}').run();
    await expect(recordCollectionArtReview(ctx, "col_global_review", body)).rejects.toMatchObject({ status: 422, code: "review_asset_invalid" });
  });
});
