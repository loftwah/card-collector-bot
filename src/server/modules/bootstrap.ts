import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { runtimeEnv, ApiError, type Tenant } from "../context";
import { readConfig, type RawEnv } from "../config";
import { first, nowIso } from "../db";
import { base64url, newId } from "../ids";
import {
  ensureWallet,
  seedIdentityTaxonomy,
  addMembership,
  createUser,
  issueAgentGrant,
  PLAYER_SCOPES,
  ALL_SCOPES,
} from "./identity";
import { creditWallet } from "./wallet";

export interface BootstrapAccount {
  tenant: string;
  email: string;
  password: string;
  displayName: string;
  role: "owner" | "player";
}

export interface BootstrapAgent {
  name: string;
  token: string;
  represented: string;
  scopes: string[];
}

export interface BootstrapResult {
  fresh: boolean;
  url: string;
  accounts: BootstrapAccount[];
  agents: BootstrapAgent[];
  tenants: Tenant[];
  ownerTenantId: string;
}

function randomPassword(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(18)));
}

async function ensureTenant(
  db: D1Database,
  slug: string,
  name: string,
  settings: Record<string, unknown>,
): Promise<Tenant> {
  const existing = await first<Tenant>(db, "SELECT id, slug, name FROM fb_tenants WHERE slug = ?", slug);
  if (existing) return existing;
  const id = newId("ten");
  const now = nowIso();
  await db
    .prepare(
      "INSERT INTO fb_tenants (id, slug, name, tagline, created_at, settings_json, community_policy_json, economy_json) VALUES (?, ?, ?, ?, ?, ?, '{}', '{}')",
    )
    .bind(
      id,
      slug,
      name,
      slug === "cabinet" ? "A cabinet for the characters worth keeping." : "Fixture tenant",
      now,
      JSON.stringify(settings),
    )
    .run();
  return { id, slug, name };
}

async function ensureEconomy(db: D1Database, tenantId: string, starterGrant: number, dailyReward: number) {
  await db
    .prepare(
      `INSERT INTO fb_economy_settings
        (tenant_id, currency_name, currency_symbol, starter_grant, daily_reward, daily_cooldown_seconds,
         recycle_enabled, version, updated_at, updated_by)
       VALUES (?, 'Foil', '✦', ?, ?, 72000, 1, 1, ?, 'bootstrap')
       ON CONFLICT(tenant_id) DO NOTHING`,
    )
    .bind(tenantId, starterGrant, dailyReward, nowIso())
    .run();
}

async function grantStarter(
  db: D1Database,
  tenantId: string,
  userId: string,
  amount: number,
): Promise<void> {
  const key = `starter:${tenantId}:${userId}`;
  const existing = await first<{ id: string }>(
    db,
    "SELECT id FROM fb_ledger_entries WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?",
    tenantId,
    userId,
    key,
  );
  if (existing) return;
  await creditWallet(db, {
    tenantId,
    userId,
    amount,
    kind: "issue",
    description: "Starter cabinet grant",
    idempotencyKey: key,
    referenceType: "starter_grant",
    metadata: { source: "bootstrap" },
    actorType: "system",
    actorId: "bootstrap",
  });
}

export async function bootstrapInstallation(): Promise<BootstrapResult> {
  const raw = runtimeEnv() as RawEnv & { DB: D1Database; MEDIA: R2Bucket };
  const config = readConfig(raw);
  const db = raw.DB;
  const marker = await first<{ value: string }>(
    db,
    "SELECT value FROM fb_schema_meta WHERE key = 'bootstrap_complete'",
  );
  if (marker?.value === "1") {
    throw new ApiError(
      409,
      "already_bootstrapped",
      "This local installation is already set up. Existing accounts, balances and agents were left untouched.",
    );
  }

  const cabinet = await ensureTenant(db, "cabinet", "Foilbury Cabinet", { primary: true });
  const harbour = await ensureTenant(db, "harbour", "Harbour Annex (fixture)", { fixture: true });
  const attic = await ensureTenant(db, "attic", "Attic Annex (fixture)", { fixture: true });

  await ensureEconomy(db, cabinet.id, 350, 120);
  await ensureEconomy(db, harbour.id, 200, 60);
  await ensureEconomy(db, attic.id, 200, 60);
  await seedIdentityTaxonomy(db, cabinet.id);

  const now = nowIso();
  const ownerPassword = randomPassword();
  const playerPassword = randomPassword();
  const harbourPassword = randomPassword();
  const atticPassword = randomPassword();
  const owner = await createUser(db, {
    email: "owner@foilbury.local",
    displayName: "Rowan Ash",
    password: ownerPassword,
    platformAdmin: true,
  });
  const player = await createUser(db, {
    email: "player@foilbury.local",
    displayName: "Juniper Vale",
    password: playerPassword,
  });
  const harbourOwner = await createUser(db, {
    email: "harbour.owner@foilbury.test",
    displayName: "Harbour Fixture Owner",
    password: harbourPassword,
  });
  const atticOwner = await createUser(db, {
    email: "attic.owner@foilbury.test",
    displayName: "Attic Fixture Owner",
    password: atticPassword,
  });

  await addMembership(db, cabinet.id, owner.id, "owner");
  await addMembership(db, cabinet.id, player.id, "player");
  await addMembership(db, harbour.id, harbourOwner.id, "owner");
  await addMembership(db, attic.id, atticOwner.id, "owner");
  for (const [tenantId, userId] of [
    [cabinet.id, owner.id],
    [cabinet.id, player.id],
    [harbour.id, harbourOwner.id],
    [attic.id, atticOwner.id],
  ] as const) {
    await ensureWallet(db, tenantId, userId);
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO fb_platform_admins (user_id, provisioned_by, provisioned_at, reason, status)
       VALUES (?, 'bootstrap', ?, 'Local bootstrap owner for development and automated tests.', 'active')`,
    )
    .bind(owner.id, nowIso())
    .run();
  await grantStarter(db, cabinet.id, owner.id, 350);
  await grantStarter(db, cabinet.id, player.id, 350);
  await grantStarter(db, harbour.id, harbourOwner.id, 200);
  await grantStarter(db, attic.id, atticOwner.id, 200);

  const existingSets = await first<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM fb_sets WHERE tenant_id = ?",
    cabinet.id,
  );
  if (!existingSets || existingSets.count === 0) {
    const recipeId = newId("rec");
    const recipeConfig = {
      canvas: { width: 750, height: 1050, aspect: "2.5:3.5" },
      layers: [
        { kind: "background", fit: "cover", opacity: 1 },
        { kind: "subject", fit: "contain", anchor: "bottom", mask: "arch" },
        { kind: "material", key: "{{material}}", blend: "soft-light" },
        { kind: "frame", key: "{{material}}" },
        { kind: "effect", key: "{{effect}}", blend: "screen" },
        { kind: "text", fields: ["name", "subtitle", "set", "serial"] },
      ],
      typography: { name: "Fraunces", label: "IBM Plex Mono", ink: "#141512", paper: "#F4F0E6" },
    };
    await db
      .prepare(
        "INSERT INTO fb_recipes (id, tenant_id, version, name, config_json, status, created_at, published_at) VALUES (?, ?, 1, 'Cabinet Standard', ?, 'published', ?, ?)",
      )
      .bind(recipeId, cabinet.id, JSON.stringify(recipeConfig), now, now)
      .run();
    const sets = [
      ["first-cabinet", "First Cabinet", "Six characters who opened the cabinet.", 250],
      ["fighter-night", "Fighter Night", "The Fighter roster, ready for the table.", 250],
      ["protocol-table", "Protocol Table", "Five regulars from the late table.", 250],
      ["shared-table", "The Shared Table", "One identity, several worlds.", 400],
    ] as const;
    for (const [slug, name, description, reward] of sets) {
      const setId = newId("set");
      await db
        .prepare(
          "INSERT INTO fb_sets (id, tenant_id, slug, name, description, status, version, created_at) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?)",
        )
        .bind(setId, cabinet.id, slug, name, description, now)
        .run();
      await db
        .prepare(
          "INSERT INTO fb_set_reward_rules (id, tenant_id, set_id, set_version, reward_amount, created_at) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .bind(newId("sr"), cabinet.id, setId, reward, now)
        .run();
    }
  }

  // A Bot is the tenant-facing administration unit. The local fixtures get
  // Bot rows too, so tenant-scoped tests and administration exercises are not
  // secretly relying on production backfill data.
  await db
    .prepare(
      `INSERT OR IGNORE INTO fb_bots (id, tenant_id, owner_user_id, slug, name, description, status, created_at, updated_at)
       SELECT 'bot_' || substr(hex(randomblob(8)), 1, 16), t.id, m.user_id, 'bot-' || lower(replace(t.slug, '_', '-')), t.name, t.tagline, 'active', t.created_at, ?
         FROM fb_tenants t JOIN fb_memberships m ON m.tenant_id = t.id AND m.role = 'owner'
        WHERE NOT EXISTS (SELECT 1 FROM fb_bots b WHERE b.tenant_id = t.id)`,
    )
    .bind(nowIso())
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO fb_bot_admins (id, bot_id, user_id, role, capabilities_json, status, created_at, accepted_at)
       SELECT 'badm_' || substr(hex(randomblob(8)), 1, 16), b.id, b.owner_user_id, 'owner',
              '["content","publish","economy","members","settings","inventory","grants"]', 'active', b.created_at, b.created_at
         FROM fb_bots b`,
    )
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO fb_collections
        (id, slug, name, description, scope, owner_tenant_id, logo_url, accent, status, sort, created_by, created_at, updated_at)
       SELECT 'col_' || c.id, c.slug, c.name, COALESCE(c.description, ''), 'global', c.tenant_id,
              '/art/collections/' || c.slug || '.svg',
              CASE c.slug WHEN 'bubbles' THEN 'green' WHEN 'fighter' THEN 'oxblood' WHEN 'protocol-11' THEN 'brass' ELSE 'silver' END,
              'published', c.sort,
              COALESCE((SELECT m.user_id FROM fb_memberships m WHERE m.tenant_id = c.tenant_id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1), 'system'),
              datetime('now'), datetime('now')
         FROM fb_categories c WHERE c.archived_at IS NULL`,
    )
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO fb_bot_collections (bot_id, collection_id, enabled, updated_at)
       SELECT b.id, c.id, 1, datetime('now') FROM fb_bots b CROSS JOIN fb_collections c WHERE c.scope = 'global'`,
    )
    .run();

  const ownerAgent = await issueAgentGrant(db, config, cabinet, {
    agentName: "foilbury-local-owner",
    representedUserId: owner.id,
    scopes: [...ALL_SCOPES],
    expiresInDays: 90,
    createdBy: owner.id,
  });
  const playerAgent = await issueAgentGrant(db, config, cabinet, {
    agentName: "foilbury-local-player",
    representedUserId: player.id,
    scopes: [...PLAYER_SCOPES],
    expiresInDays: 90,
    createdBy: owner.id,
  });

  await db
    .prepare("INSERT INTO fb_schema_meta (key, value) VALUES ('bootstrap_complete', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
    .run();

  return {
    fresh: true,
    url: config.publicOrigin,
    ownerTenantId: cabinet.id,
    tenants: [cabinet, harbour, attic],
    accounts: [
      { tenant: "cabinet", email: owner.email, password: ownerPassword, displayName: "Rowan Ash", role: "owner" },
      { tenant: "cabinet", email: player.email, password: playerPassword, displayName: "Juniper Vale", role: "player" },
      { tenant: "harbour", email: harbourOwner.email, password: harbourPassword, displayName: "Harbour Fixture Owner", role: "owner" },
      { tenant: "attic", email: atticOwner.email, password: atticPassword, displayName: "Attic Fixture Owner", role: "owner" },
    ],
    agents: [
      {
        name: "foilbury-local-owner",
        token: ownerAgent.token,
        represented: owner.email,
        scopes: [...ALL_SCOPES],
      },
      {
        name: "foilbury-local-player",
        token: playerAgent.token,
        represented: player.email,
        scopes: [...PLAYER_SCOPES],
      },
    ],
  };
}
