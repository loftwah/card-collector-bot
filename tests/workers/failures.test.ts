import { describe, expect, it } from "vitest";
import { archiveCard } from "../../src/server/modules/catalogue";
import { getAsset, readAsset, uploadAsset } from "../../src/server/modules/assets";
import { failRenderJob } from "../../src/server/modules/imports";
import { bootstrap, ctxFor, fixturePool, makeInstance, runtime } from "./helpers";

describe("recoverable failures", () => {
  it("rejects malformed image bytes before creating an asset", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const before = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_assets WHERE tenant_id = ?").bind(owner.tenant.id).first<{ count: number }>();
    await expect(uploadAsset(owner, { kind: "subject", name: "Not an image", bytes: new Uint8Array([1, 2, 3, 4]) })).rejects.toMatchObject({ code: "asset_type_invalid" });
    const after = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM fb_assets WHERE tenant_id = ?").bind(owner.tenant.id).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("reports a missing stored object instead of pretending the asset exists", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility, created_at) VALUES ('ast_missing', ?, 'subject', 'Missing object', 'image/png', 10, 10, 4, 'missing/not-here.png', 'missing-hash', 'private', ?)")
      .bind(owner.tenant.id, now)
      .run();
    const asset = await getAsset(owner, "ast_missing");
    await expect(readAsset(owner.media, asset)).rejects.toMatchObject({ code: "asset_missing" });
  });

  it("retries a failed render job and then records a terminal failure", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const now = new Date().toISOString();
    await runtime.DB.prepare("INSERT INTO fb_jobs (id, tenant_id, kind, status, payload_json, attempts, max_attempts, available_at, created_at, updated_at) VALUES ('job_failure_test', ?, 'render_card', 'running', '{}', 0, 3, ?, ?, ?)")
      .bind(owner.tenant.id, now, now, now)
      .run();
    const retry = await failRenderJob(owner, "job_failure_test", "temporary render failure");
    expect(retry.retry).toBe(true);
    const pending = await runtime.DB.prepare("SELECT status FROM fb_jobs WHERE id = 'job_failure_test'").first<{ status: string }>();
    expect(pending?.status).toBe("pending");
    await runtime.DB.prepare("UPDATE fb_jobs SET status = 'running', attempts = 3 WHERE id = 'job_failure_test'").run();
    const terminal = await failRenderJob(owner, "job_failure_test", "terminal render failure");
    expect(terminal.retry).toBe(false);
    const failed = await runtime.DB.prepare("SELECT status, last_error FROM fb_jobs WHERE id = 'job_failure_test'").first<{ status: string; last_error: string }>();
    expect(failed?.status).toBe("failed");
    expect(failed?.last_error).toContain("terminal");
  });

  it("archives a collectible with owned instances instead of deleting history", async () => {
    await bootstrap();
    const owner = await ctxFor("cabinet", "owner@foilbury.local");
    const fixture = await fixturePool(owner);
    const instance = await makeInstance(owner, owner.user!.id, fixture, "ARCHIVE-KEEP-1");
    await archiveCard(owner, fixture.cardId);
    const card = await runtime.DB.prepare("SELECT status, archived_at FROM fb_card_definitions WHERE id = ?").bind(fixture.cardId).first<{ status: string; archived_at: string | null }>();
    expect(card?.status).toBe("retired");
    expect(card?.archived_at).toBeTruthy();
    const stillOwned = await runtime.DB.prepare("SELECT status FROM fb_card_instances WHERE id = ?").bind(instance).first<{ status: string }>();
    expect(stillOwned?.status).toBe("owned");
  });
});
