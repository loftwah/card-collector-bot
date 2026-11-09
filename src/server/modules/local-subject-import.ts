import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { normalizeCardName } from "./card-name-aliases";

const SUBJECTS = {
  "gonta-gokuhara": { logical: "danganronpa:gonta-gokuhara", collection: "danganronpa-three-games", name: "Gonta Gokuhara", aliases: ["Gonta"] },
  "kamui-gakupo": { logical: "vocaloid:kamui-gakupo", collection: "vocaloid", name: "Kamui Gakupo", aliases: ["Camui Gackpo", "Gackpoid", "神威がくぽ"] },
} as const;

/** Local-only additive draft. It never changes or publishes an existing card. */
export async function importLocalSubjectDraft(ctx: Ctx, input: { recordJson: string; sha256: string }) {
  if (ctx.config.environment !== "local" || !ctx.config.localMode) throw new ApiError(403, "local_only", "This draft importer is available only locally.");
  if (!ctx.user || ctx.actor.type !== "user" || ctx.actor.id !== ctx.user.id || !ctx.sessionId) throw new ApiError(403, "human_session_required", "A signed-in owner session with recent strong authentication is required.");
  if (await sha256Hex(input.recordJson) !== input.sha256) throw new ApiError(422, "source_hash_mismatch", "The source record changed; reload the plan.");
  let card: { slug?: string; logical_id?: string; name?: string; description?: string };
  try { card = JSON.parse(input.recordJson); } catch { throw new ApiError(422, "invalid_source", "The source record is invalid."); }
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new ApiError(422, "invalid_source", "The source record is invalid.");
  const spec = SUBJECTS[card.slug as keyof typeof SUBJECTS];
  if (!spec || card.logical_id !== spec.logical || card.name !== spec.name || typeof card.description !== "string" || !card.description.trim() || card.description.length > 5000)
    throw new ApiError(422, "invalid_subject", "The source does not match an allowed subject.");
  const collection = await first<{ id: string }>(ctx.db, "SELECT id FROM fb_collections WHERE slug = ? AND scope = 'global' AND owner_tenant_id = ? AND archived_at IS NULL", spec.collection, ctx.tenant.id);
  if (!collection) throw new ApiError(409, "collection_unavailable", "The intended collection is not available locally.");
  const cards = await all<{ id: string; slug: string; logical_id: string; name: string }>(ctx.db, "SELECT id, slug, logical_id, name FROM fb_card_definitions WHERE tenant_id = ? ORDER BY id", ctx.tenant.id);
  const aliases = await all<{ card_id: string; alias: string; normalized: string }>(ctx.db, "SELECT card_id, alias, normalized FROM fb_card_name_aliases WHERE tenant_id = ? ORDER BY normalized", ctx.tenant.id);
  const names = new Set([spec.name, ...spec.aliases].map(normalizeCardName));
  if (cards.some((c) => c.slug === card.slug || c.logical_id === spec.logical || names.has(normalizeCardName(c.name))) || aliases.some((a) => names.has(a.normalized) || a.normalized !== normalizeCardName(a.alias)))
    throw new ApiError(409, "identity_conflict", "A matching or inconsistent card identity already exists; inspect it before importing.");
  // Compare the complete ordered identity registry at the transaction boundary.
  // This makes a concurrent name/alias change fail closed before any insert.
  const identitySql = `SELECT COALESCE(json_group_array(json_array(id,slug,logical_id,name)),'[]') AS snapshot FROM (SELECT id,slug,logical_id,name FROM fb_card_definitions WHERE tenant_id = ? ORDER BY id)`;
  const aliasSql = `SELECT COALESCE(json_group_array(json_array(card_id,alias,normalized)),'[]') AS snapshot FROM (SELECT card_id,alias,normalized FROM fb_card_name_aliases WHERE tenant_id = ? ORDER BY normalized)`;
  const identitySnapshot = JSON.stringify(cards.map((c) => [c.id, c.slug, c.logical_id, c.name]));
  const aliasSnapshot = JSON.stringify(aliases.map((a) => [a.card_id, a.alias, a.normalized]));
  const id = newId("crd"), now = nowIso();
  const condition = `(${identitySql}) = ? AND (${aliasSql}) = ? AND EXISTS (
    SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id JOIN fb_bots b ON b.tenant_id = m.tenant_id
    JOIN fb_sessions s ON s.id = ? AND s.user_id = m.user_id AND s.tenant_id = m.tenant_id
    WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND m.role = 'owner'
      AND u.disabled_at IS NULL AND b.owner_user_id = u.id AND b.status = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND s.assurance IN ('passkey','mfa') AND s.auth_time >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')
      AND s.auth_time <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ) AND EXISTS (SELECT 1 FROM fb_collections WHERE id = ? AND slug = ? AND scope = 'global' AND owner_tenant_id = ? AND archived_at IS NULL)`;
  const safeInsert = ctx.db.prepare(`INSERT INTO fb_card_definitions (id,tenant_id,logical_id,slug,name,description,status,review_status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,'draft','draft',?,? WHERE ${condition}`).bind(id, ctx.tenant.id, spec.logical, card.slug, spec.name, card.description.trim(), now, now,
      ctx.tenant.id, identitySnapshot, ctx.tenant.id, aliasSnapshot, ctx.sessionId, ctx.tenant.id, ctx.user.id, collection.id, spec.collection, ctx.tenant.id);
  const link = ctx.db.prepare("INSERT INTO fb_collection_cards (collection_id,card_id,tenant_id,sort,added_by,added_at) SELECT ?,?,?,0,?,? WHERE changes() = 1").bind(collection.id, id, ctx.tenant.id, ctx.user.id, now);
  const aliasInserts = spec.aliases.map((alias) => ctx.db.prepare("INSERT INTO fb_card_name_aliases (tenant_id,card_id,alias,normalized,created_at) SELECT ?,?,?,?,? WHERE changes() = 1").bind(ctx.tenant.id, id, alias, normalizeCardName(alias), now));
  const audit = ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,?,?,?,'local_subject.draft_created','card',?,?,?,? WHERE changes() = 1`)
    .bind(newId("aud"), ctx.tenant.id, ctx.actor.type, ctx.actor.id, ctx.actor.representedUserId, id, JSON.stringify({ source_record_sha256: input.sha256, logical_id: spec.logical }), ctx.requestId, now);
  const [, inserted] = await ctx.db.batch([safeInsert,ctx.db.prepare('SELECT changes() AS applied'), link, ...aliasInserts, audit]);
  if (Number((inserted?.results?.[0] as {applied?:number} | undefined)?.applied) !== 1) throw new ApiError(409, "import_conflict", "The identity registry, collection or owner session changed. Reload and review before retrying.");
  return { id, slug: card.slug, status: "draft", source_record_sha256: input.sha256 };
}
