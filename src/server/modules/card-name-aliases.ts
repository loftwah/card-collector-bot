import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";

export function normalizeCardName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

// Explicit Bot grants take precedence over the legacy membership role. Check
// the current row and session, not capabilities cached when a session began.
const authority = `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
  JOIN fb_bots b ON b.tenant_id = m.tenant_id AND b.status <> 'archived'
  LEFT JOIN fb_bot_admins ba ON ba.bot_id = b.id AND ba.user_id = m.user_id
  WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
  AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = m.user_id AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > ?))
  AND ((m.role = 'owner' AND b.owner_user_id = m.user_id)
    OR (u.platform_admin = 1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.revoked_at IS NULL))
    OR (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'content')
      AND (ba.id IS NULL OR (ba.status = 'active' AND ba.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value = 'content'))))))`;
function authArgs(ctx: Ctx) { return [ctx.tenant.id, ctx.user?.id ?? "", ctx.sessionId, ctx.sessionId, nowIso()]; }
async function requireAuthority(ctx: Ctx, scope: "content:read" | "content:write") {
  if (!ctx.user || (ctx.actor.type === "agent" && !ctx.scopes?.includes(scope)))
    throw new ApiError(403, "insufficient_scope", "Current Bot content authority is required.");
  const row = await first<{ allowed: number }>(ctx.db, `SELECT ${authority} AS allowed`, ...authArgs(ctx));
  if (!row?.allowed) throw new ApiError(403, "insufficient_role", "Your Bot content access has changed.");
}

export async function listCardNameAliases(ctx: Ctx, cardId: string) {
  await requireAuthority(ctx, "content:read");
  const card = await first<{ version: number }>(ctx.db, "SELECT version FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND archived_at IS NULL", cardId, ctx.tenant.id);
  if (!card) throw new ApiError(404, "card_not_found", "That card is not available in this Bot.");
  const rows = await all<{ alias: string }>(ctx.db, "SELECT alias FROM fb_card_name_aliases WHERE tenant_id = ? AND card_id = ? ORDER BY normalized", ctx.tenant.id, cardId);
  await requireAuthority(ctx, "content:read");
  return { aliases: rows.map(row => row.alias), version: card.version };
}

export async function replaceCardNameAliases(ctx: Ctx, cardId: string, expectedVersion: number, values: string[]) {
  await requireAuthority(ctx, "content:write");
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || values.length > 20)
    throw new ApiError(422, "alias_invalid", "Provide a card version and at most 20 names.");
  const aliases = values.map(value => ({ alias: value.normalize("NFKC").trim().replace(/\s+/gu, " "), normalized: normalizeCardName(value) }));
  if (aliases.some(value => !value.normalized || value.alias.length > 160) || new Set(aliases.map(value => value.normalized)).size !== aliases.length)
    throw new ApiError(422, "alias_invalid", "Names must be nonempty, unique after normalization, and at most 160 characters.");
  const card = await first<{ id: string; name: string; version: number }>(ctx.db, "SELECT id, name, version FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND archived_at IS NULL", cardId, ctx.tenant.id);
  if (!card) throw new ApiError(404, "card_not_found", "That card is not available in this Bot.");
  if (card.version !== expectedVersion) throw new ApiError(409, "stale_card", "The card changed. Reload before saving names.");
  const names = await all<{ id: string; name: string }>(ctx.db, "SELECT id, name FROM fb_card_definitions WHERE tenant_id = ? AND archived_at IS NULL", ctx.tenant.id);
  if (aliases.some(alias => names.some(other => other.id !== cardId && normalizeCardName(other.name) === alias.normalized)))
    throw new ApiError(409, "alias_conflict", "A name belongs to another card in this Bot.");
  const where = `EXISTS (SELECT 1 FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND archived_at IS NULL AND version = ?) AND ${authority}`;
  const guardArgs = () => [cardId, ctx.tenant.id, expectedVersion, ...authArgs(ctx)];
  const statements = [ctx.db.prepare(`DELETE FROM fb_card_name_aliases WHERE tenant_id = ? AND card_id = ? AND ${where}`).bind(ctx.tenant.id, cardId, ...guardArgs())];
  for (const alias of aliases) statements.push(ctx.db.prepare(`INSERT INTO fb_card_name_aliases (tenant_id, card_id, alias, normalized, created_at)
    SELECT ?, ?, ?, ?, ? WHERE ${where}`).bind(ctx.tenant.id, cardId, alias.alias, alias.normalized, nowIso(), ...guardArgs()));
  statements.push(ctx.db.prepare(`UPDATE fb_card_definitions SET version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ? AND version = ? AND ${authority}`)
    .bind(nowIso(), cardId, ctx.tenant.id, expectedVersion, ...authArgs(ctx)));
  statements.push(ctx.db.prepare(`INSERT INTO fb_audit_events (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
    SELECT ?, ?, ?, ?, ?, 'card.aliases.updated', 'card', ?, ?, ?, ? WHERE changes() = 1`)
    .bind(newId("aud"), ctx.tenant.id, ctx.actor.type, ctx.actor.id, ctx.actor.representedUserId, cardId, JSON.stringify({ aliases: aliases.map(value => value.alias) }), ctx.requestId, nowIso()));
  try {
    const results = await ctx.db.batch(statements);
    // D1 reports changes made by triggers as well as the updated card row.
    if (Number(results[results.length - 2]?.meta?.changes ?? 0) < 1) {
      await requireAuthority(ctx, "content:write");
      throw new ApiError(409, "stale_card", "The card changed. Reload before saving names.");
    }
  } catch (error) {
    if (String(error).includes("UNIQUE constraint")) throw new ApiError(409, "alias_conflict", "A name already belongs to another card in this Bot.");
    throw error;
  }
  return { aliases: aliases.map(value => value.alias), version: expectedVersion + 1 };
}
