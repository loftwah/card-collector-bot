import { env, applyD1Migrations } from "cloudflare:test";
import { bootstrapInstallation } from "../../src/server/modules/bootstrap";
import { readConfig, type RawEnv } from "../../src/server/config";
import type { Ctx, Tenant } from "../../src/server/context";
import { first, nowIso } from "../../src/server/db";
import { newId, sha256Hex } from "../../src/server/ids";

export const runtime = env as unknown as RawEnv & { DB: D1Database; MEDIA: R2Bucket };

async function resetDatabase() {
  const migration = (runtime as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS;
  const tables = (await runtime.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fb_%'").all<{ name: string }>()).results ?? [];
  const names = tables.map((row) => row.name);
  const parents = new Map<string, Set<string>>();
  for (const name of names) parents.set(name, new Set());
  for (const name of names) {
    const fks = (await runtime.DB.prepare(`PRAGMA foreign_key_list("${name}")`).all<{ table: string }>()).results ?? [];
    for (const fk of fks) {
      if (fk.table !== name && parents.has(fk.table)) parents.get(fk.table)!.add(name);
    }
  }
  const remaining = new Set(names);
  while (remaining.size) {
    const leaf = [...remaining].find((name) => {
      const children = parents.get(name) ?? new Set();
      return [...children].every((child) => !remaining.has(child));
    });
    if (!leaf) throw new Error("Could not find a foreign-key-safe table drop order");
    await runtime.DB.exec(`DROP TABLE IF EXISTS "${leaf}";`);
    remaining.delete(leaf);
  }
  await runtime.DB.prepare("DELETE FROM d1_migrations").run().catch(() => undefined);
  if (migration?.length) await applyD1Migrations(runtime.DB, migration);
}

export async function bootstrap() {
  await resetDatabase();
  return bootstrapInstallation();
}

export async function tenant(slug: string): Promise<Tenant> {
  const row = await first<Tenant>(runtime.DB, "SELECT id, slug, name FROM fb_tenants WHERE slug = ?", slug);
  if (!row) throw new Error(`Tenant ${slug} not found`);
  return row;
}

export async function ctxFor(slug: string, email: string): Promise<Ctx> {
  const tenantRow = await tenant(slug);
  const row = await first<{
    id: string;
    email: string;
    display_name: string;
    platform_admin: number;
    email_verified_at: string | null;
    capabilities_json: string | null;
    self_grants_enabled: number;
    grant_limit: number;
    capability_revision: number;
    role: "owner" | "editor" | "economy_admin" | "player";
  }>(
    runtime.DB,
    `SELECT u.id, u.email, u.display_name, u.platform_admin, u.email_verified_at, m.capabilities_json, m.role,
            m.self_grants_enabled, m.grant_limit, m.capability_revision
       FROM fb_users u JOIN fb_memberships m ON m.user_id = u.id
      WHERE u.email = ? AND m.tenant_id = ?`,
    email,
    tenantRow.id,
  );
  if (!row) throw new Error(`User ${email} not found in ${slug}`);
  return {
    db: runtime.DB,
    media: runtime.MEDIA,
    config: readConfig(runtime),
    requestId: newId("test"),
    clientKey: "test-client",
    tenant: tenantRow,
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      platformAdmin: Boolean(row.platform_admin),
      emailVerified: Boolean(row.email_verified_at),
      capabilities: row.capabilities_json ? (JSON.parse(row.capabilities_json) as string[]) : [],
      selfGrantsEnabled: Boolean(row.self_grants_enabled),
      grantLimit: Number(row.grant_limit ?? 0),
      capabilityRevision: Number(row.capability_revision ?? 1),
    },
    actor: { type: "user", id: row.id, representedUserId: row.id, label: row.display_name },
    scopes: null,
    sessionId: null,
    csrfToken: "test",
    sessionAssurance: null,
    sessionAuthTime: null,
    accessIdentity: null,
    accessStatus: null,
  };
}

export async function setBalance(ctx: Ctx, userId: string, balance: number) {
  await runtime.DB.prepare("UPDATE fb_wallets SET balance = ?, updated_at = ? WHERE tenant_id = ? AND user_id = ?")
    .bind(balance, nowIso(), ctx.tenant.id, userId)
    .run();
}

export async function walletBalance(ctx: Ctx, userId: string): Promise<number> {
  const row = await first<{ balance: number }>(runtime.DB, "SELECT balance FROM fb_wallets WHERE tenant_id = ? AND user_id = ?", ctx.tenant.id, userId);
  return row?.balance ?? 0;
}

export async function fixturePool(ctx: Ctx) {
  const material = await first<{ id: string }>(runtime.DB, "SELECT id FROM fb_materials WHERE tenant_id = ? AND key = 'plain'", ctx.tenant.id);
  const effect = await first<{ id: string }>(runtime.DB, "SELECT id FROM fb_effects WHERE tenant_id = ? AND key = 'none'", ctx.tenant.id);
  const recipe = await first<{ id: string }>(runtime.DB, "SELECT id FROM fb_recipes WHERE tenant_id = ? ORDER BY version DESC LIMIT 1", ctx.tenant.id);
  if (!material || !effect || !recipe) throw new Error("Bootstrap taxonomy/recipe missing");
  const subjectAsset = "ast_test_subject";
  const renderAsset = "ast_test_render";
  const cardId = "crd_test_card";
  const editionId = "edt_test_edition";
  const variantId = "var_test_variant";
  const poolId = "pool_test_open";
  const now = nowIso();
  await runtime.DB.batch([
    runtime.DB.prepare(
      "INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility, created_at) VALUES (?, ?, 'subject', 'Test subject', 'image/png', 500, 700, 100, 'test/subject.png', ?, 'private', ?)",
    ).bind(subjectAsset, ctx.tenant.id, await sha256Hex("subject"), now),
    runtime.DB.prepare(
      "INSERT INTO fb_assets (id, tenant_id, kind, name, mime, width, height, bytes, r2_key, sha256, visibility, access_classification, processing_state, review_status, created_at) VALUES (?, ?, 'render', 'Test render', 'image/webp', 750, 1050, 100, 'test/render.webp', ?, 'public_export', 'public', 'ready', 'approved', ?)",
    ).bind(renderAsset, ctx.tenant.id, await sha256Hex("render"), now),
    runtime.DB.prepare(
      "INSERT INTO fb_collections (id, slug, name, description, scope, owner_tenant_id, accent, status, view_audience, public_approved_at, public_approved_by, banner_url, logo_url, created_by, created_at, updated_at) VALUES ('col_test_public', 'test-public', 'Test Public', 'Public fixture collection.', 'global', ?, 'brass', 'published', 'public', ?, 'owner@foilbury.local', '/art/collections/protocol-11-key-art.webp', '/art/collections/protocol-11.svg', 'test', ?, ?)",
    ).bind(ctx.tenant.id, now, now, now),
    runtime.DB.prepare(
      "INSERT INTO fb_card_definitions (id, tenant_id, logical_id, slug, name, subtitle, description, status, created_at, updated_at, version) VALUES (?, ?, 'test:one', 'test-one', 'Test One', 'Test subject', 'A card used by the worker integration tests.', 'published', ?, ?, 1)",
    ).bind(cardId, ctx.tenant.id, now, now),
    runtime.DB.prepare(
      "INSERT INTO fb_collection_cards (collection_id, card_id, tenant_id, sort, added_by, added_at) VALUES ('col_test_public', ?, ?, 0, 'test', ?)",
    ).bind(cardId, ctx.tenant.id, now),
    runtime.DB.prepare(
      "INSERT OR IGNORE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at) SELECT b.id, 'col_test_public', 1, ? FROM fb_bots b WHERE b.tenant_id = ?",
    ).bind(now, ctx.tenant.id),
    runtime.DB.prepare(
      "INSERT INTO fb_artwork_editions (id, tenant_id, card_id, name, subject_asset_id, recipe_id, status, source_repo, source_path, source_commit, source_hash, created_at) VALUES (?, ?, ?, 'Test edition', ?, ?, 'published', 'test/repo', 'test/subject.png', 'test-commit', 'test-hash', ?)",
    ).bind(editionId, ctx.tenant.id, cardId, subjectAsset, recipe.id, now),
    runtime.DB.prepare(
      "INSERT INTO fb_variants (id, tenant_id, card_id, edition_id, material_id, effect_id, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Plain', 'published', ?)",
    ).bind(variantId, ctx.tenant.id, cardId, editionId, material.id, effect.id, now),
    runtime.DB.prepare(
      "INSERT INTO fb_variant_renders (id, tenant_id, variant_id, recipe_id, asset_id, public_url, width, height, sha256, status, created_at, published_at) VALUES ('vr_test', ?, ?, ?, ?, '/media/public/test', 750, 1050, 'test-render-hash', 'published', ?, ?)",
    ).bind(ctx.tenant.id, variantId, recipe.id, renderAsset, now, now),
    runtime.DB.prepare(
      "INSERT INTO fb_pools (id, tenant_id, slug, name, description, status, revision, price, created_at, updated_at, published_at) VALUES (?, ?, 'test-pool', 'Test pool', 'Pool used by integration tests.', 'active', 1, 80, ?, ?, ?)",
    ).bind(poolId, ctx.tenant.id, now, now, now),
    runtime.DB.prepare(
      "INSERT INTO fb_pool_entries (id, tenant_id, pool_id, pool_revision, variant_id, weight, enabled, created_at) VALUES ('poe_test', ?, ?, 1, ?, 100, 1, ?)",
    ).bind(ctx.tenant.id, poolId, variantId, now),
  ]);
  return { cardId, editionId, variantId, poolId, subjectAsset, renderAsset, recipeId: recipe.id };
}

export async function makeInstance(ctx: Ctx, userId: string, fixture: { cardId: string; variantId: string }, serial = `TEST-${Math.random().toString(36).slice(2, 10)}`) {
  const id = newId("ins");
  const now = nowIso();
  await runtime.DB.prepare(
    "INSERT INTO fb_card_instances (id, tenant_id, user_id, card_id, variant_id, serial, acquired_via, acquired_at, status, favourite, locked, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'test', ?, 'owned', 0, 0, ?)",
  ).bind(id, ctx.tenant.id, userId, fixture.cardId, fixture.variantId, serial, now, now).run();
  return id;
}
