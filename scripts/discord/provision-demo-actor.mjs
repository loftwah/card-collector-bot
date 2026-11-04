#!/usr/bin/env node
/**
 * Provision a labelled, non-human demonstration collector for the persistent
 * Discord demonstration.
 *
 * This is deliberately separate from a real player: it creates one Foilbury
 * user, one active membership, a bounded ledger grant and one short-lived
 * player-scoped agent credential. All draws, claims and achievements then run
 * through the ordinary shared domain services. It never creates a Discord
 * identity, a Discord message or a fake spectator.
 *
 *   node scripts/discord/provision-demo-actor.mjs            # dry run
 *   node scripts/discord/provision-demo-actor.mjs --apply    # write once
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ROOT } from "../lib/local.mjs";

const apply = process.argv.includes("--apply");
const rotate = process.argv.includes("--rotate");
const secretsFile = path.join(ROOT, ".foilbury", "production-secrets.json");
const outputFile = path.join(ROOT, ".foilbury", "demo-actor.json");
if (!fs.existsSync(secretsFile)) throw new Error("Missing .foilbury/production-secrets.json");
const secrets = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
const pepper = secrets.FOILBURY_AGENT_TOKEN_PEPPER;
if (!pepper) throw new Error("FOILBURY_AGENT_TOKEN_PEPPER is missing from the production secrets file.");

const USER_ID = "usr_demo_discord";
const EMAIL = "demo.collector@foilbury.invalid";
const DISPLAY_NAME = "Foilbury Demo Collector";
const TENANT_SLUG = "cabinet";
const GRANT_ID = "agt_demo_discord_2026_11";
const AGENT_ID = "agent_demo_discord_2026_11";
const AGENT_NAME = "persistent-discord-demo-2026-11";
const FUNDING_KEY = "demo-actor-funding-2026-11";
const FUNDING_AMOUNT = 8000;
const SCOPES = [
  "content:read",
  "inventory:read",
  "inventory:write",
  "profile:read",
  "profile:write",
  "missions:read",
  "missions:claim",
  "draw:execute",
  "reward:claim",
];

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function d1(sql, json = true) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "foilbury",
      "--remote",
      "--config",
      "wrangler.production.jsonc",
      ...(json ? ["--json"] : []),
      "--command",
      sql,
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  if (!json) return null;
  const parsed = JSON.parse(result.stdout);
  return parsed[0]?.results ?? [];
}

const tenant = d1(`SELECT id FROM fb_tenants WHERE slug = ${quote(TENANT_SLUG)}`)[0];
if (!tenant) throw new Error("Cabinet tenant was not found.");
const tenantId = tenant.id;
const existingUser = d1(`SELECT id, email, display_name FROM fb_users WHERE id = ${quote(USER_ID)}`)[0] ?? null;
const existingGrant = d1(
  `SELECT g.id, g.status, g.expires_at, t.prefix FROM fb_agent_grants g
     LEFT JOIN fb_agent_tokens t ON t.grant_id = g.id AND t.revoked_at IS NULL
    WHERE g.id = ${quote(GRANT_ID)}`,
)[0] ?? null;
const existingFunding = d1(
  `SELECT id, amount FROM fb_ledger_entries WHERE tenant_id = ${quote(tenantId)} AND user_id = ${quote(USER_ID)} AND idempotency_key = ${quote(FUNDING_KEY)}`,
)[0] ?? null;

const now = new Date().toISOString();
const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
let token = null;
let tokenHash = null;
if (apply && (!existingGrant || rotate)) {
  token = `fba_${crypto.randomBytes(32).toString("base64url")}`;
  tokenHash = crypto.createHmac("sha256", pepper).update(token).digest("hex");
}

const statements = [];
if (!existingUser) {
  statements.push(
    `INSERT INTO fb_users (id, email, display_name, password_hash, platform_admin, created_at)
     VALUES (${quote(USER_ID)}, ${quote(EMAIL)}, ${quote(DISPLAY_NAME)}, 'discord_only$no_password', 0, ${quote(now)});`,
  );
}
statements.push(
  `INSERT OR IGNORE INTO fb_memberships (id, tenant_id, user_id, role, status, created_at)
   VALUES ('mem_demo_discord', ${quote(tenantId)}, ${quote(USER_ID)}, 'player', 'active', ${quote(now)});`,
  `INSERT OR IGNORE INTO fb_wallets (tenant_id, user_id, balance, updated_at)
   VALUES (${quote(tenantId)}, ${quote(USER_ID)}, 0, ${quote(now)});`,
);
if (!existingFunding) {
  statements.push(
    `INSERT INTO fb_ledger_entries
       (id, tenant_id, user_id, kind, amount, balance_after, reference_type, reference_id,
        description, idempotency_key, metadata_json, actor_type, actor_id, created_at)
     VALUES ('led_demo_funding_2026_11', ${quote(tenantId)}, ${quote(USER_ID)}, 'issue', ${FUNDING_AMOUNT},
             (SELECT balance FROM fb_wallets WHERE tenant_id = ${quote(tenantId)} AND user_id = ${quote(USER_ID)}) + ${FUNDING_AMOUNT},
             'demo_provisioning', 'persistent-discord-demo',
             'Bounded demonstration collector funding. Labelled non-human account; not a player purchase, reward or draw.',
             ${quote(FUNDING_KEY)},
             ${quote(JSON.stringify({ demo: true, bounded_amount: FUNDING_AMOUNT, purpose: "persistent Discord demonstration" }))},
             'system', 'provision-demo-actor', ${quote(now)});`,
    `UPDATE fb_wallets SET balance = balance + ${FUNDING_AMOUNT}, updated_at = ${quote(now)}
      WHERE tenant_id = ${quote(tenantId)} AND user_id = ${quote(USER_ID)};`,
  );
}
if (!existingGrant || rotate) {
  statements.push(
    `INSERT OR REPLACE INTO fb_agent_grants
       (id, tenant_id, agent_name, agent_id, represented_user_id, scopes_json, status, expires_at, created_by, created_at)
     VALUES (${quote(GRANT_ID)}, ${quote(tenantId)}, ${quote(AGENT_NAME)}, ${quote(AGENT_ID)}, ${quote(USER_ID)},
             ${quote(JSON.stringify(SCOPES))}, 'active', ${quote(expiresAt)}, 'provision-demo-actor', ${quote(now)});`,
  );
  if (token && tokenHash) {
    statements.push(
      `INSERT INTO fb_agent_tokens (id, grant_id, token_hash, prefix, created_at)
       VALUES ('tok_demo_discord_2026_11', ${quote(GRANT_ID)}, ${quote(tokenHash)}, ${quote(token.slice(0, 12))}, ${quote(now)})
       ON CONFLICT(token_hash) DO NOTHING;`,
    );
  }
}
statements.push(
  `INSERT INTO fb_audit_events
     (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
   VALUES ('aud_demo_actor_2026_11', ${quote(tenantId)}, 'system', 'provision-demo-actor', ${quote(USER_ID)},
           'demo.actor.provisioned', 'user', ${quote(USER_ID)},
           ${quote(JSON.stringify({ demo: true, funding_amount: existingFunding ? 0 : FUNDING_AMOUNT, scopes: SCOPES, expires_at: expiresAt }))},
           'provision-demo-actor', ${quote(now)});`,
);

const plan = {
  dry_run: !apply,
  user: { id: USER_ID, email: EMAIL, display_name: DISPLAY_NAME, existing: Boolean(existingUser) },
  tenant: tenantId,
  membership: "player (active)",
  funding: existingFunding ? { existing: true, amount: existingFunding.amount } : { amount: FUNDING_AMOUNT },
  grant: existingGrant
    ? { existing: true, id: existingGrant.id, status: existingGrant.status, expires_at: existingGrant.expires_at, rotate }
    : { id: GRANT_ID, scopes: SCOPES, expires_at: expiresAt },
  statements: statements.length,
};

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (statements.length) d1(statements.join("\n"), false);
if (token) {
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        token,
        grantId: GRANT_ID,
        prefix: token.slice(0, 12),
        expiresAt,
        scopes: SCOPES,
        userId: USER_ID,
        tenantId,
        note: "Labelled non-human demonstration collector. Do not present as a real Discord user.",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.chmodSync(outputFile, 0o600);
}
console.log(JSON.stringify({ ...plan, applied: true, token_file: token ? outputFile : null }, null, 2));
