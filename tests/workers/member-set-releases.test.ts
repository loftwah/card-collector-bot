import { describe, expect, it } from "vitest";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";
import { nowIso } from "../../src/server/db";
import { routeApi } from "../../src/server/api/router";
import {
  approveMemberSetRelease,
  claimMemberSetCompletion,
  listMemberSetRewards,
  previewMemberSetRelease,
  revokeMemberSetRelease,
} from "../../src/server/modules/member-set-releases";

async function session(ctx: Awaited<ReturnType<typeof ctxFor>>, assurance: "mfa" | "password") {
  const id = `sess_${crypto.randomUUID()}`,
    now = nowIso(),
    exp = new Date(Date.now() + 3600000).toISOString();
  await runtime.DB.prepare(
    `INSERT INTO fb_sessions(id,token_hash,user_id,tenant_id,csrf_token,created_at,expires_at,last_seen_at,assurance,auth_time) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, id, ctx.user!.id, ctx.tenant.id, "test", now, exp, now, assurance, now)
    .run();
  return { ...ctx, sessionId: id, sessionAssurance: assurance, sessionAuthTime: now };
}
async function fixture() {
  await bootstrap();
  const owner = await session(await ctxFor("cabinet", "owner@foilbury.local"), "mfa");
  const player = await session(await ctxFor("cabinet", "player@foilbury.local"), "password");
  const card = await fixturePool(owner),
    now = nowIso();
  await runtime.DB.prepare(
    "UPDATE fb_collections SET view_audience='members',public_approved_at=NULL WHERE id='col_test_public'",
  ).run();
  await runtime.DB.prepare(
    "INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) VALUES('member_set',?,'member-set','Unreviewed secret title','unreviewed text','published',1,?)",
  )
    .bind(owner.tenant.id, now)
    .run();
  await runtime.DB.prepare(
    "INSERT INTO fb_set_memberships(id,tenant_id,set_id,set_version,card_id,created_at) VALUES('member_item',?,'member_set',1,?,?)",
  )
    .bind(owner.tenant.id, card.cardId, now)
    .run();
  await runtime.DB.prepare(
    "INSERT INTO fb_set_reward_rules(id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES('member_rule',?,'member_set',1,12,?)",
  )
    .bind(owner.tenant.id, now)
    .run();
  await makeInstance(player, player.user!.id, card);
  return { owner, player, card };
}
describe("member set releases", () => {
  it("re-reviews a revoked version while retaining history and preventing double reward", async () => {
    const { owner, player } = await fixture();
    const firstPreview = await previewMemberSetRelease(owner, "member_set");
    const competing = await Promise.allSettled([
      approveMemberSetRelease(owner, "member_set", firstPreview.snapshot_hash),
      approveMemberSetRelease(owner, "member_set", firstPreview.snapshot_hash),
    ]);
    const success = competing.filter((r) => r.status === "fulfilled");
    expect(success).toHaveLength(1);
    const first = (success[0] as PromiseFulfilledResult<{ id: string }>).value;
    await claimMemberSetCompletion(player, "member_set", first.id, "original-key");
    await revokeMemberSetRelease(owner, first.id);
    const nextPreview = await previewMemberSetRelease(owner, "member_set");
    const next = await approveMemberSetRelease(owner, "member_set", nextPreview.snapshot_hash);
    expect(next.id).not.toBe(first.id);
    expect((await listMemberSetRewards(player))[0]).toMatchObject({
      release_id: next.id,
      claimed: true,
    });
    await expect(
      claimMemberSetCompletion(player, "member_set", next.id, "original-key"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      claimMemberSetCompletion(player, "member_set", next.id, "new-key"),
    ).rejects.toMatchObject({ code: "already_claimed" });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_member_set_releases").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(2);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='set_completion'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("keeps rewards available on an unmigrated database and propagates other errors", async () => {
    const { player } = await fixture();
    const unavailable = (message: string) =>
      new Proxy(runtime.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (sql.includes("FROM fb_member_set_releases mr")) throw new Error(message);
              return target.prepare(sql);
            };
          const v = Reflect.get(target, key, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    expect(
      await listMemberSetRewards({
        ...player,
        db: unavailable("D1_ERROR: no such table: fb_member_set_releases"),
      }),
    ).toEqual([]);
    await expect(
      listMemberSetRewards({ ...player, db: unavailable("D1_ERROR: database broken") }),
    ).rejects.toThrow("database broken");
  });
  it("does not credit two sets when concurrent claims share one idempotency key", async () => {
    const { owner, player, card } = await fixture();
    const now = nowIso();
    await runtime.DB.prepare(
      "INSERT INTO fb_sets(id,tenant_id,slug,name,description,status,version,created_at) VALUES('member_set_b',?,'member-set-b','B','','published',1,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_memberships(id,tenant_id,set_id,set_version,card_id,created_at) VALUES('member_item_b',?,'member_set_b',1,?,?)",
    )
      .bind(owner.tenant.id, card.cardId, now)
      .run();
    await runtime.DB.prepare(
      "INSERT INTO fb_set_reward_rules(id,tenant_id,set_id,set_version,reward_amount,created_at) VALUES('member_rule_b',?,'member_set_b',1,12,?)",
    )
      .bind(owner.tenant.id, now)
      .run();
    const a = await previewMemberSetRelease(owner, "member_set"),
      b = await previewMemberSetRelease(owner, "member_set_b");
    const ar = await approveMemberSetRelease(owner, "member_set", a.snapshot_hash),
      br = await approveMemberSetRelease(owner, "member_set_b", b.snapshot_hash);
    const results = await Promise.allSettled([
      claimMemberSetCompletion(player, "member_set", ar.id, "same-key"),
      claimMemberSetCompletion(player, "member_set_b", br.id, "same-key"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='set_completion'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("supports explicit review and bound claim through the API", async () => {
    const { owner, player } = await fixture();
    const reviewPath = "admin/sets/member_set/member-review";
    const preview = await routeApi(
      new Request(`http://localhost/api/v1/${reviewPath}`),
      owner,
      reviewPath,
    );
    const { snapshot_hash } = (await preview.json()) as { snapshot_hash: string };
    const approve = await routeApi(
      new Request(`http://localhost/api/v1/${reviewPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-foilbury-csrf": owner.csrfToken },
        body: JSON.stringify({ snapshotHash: snapshot_hash }),
      }),
      owner,
      reviewPath,
    );
    const { id } = (await approve.json()) as { id: string };
    const claimPath = "sets/member_set/claim";
    const claimed = await routeApi(
      new Request(`http://localhost/api/v1/${claimPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "member-api-claim",
          "x-foilbury-csrf": player.csrfToken,
        },
        body: JSON.stringify({ memberReleaseId: id }),
      }),
      player,
      claimPath,
    );
    expect(await claimed.json()).toMatchObject({ set_id: "member_set", amount: 12 });
  });
  it("binds collection changes into review and current release validity", async () => {
    const { owner, player } = await fixture();
    const initial = await previewMemberSetRelease(owner, "member_set");
    expect(initial.snapshot.collections[0]).toContain("col_test_public");
    await runtime.DB.prepare(
      "UPDATE fb_collections SET name='Renamed' WHERE id='col_test_public'",
    ).run();
    await expect(
      approveMemberSetRelease(owner, "member_set", initial.snapshot_hash),
    ).rejects.toMatchObject({ code: "member_set_changed" });
    const current = await previewMemberSetRelease(owner, "member_set");
    const release = await approveMemberSetRelease(owner, "member_set", current.snapshot_hash);
    await runtime.DB.prepare(
      "UPDATE fb_collections SET name='Changed again' WHERE id='col_test_public'",
    ).run();
    expect(await listMemberSetRewards(player)).toEqual([]);
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "changed"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
  });
  it("rejects unowned cards and database-level wrong rewards", async () => {
    const { owner, player } = await fixture();
    const preview = await previewMemberSetRelease(owner, "member_set");
    const release = await approveMemberSetRelease(owner, "member_set", preview.snapshot_hash);
    await expect(
      runtime.DB.prepare(
        `INSERT INTO fb_set_completion_claims(id,tenant_id,user_id,set_id,set_version,reward_amount,created_at,idempotency_key)
      VALUES('wrong',?,?,'member_set',1,999,?,'wrong')`,
      )
        .bind(player.tenant.id, player.user!.id, nowIso())
        .run(),
    ).rejects.toThrow(/public_set_claim_guard/);
    await runtime.DB.prepare(
      "UPDATE fb_card_instances SET status='surrendered' WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .run();
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "unowned"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_set_completion_claims").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
  it("requires explicit owner review and claims the exact roster once", async () => {
    const { owner, player } = await fixture();
    expect(await listMemberSetRewards(player)).toEqual([]);
    await expect(previewMemberSetRelease(player, "member_set")).rejects.toMatchObject({
      status: 403,
    });
    const preview = await previewMemberSetRelease(owner, "member_set");
    await expect(
      approveMemberSetRelease(owner, "member_set", "0".repeat(64)),
    ).rejects.toMatchObject({ code: "member_set_changed" });
    const release = await approveMemberSetRelease(owner, "member_set", preview.snapshot_hash);
    const visible = await listMemberSetRewards(player);
    expect(visible).toMatchObject([
      {
        id: "member_set",
        release_id: release.id,
        owned: 1,
        total: 1,
        complete: true,
        claimed: false,
      },
    ]);
    expect(visible[0].name).toMatch(/^Member set · /);
    expect(JSON.stringify(visible)).not.toContain("Unreviewed secret");
    const [a, b] = await Promise.all([
      claimMemberSetCompletion(player, "member_set", release.id, "same"),
      claimMemberSetCompletion(player, "member_set", release.id, "same"),
    ]);
    expect(a).toEqual(b);
    expect(a.amount).toBe(12);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_ledger_entries WHERE tenant_id=? AND user_id=? AND reference_type='set_completion'",
        )
          .bind(player.tenant.id, player.user!.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect((await listMemberSetRewards(player))[0]?.claimed).toBe(true);
    await revokeMemberSetRelease(owner, release.id);
    expect(await listMemberSetRewards(player)).toEqual([]);
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "new"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
  });
  it("denies changed audience and revoked member or session at the boundary", async () => {
    const { owner, player } = await fixture();
    const preview = await previewMemberSetRelease(owner, "member_set");
    const release = await approveMemberSetRelease(owner, "member_set", preview.snapshot_hash);
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'",
    ).run();
    expect(await listMemberSetRewards(player)).toEqual([]);
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "private"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='members' WHERE id='col_test_public'",
    ).run();
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET revoked_at=? WHERE tenant_id=? AND user_id=?",
    )
      .bind(nowIso(), player.tenant.id, player.user!.id)
      .run();
    expect(await listMemberSetRewards(player)).toEqual([]);
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "revoked"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    await runtime.DB.prepare(
      "UPDATE fb_memberships SET revoked_at=NULL WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .run();
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
      .bind(nowIso(), player.sessionId)
      .run();
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "session"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
  });
  it("rejects a stale review and a foreign Bot or private collection", async () => {
    const { owner } = await fixture();
    const preview = await previewMemberSetRelease(owner, "member_set");
    await runtime.DB.prepare(
      "UPDATE fb_card_definitions SET name='Changed' WHERE id=(SELECT card_id FROM fb_set_memberships WHERE id='member_item')",
    ).run();
    await expect(
      approveMemberSetRelease(owner, "member_set", preview.snapshot_hash),
    ).rejects.toMatchObject({ code: "member_set_changed" });
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'",
    ).run();
    await expect(previewMemberSetRelease(owner, "member_set")).rejects.toMatchObject({
      code: "member_set_unavailable",
    });
    await runtime.DB.prepare(
      "UPDATE fb_collections SET view_audience='members',scope='bot',owner_tenant_id=NULL WHERE id='col_test_public'",
    ).run();
    await expect(previewMemberSetRelease(owner, "member_set")).rejects.toMatchObject({
      code: "member_set_unavailable",
    });
  });
  it("fences owner revocation and audience changes in the write batch", async () => {
    const { owner, player } = await fixture();
    const preview = await previewMemberSetRelease(owner, "member_set");
    const revokeDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: Parameters<typeof target.batch>[0]) => {
            await target
              .prepare("UPDATE fb_sessions SET revoked_at=? WHERE id=?")
              .bind(nowIso(), owner.sessionId)
              .run();
            return target.batch(statements);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      approveMemberSetRelease({ ...owner, db: revokeDb }, "member_set", preview.snapshot_hash),
    ).rejects.toMatchObject({ code: "member_set_changed" });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_member_set_releases").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    await runtime.DB.prepare("UPDATE fb_sessions SET revoked_at=NULL WHERE id=?")
      .bind(owner.sessionId)
      .run();
    const release = await approveMemberSetRelease(owner, "member_set", preview.snapshot_hash);
    const changeDb = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: Parameters<typeof target.batch>[0]) => {
            await target
              .prepare(
                "UPDATE fb_collections SET view_audience='private' WHERE id='col_test_public'",
              )
              .run();
            return target.batch(statements);
          };
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimMemberSetCompletion({ ...player, db: changeDb }, "member_set", release.id, "race"),
    ).rejects.toMatchObject({ code: "set_completion_unavailable" });
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_set_completion_claims").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
  it("rolls back claim, wallet, ledger and audit together on a later batch failure", async () => {
    const { owner, player } = await fixture();
    const preview = await previewMemberSetRelease(owner, "member_set");
    const release = await approveMemberSetRelease(owner, "member_set", preview.snapshot_hash);
    const balance = (await runtime.DB.prepare(
      "SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?",
    )
      .bind(player.tenant.id, player.user!.id)
      .first<{ balance: number }>())!.balance;
    const broken = new Proxy(runtime.DB, {
      get(target, key) {
        if (key === "batch")
          return (statements: Parameters<typeof target.batch>[0]) =>
            target.batch([
              ...statements,
              target.prepare(
                "INSERT INTO fb_member_set_revocations(release_id,revoked_by,revoked_at) VALUES('missing','missing','')",
              ),
            ]);
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(
      claimMemberSetCompletion({ ...player, db: broken }, "member_set", release.id, "rollback"),
    ).rejects.toThrow();
    expect(
      (
        await runtime.DB.prepare("SELECT balance FROM fb_wallets WHERE tenant_id=? AND user_id=?")
          .bind(player.tenant.id, player.user!.id)
          .first<{ balance: number }>()
      )?.balance,
    ).toBe(balance);
    expect(
      (
        await runtime.DB.prepare("SELECT COUNT(*) n FROM fb_set_completion_claims").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_ledger_entries WHERE reference_type='set_completion'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await runtime.DB.prepare(
          "SELECT COUNT(*) n FROM fb_audit_events WHERE action='set.reward.claimed'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await expect(
      claimMemberSetCompletion(player, "member_set", release.id, "rollback"),
    ).resolves.toMatchObject({ amount: 12 });
  });
});
