import { describe, expect, it } from "vitest";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { nowIso } from "../../src/server/db";
import {
  approvePublicSetRelease,
  listPublicSetReviewCandidates,
  currentPublicSetRelease,
  previewPublicSetRelease,
  revokePublicSetRelease,
} from "../../src/server/modules/public-set-releases";
import { claimSetCompletion, createSet, listSets } from "../../src/server/modules/catalogue";
import { routeApi } from "../../src/server/api/router";

async function memberSession() {
  const ctx = await ctxFor("cabinet", "player@foilbury.local"),
    now = nowIso(),
    expiry = new Date(Date.now() + 3600000).toISOString(),
    id = `member_${crypto.randomUUID()}`;
  await runtime.DB.prepare(
    "INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES (?,?,?,?,?,?,?,?, 'password', ?)",
  )
    .bind(id, id, ctx.user!.id, ctx.tenant.id, "test", now, expiry, now, now)
    .run();
  return { ...ctx, sessionId: id, sessionAssurance: "password", sessionAuthTime: now };
}

describe("reviewed public set releases", () => {
  it("discovers only current-tenant eligible sets or review history for a live strongly authenticated reviewer", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local"),
      player = await memberSession(),
      now = nowIso();
    const expires = new Date(Date.now() + 3600000).toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions(id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES('candidate_session','candidate_token',?,?,'test',?,?,?,'mfa',?)",
    )
      .bind(base.user!.id, base.tenant.id, now, expires, now, now)
      .run();
    const owner = {
      ...base,
      sessionId: "candidate_session",
      sessionAssurance: "mfa",
      sessionAuthTime: now,
    };
    const card = await fixturePool(owner);
    const foreign = await ctxFor("harbour", "harbour.owner@foilbury.test");
    await runtime.DB.prepare(
      "INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) VALUES('foreign_candidate',?,'foreign-candidate','Foreign hidden','','draft',1,?)",
    )
      .bind(foreign.tenant.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_public_set_releases(id,tenant_id,set_id,set_version,slug,name,description,reward_amount,roster_json,snapshot_hash,review_note,reviewed_by,reviewed_at) VALUES('foreign_review',?,'foreign_candidate',1,'foreign-candidate','Foreign hidden','',0,'[]','hash','fixture',?,?)",
    )
      .bind(foreign.tenant.id, owner.user!.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) VALUES('candidate_set',?,'candidate-set','Candidate','','published',1,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_memberships(id,tenant_id,set_id,set_version,card_id,created_at) VALUES('candidate_item',?,'candidate_set',1,?,?)",
    )
      .bind(owner.tenant.id, card.cardId, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_reward_rules(id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES('candidate_rule',?,'candidate_set',1,5,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    const path = "platform/public-set-review-candidates";
    const response = await routeApi(new Request(`http://localhost/api/v1/${path}`), owner, path);
    const items = ((await response.json()) as { items: Array<{ id: string }> }).items;
    expect(items.some((item) => item.id === "foreign_candidate")).toBe(false);
    expect(items).toContainEqual({
      id: "candidate_set",
      name: "Candidate",
      version: 1,
      eligible: true,
      has_history: false,
    });
    await expect(listPublicSetReviewCandidates(player)).rejects.toMatchObject({ status: 403 });
    const preview = await previewPublicSetRelease(owner, "candidate_set");
    await approvePublicSetRelease(
      owner,
      "candidate_set",
      preview.snapshot_hash,
      "A deliberate fixture review for the candidate.",
    );
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'",
    ).run();
    expect((await listPublicSetReviewCandidates(owner)).items).toContainEqual({
      id: "candidate_set",
      name: "Candidate",
      version: 1,
      eligible: false,
      has_history: true,
    });
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("CASE WHEN EXISTS (SELECT 1 FROM fb_public_set_releases h"))
              return statement;
            const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(stmt, {
                get(inner, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(inner.bind(...values));
                  if (method === "all")
                    return async () => {
                      await target
                        .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='candidate_session'")
                        .bind(now)
                        .run();
                      return inner.all();
                    };
                  const v = Reflect.get(inner, method, inner);
                  return typeof v === "function" ? v.bind(inner) : v;
                },
              });
            return wrap(statement);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect((await listPublicSetReviewCandidates({ ...owner, db })).items).toEqual([]);
    await runtime.DB.prepare(
      "UPDATE fb_sessions SET revoked_at=NULL WHERE id='candidate_session'",
    ).run();
    await expect(
      routeApi(new Request(`http://localhost/api/v1/${path}/extra`), owner, `${path}/extra`),
    ).rejects.toMatchObject({ status: 404 });
    await runtime.DB.prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<101)
      INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) SELECT 'candidate_bulk_'||i,?,'candidate-bulk-'||i,'Bulk','','draft',1,? FROM n`,
    )
      .bind(owner.tenant.id, now)
      .run();
    await runtime.DB.prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<101)
      INSERT INTO fb_public_set_releases(id,tenant_id,set_id,set_version,slug,name,description,reward_amount,roster_json,snapshot_hash,review_note,reviewed_by,reviewed_at)
      SELECT 'bulk_review_'||i,?,'candidate_bulk_'||i,1,'bulk','Bulk','',0,'[]','hash','fixture',?,? FROM n`,
    )
      .bind(owner.tenant.id, owner.user!.id, now)
      .run();
    await expect(listPublicSetReviewCandidates(owner)).rejects.toMatchObject({
      code: "set_list_overloaded",
    });
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='candidate_session'")
      .bind(now)
      .run();
    await expect(listPublicSetReviewCandidates(owner)).rejects.toMatchObject({
      code: "review_session_required",
    });
  });
  it("withholds releases on an unmigrated database but propagates other storage failures", async () => {
    await bootstrap();
    const ctx = await ctxFor("cabinet", "player@foilbury.local");
    const broken = (message: string) =>
      new Proxy(runtime.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (sql.includes("FROM fb_public_set_releases pr")) throw new Error(message);
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    expect(
      await currentPublicSetRelease(
        { ...ctx, db: broken("D1_ERROR: no such table: fb_public_set_releases") },
        "missing",
      ),
    ).toBeNull();
    await expect(
      currentPublicSetRelease({ ...ctx, db: broken("fixture storage failure") }, "missing"),
    ).rejects.toThrow("fixture storage failure");
  });
  it("requires explicit review, atomically claims once, and fails closed on revocation and races", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local"),
      player = await memberSession();
    const now = nowIso(),
      expiry = new Date(Date.now() + 3600000).toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('public_review_session','public_review_token',?,?,'csrf',?,?,?,'mfa',?)",
    )
      .bind(base.user!.id, base.tenant.id, now, expiry, now, now)
      .run();
    const owner = {
      ...base,
      sessionId: "public_review_session",
      sessionAssurance: "mfa",
      sessionAuthTime: now,
    };
    const fixture = await fixturePool(owner);
    const beforeSets = (await runtime.DB.prepare(
      "SELECT COUNT(*) AS n FROM fb_sets WHERE tenant_id=?",
    )
      .bind(owner.tenant.id)
      .first<{ n: number }>())!.n;
    await expect(
      createSet(player, {
        slug: "not-allowed",
        name: "Not allowed",
        description: "fixture",
        rewardAmount: 1,
      }),
    ).rejects.toMatchObject({ code: "set_management_forbidden" });
    expect(
      (await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_sets WHERE tenant_id=?")
        .bind(owner.tenant.id)
        .first<{ n: number }>())!.n,
    ).toBe(beforeSets);
    await makeInstance(player, player.user!.id, fixture);
    await runtime.DB.prepare(
      "INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES ('reviewed_set',?,'reviewed-set','Reviewed set','Safe fixture','published',1,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES ('reviewed_member',?,'reviewed_set',1,?,?)",
    )
      .bind(owner.tenant.id, fixture.cardId, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES ('reviewed_reward',?,'reviewed_set',1,12,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    await expect(
      runtime.DB.prepare(
        "INSERT INTO fb_set_completion_claims (id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key) VALUES ('unguarded',?,?,'reviewed_set',1,999,?,'unguarded')",
      )
        .bind(player.tenant.id, player.user!.id, now)
        .run(),
    ).rejects.toThrow(/public_set_claim_guard/);
    expect((await listSets(player, player.user!.id)).some((s) => s.id === "reviewed_set")).toBe(
      false,
    );
    expect(
      (await listSets(owner, undefined, { publicOnly: true })).some((s) => s.id === "reviewed_set"),
    ).toBe(false);
    await expect(claimSetCompletion(player, "reviewed_set", "first-key")).rejects.toMatchObject({
      code: "set_completion_unavailable",
    });
    const preview = await previewPublicSetRelease(owner, "reviewed_set");
    await expect(
      approvePublicSetRelease(
        player,
        "reviewed_set",
        preview.snapshot_hash,
        "Explicitly reviewed public set fixture.",
      ),
    ).rejects.toMatchObject({ code: "super_admin_required" });
    const platformPath = "platform/sets/reviewed_set/public-review";
    await expect(
      routeApi(new Request(`http://localhost/api/v1/${platformPath}`), player, platformPath),
    ).rejects.toMatchObject({ code: "super_admin_required" });
    const platformPreview = await routeApi(
      new Request(`http://localhost/api/v1/${platformPath}`),
      owner,
      platformPath,
    );
    expect(((await platformPreview.json()) as { snapshot_hash: string }).snapshot_hash).toBe(
      preview.snapshot_hash,
    );
    await expect(
      routeApi(
        new Request(`http://localhost/api/v1/${platformPath}/extra`),
        owner,
        `${platformPath}/extra`,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const path = "admin/sets/reviewed_set/public-review";
    await expect(
      routeApi(new Request(`http://localhost/api/v1/${path}`), player, path),
    ).rejects.toMatchObject({ code: "super_admin_required" });
    const routePreview = await routeApi(
      new Request(`http://localhost/api/v1/${path}`),
      owner,
      path,
    );
    expect(((await routePreview.json()) as { snapshot_hash: string }).snapshot_hash).toBe(
      preview.snapshot_hash,
    );
    const routeApproval = await routeApi(
      new Request(`http://localhost/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
        body: JSON.stringify({
          snapshotHash: preview.snapshot_hash,
          note: "Explicitly reviewed public set fixture.",
        }),
      }),
      owner,
      path,
    );
    expect(routeApproval.status).toBe(201);
    const review = (await routeApproval.json()) as { id: string; snapshot_hash: string };
    const historyPath = "admin/sets/reviewed_set/public-reviews";
    const history = await routeApi(
      new Request(`http://localhost/api/v1/${historyPath}`),
      owner,
      historyPath,
    );
    expect(
      ((await history.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id),
    ).toContain(review.id);
    await expect(
      routeApi(new Request(`http://localhost/api/v1/${historyPath}`), player, historyPath),
    ).rejects.toMatchObject({ code: "super_admin_required" });
    await expect(
      runtime.DB.prepare("UPDATE fb_public_set_releases SET name='changed' WHERE id=?")
        .bind(review.id)
        .run(),
    ).rejects.toThrow(/public_set_release_immutable/);
    await expect(
      runtime.DB.prepare(
        "INSERT INTO fb_set_completion_claims (id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key) VALUES ('wrong_reward',?,?,'reviewed_set',1,999,?,'wrong_reward')",
      )
        .bind(player.tenant.id, player.user!.id, now)
        .run(),
    ).rejects.toThrow(/public_set_claim_guard/);
    expect(
      (await listSets(player, player.user!.id)).find((s) => s.id === "reviewed_set")?.progress,
    ).toMatchObject({ owned: 1, complete: true, claimed: false });
    // A change after the certified set-row read must suppress the result.
    const readRaceDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (sql.includes("SELECT s.id, s.slug, s.name, s.description")) {
              const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(statement, {
                  get(inner, method) {
                    if (method === "bind")
                      return (...values: unknown[]) => wrap(inner.bind(...values));
                    if (method === "all")
                      return async () => {
                        const result = await inner.all();
                        await target
                          .prepare(
                            "UPDATE fb_sets SET name='Unreviewed stale name' WHERE id='reviewed_set'",
                          )
                          .run();
                        return result;
                      };
                    const v = Reflect.get(inner, method, inner);
                    return typeof v === "function" ? v.bind(inner) : v;
                  },
                });
              return wrap(stmt);
            }
            return stmt;
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(
      (await listSets({ ...player, db: readRaceDb }, player.user!.id)).some(
        (s) => s.id === "reviewed_set",
      ),
    ).toBe(false);
    await runtime.DB.prepare(
      "UPDATE fb_sets SET name='Reviewed set' WHERE id='reviewed_set'",
    ).run();
    // An edit after certification hides the set until the exact reviewed state returns.
    await runtime.DB.prepare(
      "UPDATE fb_card_definitions SET name='Unreviewed roster name' WHERE id=?",
    )
      .bind(fixture.cardId)
      .run();
    expect((await listSets(player, player.user!.id)).some((s) => s.id === "reviewed_set")).toBe(
      false,
    );
    await expect(claimSetCompletion(player, "reviewed_set", "changed-key")).rejects.toMatchObject({
      code: "set_completion_unavailable",
    });
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name=? WHERE id=?")
      .bind(preview.snapshot.roster[0]![2], fixture.cardId)
      .run();
    let rosterChanged = false;
    const rosterRaceDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("SELECT pr.id,pr.set_id,pr.set_version")) return stmt;
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(inner, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(inner.bind(...values));
                  if (method === "all")
                    return async () => {
                      const result = await inner.all();
                      if (!rosterChanged) {
                        rosterChanged = true;
                        await target
                          .prepare(
                            "UPDATE fb_card_definitions SET name='Unreviewed after check' WHERE id=?",
                          )
                          .bind(fixture.cardId)
                          .run();
                      }
                      return result;
                    };
                  const v = Reflect.get(inner, method, inner);
                  return typeof v === "function" ? v.bind(inner) : v;
                },
              });
            return wrap(stmt);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect(
      (await listSets({ ...player, db: rosterRaceDb }, player.user!.id)).some(
        (s) => s.id === "reviewed_set",
      ),
    ).toBe(false);
    await runtime.DB.prepare("UPDATE fb_card_definitions SET name=? WHERE id=?")
      .bind(preview.snapshot.roster[0]![2], fixture.cardId)
      .run();
    const agent = {
      ...player,
      actor: {
        type: "agent" as const,
        id: "agent-fixture",
        representedUserId: player.user!.id,
        label: "fixture",
      },
      scopes: ["reward:claim"],
    };
    await expect(claimSetCompletion(agent, "reviewed_set", "agent-key")).rejects.toMatchObject({
      code: "set_claim_unavailable",
    });
    const before = await runtime.DB.prepare(
      "SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .first<{ balance: number }>();
    const [a, b] = await Promise.all([
      claimSetCompletion(player, "reviewed_set", "first-key"),
      claimSetCompletion(player, "reviewed_set", "first-key"),
    ]);
    expect(a).toEqual(b);
    expect(
      (await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?")
        .bind(player.tenant.id, player.user!.id)
        .first<{ balance: number }>())!.balance,
    ).toBe(before!.balance + 12);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) AS n FROM fb_ledger_entries WHERE tenant_id=? AND user_id=? AND reference_type='set_completion'",
        )
          .bind(player.tenant.id, player.user!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    let revokedBeforeReplay = false;
    const replayDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("FROM fb_set_completion_claims sc")) return stmt;
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(inner, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(inner.bind(...values));
                  if (method === "all")
                    return async () => {
                      if (!revokedBeforeReplay) {
                        revokedBeforeReplay = true;
                        await target
                          .prepare(
                            "UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?",
                          )
                          .bind(now, player.tenant.id, player.user!.id)
                          .run();
                      }
                      return inner.all();
                    };
                  const v = Reflect.get(inner, method, inner);
                  return typeof v === "function" ? v.bind(inner) : v;
                },
              });
            return wrap(stmt);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db: replayDb }, "reviewed_set", "first-key"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status='active',revoked_at=NULL WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .run();
    let sessionRevokedBeforeReplay = false;
    const replaySessionDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("FROM fb_set_completion_claims sc")) return stmt;
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(inner, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(inner.bind(...values));
                  if (method === "all")
                    return async () => {
                      if (!sessionRevokedBeforeReplay) {
                        sessionRevokedBeforeReplay = true;
                        await target
                          .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
                          .bind(now, player.sessionId)
                          .run();
                      }
                      return inner.all();
                    };
                  const v = Reflect.get(inner, method, inner);
                  return typeof v === "function" ? v.bind(inner) : v;
                },
              });
            return wrap(stmt);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db: replaySessionDb }, "reviewed_set", "first-key"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=NULL WHERE id=?")
      .bind(player.sessionId)
      .run();
    const platformRevoke = `platform/public-set-releases/${review.id}/revoke`;
    await expect(
      routeApi(
        new Request(`http://localhost/api/v1/${platformRevoke}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
          body: JSON.stringify({ reason: "The public review is deliberately revoked." }),
        }),
        player,
        platformRevoke,
      ),
    ).rejects.toMatchObject({ code: "super_admin_required" });
    const revoked = await routeApi(
      new Request(`http://localhost/api/v1/${platformRevoke}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-foilbury-csrf": "test" },
        body: JSON.stringify({ reason: "The public review is deliberately revoked." }),
      }),
      owner,
      platformRevoke,
    );
    expect(revoked.status).toBe(200);
    expect((await listSets(player, player.user!.id)).some((s) => s.id === "reviewed_set")).toBe(
      false,
    );
    expect(await claimSetCompletion(player, "reviewed_set", "first-key")).toEqual(a);
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_set_completion_claims WHERE id=?")
          .bind(a.claim_id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await expect(
      approvePublicSetRelease(
        owner,
        "reviewed_set",
        preview.snapshot_hash,
        "A second review must use a new version.",
      ),
    ).rejects.toMatchObject({ code: "public_set_version_already_reviewed" });
  });
  it("rolls back credit if a later transaction statement fails", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local"),
      player = await memberSession();
    const now = nowIso(),
      expiry = new Date(Date.now() + 3600000).toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('set_session_2','set_token_2',?,?,'csrf',?,?,?,'mfa',?)",
    )
      .bind(base.user!.id, base.tenant.id, now, expiry, now, now)
      .run();
    const owner = {
      ...base,
      sessionId: "set_session_2",
      sessionAssurance: "mfa",
      sessionAuthTime: now,
    };
    const fixture = await fixturePool(owner);
    await makeInstance(player, player.user!.id, fixture);
    await runtime.DB.prepare(
      "INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES ('rollback_set',?,'rollback-set','Rollback','Safe fixture','published',1,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES ('rollback_member',?,'rollback_set',1,?,?)",
    )
      .bind(owner.tenant.id, fixture.cardId, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES ('rollback_reward',?,'rollback_set',1,12,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    const p = await previewPublicSetRelease(owner, "rollback_set");
    await approvePublicSetRelease(
      owner,
      "rollback_set",
      p.snapshot_hash,
      "Explicitly reviewed public set fixture.",
    );
    const before = await runtime.DB.prepare(
      "SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .first<{ balance: number }>();
    const db = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (stmts: D1PreparedStatement[]) =>
            target.batch([
              ...stmts,
              target
                .prepare(
                  "INSERT INTO fb_set_completion_claims (id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key) VALUES ('bad',?,?, 'rollback_set',1,12,?,'duplicate')",
                )
                .bind(player.tenant.id, player.user!.id, now),
            ]);
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db }, "rollback_set", "rollback-key"),
    ).rejects.toThrow();
    expect(
      (await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?")
        .bind(player.tenant.id, player.user!.id)
        .first<{ balance: number }>())!.balance,
    ).toBe(before!.balance);
    expect(
      await runtime.DB.prepare(
        "SELECT id FROM fb_set_completion_claims WHERE idempotency_key='rollback-key'",
      ).first(),
    ).toBeNull();
  });
  it("fences review and claim races, and rejects same-key claims across sets", async () => {
    await bootstrap();
    const base = await ctxFor("cabinet", "owner@foilbury.local"),
      player = await memberSession();
    const now = nowIso(),
      expiry = new Date(Date.now() + 3600000).toISOString();
    await runtime.DB.prepare(
      "INSERT INTO fb_sessions (id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES ('set_session_3','set_token_3',?,?,'csrf',?,?,?,'mfa',?)",
    )
      .bind(base.user!.id, base.tenant.id, now, expiry, now, now)
      .run();
    const owner = {
      ...base,
      sessionId: "set_session_3",
      sessionAssurance: "mfa",
      sessionAuthTime: now,
    };
    const fixture = await fixturePool(owner);
    await makeInstance(player, player.user!.id, fixture);
    for (const suffix of ["a", "b", "c"]) {
      await runtime.DB.prepare(
        "INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) VALUES (?,?,?,?,'safe fixture','published',1,?)",
      )
        .bind(`race_${suffix}`, owner.tenant.id, `race-${suffix}`, `Race ${suffix}`, now)
        .run();
      await runtime.DB.prepare(
        "INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,created_at) VALUES (?,?,?,1,?,?)",
      )
        .bind(`member_${suffix}`, owner.tenant.id, `race_${suffix}`, fixture.cardId, now)
        .run();
      await runtime.DB.prepare(
        "INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES (?,?,?,1,12,?)",
      )
        .bind(`reward_${suffix}`, owner.tenant.id, `race_${suffix}`, now)
        .run();
    }
    const first = await previewPublicSetRelease(owner, "race_a");
    let previewRevoked = false;
    const previewDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!sql.includes("AS ok") || !sql.includes("fb_set_memberships sm")) return stmt;
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(inner, method) {
                  if (method === "bind")
                    return (...values: unknown[]) => wrap(inner.bind(...values));
                  if (method === "first")
                    return async () => {
                      const result = await inner.first();
                      if (!previewRevoked) {
                        previewRevoked = true;
                        await target
                          .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='set_session_3'")
                          .bind(now)
                          .run();
                      }
                      return result;
                    };
                  const v = Reflect.get(inner, method, inner);
                  return typeof v === "function" ? v.bind(inner) : v;
                },
              });
            return wrap(stmt);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      previewPublicSetRelease({ ...owner, db: previewDb }, "race_a"),
    ).rejects.toMatchObject({ code: "review_session_required" });
    await runtime.DB.prepare(
      "UPDATE fb_sessions SET revoked_at=NULL WHERE id='set_session_3'",
    ).run();
    let fired = false;
    const changedDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (!fired) {
              fired = true;
              await target
                .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id='set_session_3'")
                .bind(now)
                .run();
            }
            return target.batch(stmts);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      approvePublicSetRelease(
        { ...owner, db: changedDb },
        "race_a",
        first.snapshot_hash,
        "Explicitly reviewed public set fixture.",
      ),
    ).rejects.toMatchObject({ code: "public_set_changed" });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) AS n FROM fb_public_set_releases").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    await runtime.DB.prepare(
      "UPDATE fb_sessions SET revoked_at=NULL WHERE id='set_session_3'",
    ).run();
    await approvePublicSetRelease(
      owner,
      "race_a",
      first.snapshot_hash,
      "Explicitly reviewed public set fixture.",
    );
    const second = await previewPublicSetRelease(owner, "race_b");
    await approvePublicSetRelease(
      owner,
      "race_b",
      second.snapshot_hash,
      "Explicitly reviewed public set fixture.",
    );
    const third = await previewPublicSetRelease(owner, "race_c");
    const releaseC = await approvePublicSetRelease(
      owner,
      "race_c",
      third.snapshot_hash,
      "Explicitly reviewed public set fixture.",
    );
    let revokedRelease = false;
    const revokedReleaseDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (!revokedRelease) {
              revokedRelease = true;
              await target
                .prepare(
                  "INSERT INTO fb_public_set_release_revocations (release_id,revoked_by,revoked_at,reason) VALUES (?,?,?,?)",
                )
                .bind(releaseC.id, owner.user!.id, now, "Fixture revocation")
                .run();
            }
            return target.batch(stmts);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db: revokedReleaseDb }, "race_c", "revoked-key"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    expect(
      await runtime.DB.prepare(
        "SELECT id FROM fb_set_completion_claims WHERE idempotency_key='revoked-key'",
      ).first(),
    ).toBeNull();
    let membershipRevoked = false;
    const revokedMemberDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (!membershipRevoked) {
              membershipRevoked = true;
              await target
                .prepare(
                  "UPDATE fb_memberships SET status='revoked',revoked_at=? WHERE tenant_id=? AND user_id=?",
                )
                .bind(now, player.tenant.id, player.user!.id)
                .run();
            }
            return target.batch(stmts);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db: revokedMemberDb }, "race_a", "member-key"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    expect(
      await runtime.DB.prepare(
        "SELECT id FROM fb_set_completion_claims WHERE idempotency_key='member-key'",
      ).first(),
    ).toBeNull();
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET status='active',revoked_at=NULL WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .run();
    let claimSessionRevoked = false;
    const revokedSessionDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (!claimSessionRevoked) {
              claimSessionRevoked = true;
              await target
                .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
                .bind(now, player.sessionId)
                .run();
            }
            return target.batch(stmts);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db: revokedSessionDb }, "race_a", "session-key"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    expect(
      await runtime.DB.prepare(
        "SELECT id FROM fb_set_completion_claims WHERE idempotency_key='session-key'",
      ).first(),
    ).toBeNull();
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=NULL WHERE id=?")
      .bind(player.sessionId)
      .run();
    await runtime.DB.prepare(
      "UPDATE fb_sets SET description='Edited private draft' WHERE id='race_a'",
    ).run();
    expect((await listSets(player, player.user!.id)).some((s) => s.id === "race_a")).toBe(false);
    await expect(claimSetCompletion(player, "race_a", "edited-key")).rejects.toMatchObject({
      code: "set_completion_unavailable",
    });
    await runtime.DB.prepare(
      "UPDATE fb_sets SET description='safe fixture' WHERE id='race_a'",
    ).run();
    await runtime.DB.prepare(
      "UPDATE fb_set_reward_rules SET reward_amount=13 WHERE id='reward_a'",
    ).run();
    await expect(claimSetCompletion(player, "race_a", "reward-key")).rejects.toMatchObject({
      code: "set_completion_unavailable",
    });
    await runtime.DB.prepare(
      "UPDATE fb_set_reward_rules SET reward_amount=12 WHERE id='reward_a'",
    ).run();
    let hidden = false;
    const hiddenDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (stmts: D1PreparedStatement[]) => {
            if (!hidden) {
              hidden = true;
              await target
                .prepare(
                  "UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'",
                )
                .run();
            }
            return target.batch(stmts);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimSetCompletion({ ...player, db: hiddenDb }, "race_a", "hidden-key"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    expect(
      await runtime.DB.prepare(
        "SELECT id FROM fb_set_completion_claims WHERE idempotency_key='hidden-key'",
      ).first(),
    ).toBeNull();
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='public' WHERE id='col_test_public'",
    ).run();
    await runtime.DB.prepare(
      "UPDATE fb_collections SET scope='bot' WHERE id='col_test_public'",
    ).run();
    await expect(claimSetCompletion(player, "race_a", "bot-scope-key")).rejects.toMatchObject({
      code: "set_completion_unavailable",
    });
    await runtime.DB.prepare(
      "UPDATE fb_collections SET scope='global' WHERE id='col_test_public'",
    ).run();
    const before = (await runtime.DB.prepare(
      "SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .first<{ balance: number }>())!.balance;
    const results = await Promise.allSettled([
      claimSetCompletion(player, "race_a", "shared-key"),
      claimSetCompletion(player, "race_b", "shared-key"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?")
        .bind(player.tenant.id, player.user!.id)
        .first<{ balance: number }>())!.balance,
    ).toBe(before + 12);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) AS n FROM fb_set_completion_claims WHERE tenant_id=? AND user_id=? AND idempotency_key='shared-key'",
        )
          .bind(player.tenant.id, player.user!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    // Historical corruption fixture: do not arbitrarily select one of two old receipts.
    await runtime.DB.exec(
      "DROP TRIGGER set_completion_apply; DROP TRIGGER public_set_claim_guard;",
    );
    const existingClaim = await runtime.DB.prepare(
      "SELECT set_id FROM fb_set_completion_claims WHERE tenant_id=? AND user_id=? AND idempotency_key='shared-key'",
    )
      .bind(player.tenant.id, player.user!.id)
      .first<{ set_id: string }>();
    const other = existingClaim!.set_id === "race_a" ? "race_b" : "race_a";
    await runtime.DB.prepare(
      "INSERT INTO fb_set_completion_claims (id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key) VALUES ('legacy_ambiguous',?,?,?,1,12,?,'shared-key')",
    )
      .bind(player.tenant.id, player.user!.id, other, now)
      .run();
    await expect(
      claimSetCompletion(player, existingClaim!.set_id, "shared-key"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) AS n FROM fb_set_completion_claims WHERE tenant_id=? AND user_id=? AND idempotency_key='shared-key'",
        )
          .bind(player.tenant.id, player.user!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });
});
