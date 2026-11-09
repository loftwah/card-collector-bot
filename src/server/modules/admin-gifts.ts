import { ApiError, requireRecentStrongAuth, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId, sha256Hex } from "../ids";
import { auditStatement, idempotencyStatement, type IdempotencyInput } from "../http";
import { botForTenant } from "./bots";
import { creditWallet } from "./wallet";
import { assertTransition } from "../state";

export type GiftKind = "foil" | "card" | "opening";
export type GiftScope = "single" | "recipients" | "bot_members" | "platform_members";

export interface GiftInput {
  kind: GiftKind;
  scope: GiftScope;
  userIds?: string[];
  botId?: string | null;
  amount?: number;
  openings?: number;
  expectedOpeningPrice?: number;
  expectedPoolRevision?: number;
  expectedRecipientsDigest?: string;
  cardId?: string | null;
  /** Optional exact published variant for a card gift. */
  variantId?: string | null;
  message?: string | null;
  reason: string;
  idempotency: IdempotencyInput;
}

interface Recipient {
  user_id: string;
  email: string;
  display_name: string;
  tenant_id: string;
  tenant_name: string;
}

const MAX_RECIPIENTS = 500;
const MAX_MESSAGE = 280;

// Bind the human's actual current Bot authority and recent persisted proof to
// the read/write statement. Explicit revoked grants never fall back to role.
const liveGiftAuthority = `EXISTS (SELECT 1 FROM fb_users u
 JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL
 JOIN fb_sessions s ON s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL
  AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND s.assurance IN ('mfa','passkey')
  AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
 LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=u.id
 WHERE u.id=? AND u.disabled_at IS NULL AND ((?=1 AND u.platform_admin=1 AND EXISTS
  (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))
 OR (?=0 AND ((m.role='owner' AND b.owner_user_id=u.id) OR (m.role IN ('editor','economy_admin')
  AND json_type(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE 'null' END)='array'
  AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE type<>'text')
  AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) mc WHERE mc.value='grants'
   AND (ba.id IS NULL OR (ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL AND EXISTS
    (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) ac WHERE ac.value=mc.value)
    AND json_type(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE 'null' END)='array'
    AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE type<>'text')))
  ))))))`;

function giftAuthorityArgs(ctx: Ctx) {
  const platform = ctx.user?.platformAdmin ? 1 : 0;
  return [ctx.tenant.id, ctx.sessionId, ctx.user?.id ?? '', platform, platform];
}

function giftGuard(ctx: Ctx, recipient?: {tenant_id:string;user_id:string}, campaignId?: string, amount?: number) {
  const recipientSql = recipient ? ` AND EXISTS (SELECT 1 FROM fb_memberships rm JOIN fb_users ru ON ru.id=rm.user_id
    WHERE rm.tenant_id=? AND rm.user_id=? AND rm.status='active' AND rm.revoked_at IS NULL AND ru.disabled_at IS NULL AND ru.is_synthetic=0)` : '';
  const campaignSql = campaignId ? " AND EXISTS (SELECT 1 FROM fb_gift_campaigns WHERE id=? AND tenant_id=? AND status='sending')" : '';
  const limitSql = amount !== undefined ? ` AND EXISTS (SELECT 1 FROM fb_memberships gm JOIN fb_bots gb ON gb.tenant_id=gm.tenant_id
    WHERE gm.tenant_id=? AND gm.user_id=? AND (?=1 OR (gm.role='owner' AND gb.owner_user_id=gm.user_id)
      OR (? > 0 AND ? <= gm.grant_limit AND (?<>gm.user_id OR gm.self_grants_enabled=1))))` : '';
  return ctx.db.prepare(`SELECT CASE WHEN ${liveGiftAuthority}${recipientSql}${campaignSql}${limitSql} THEN 1 ELSE json('gift_authority_or_recipient_changed') END`)
    .bind(...giftAuthorityArgs(ctx), ...(recipient ? [recipient.tenant_id,recipient.user_id] : []), ...(campaignId ? [campaignId,ctx.tenant.id] : []),
      ...(amount !== undefined ? [ctx.tenant.id,ctx.user!.id,ctx.user!.platformAdmin?1:0,amount,amount,recipient?.user_id ?? ''] : []));
}

function giftLimitGuard(ctx: Ctx, recipients: Recipient[], amount: number) {
  return ctx.db.prepare(`SELECT CASE WHEN ${liveGiftAuthority} AND EXISTS (SELECT 1 FROM fb_memberships gm JOIN fb_bots gb ON gb.tenant_id=gm.tenant_id
    WHERE gm.tenant_id=? AND gm.user_id=? AND (?=1 OR (gm.role='owner' AND gb.owner_user_id=gm.user_id)
      OR (? > 0 AND ? <= gm.grant_limit AND (gm.self_grants_enabled=1 OR NOT EXISTS (SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.user_id')=gm.user_id)))))
    THEN 1 ELSE json('gift_grant_policy_changed') END`).bind(...giftAuthorityArgs(ctx),ctx.tenant.id,ctx.user!.id,ctx.user!.platformAdmin?1:0,amount,amount,JSON.stringify(giftRoster(recipients)));
}

function giftRoster(recipients: Recipient[]) {
  return recipients.map(({tenant_id,user_id})=>({tenant_id,user_id})).sort((a,b)=>a.tenant_id.localeCompare(b.tenant_id)||a.user_id.localeCompare(b.user_id));
}
async function giftRecipientsDigest(recipients: Recipient[]) {
  return sha256Hex(JSON.stringify(giftRoster(recipients)));
}
function massRosterGuard(ctx: Ctx, scope: GiftScope, recipients: Recipient[]) {
  const roster = JSON.stringify(giftRoster(recipients));
  return ctx.db.prepare(`SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
    WHERE m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND u.is_synthetic=0
      AND (?='platform_members' OR m.tenant_id=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.tenant_id')=m.tenant_id AND json_extract(r.value,'$.user_id')=m.user_id)
  ) AND NOT EXISTS (SELECT 1 FROM json_each(?) r WHERE NOT EXISTS (
    SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
    WHERE m.tenant_id=json_extract(r.value,'$.tenant_id') AND m.user_id=json_extract(r.value,'$.user_id')
      AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND u.is_synthetic=0
  )) THEN 1 ELSE json('gift_roster_changed') END`).bind(scope,ctx.tenant.id,roster,roster);
}

// Derive every displayed counter and status from durable awards in the same
// transaction as a receipt/failure, including when processors overlap.
function giftSummary(ctx: Ctx, campaignId: string) {
  return ctx.db.prepare(`UPDATE fb_gift_campaigns SET
    sent_count=(SELECT COUNT(*) FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status='delivered'),
    failed_count=(SELECT COUNT(*) FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status='failed'),
    status=CASE WHEN EXISTS (SELECT 1 FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status='pending') THEN 'sending'
      WHEN NOT EXISTS (SELECT 1 FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status<>'delivered') THEN 'completed'
      WHEN EXISTS (SELECT 1 FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status='delivered') THEN 'partial' ELSE 'failed' END,
    updated_at=?,completed_at=CASE WHEN EXISTS (SELECT 1 FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status='pending') THEN NULL ELSE ? END
    WHERE id=? AND tenant_id=? AND status IN ('sending','partial','failed','completed')`)
    .bind(nowIso(),nowIso(),campaignId,ctx.tenant.id);
}

// Every association must be currently visible to this recipient and enabled
// for their Bot. Cross-Bot variants are held until card identity has a
// supported cross-tenant binding.
function publicCardGiftGuard(ctx: Ctx, award: {tenant_id:string;user_id:string}, cardId: string, variant: {id:string;edition_id:string;render_id:string;asset_id:string;render_sha:string;asset_sha:string;r2_key:string;asset_revision:number}) {
  return ctx.db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM fb_card_definitions cd
    JOIN fb_variants v ON v.id=? AND v.edition_id=? AND v.card_id=cd.id AND v.tenant_id=cd.tenant_id AND v.status='published' AND v.archived_at IS NULL
    JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.card_id=cd.id AND e.tenant_id=cd.tenant_id AND e.status='published' AND e.archived_at IS NULL
    JOIN fb_bots b ON b.tenant_id=? AND b.status='active'
    WHERE cd.id=? AND cd.tenant_id=? AND cd.tenant_id=b.tenant_id AND cd.status='published' AND cd.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM fb_variant_renders vr JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id
        WHERE vr.id=? AND vr.asset_id=? AND vr.sha256=? AND vr.variant_id=v.id AND vr.tenant_id=v.tenant_id AND vr.status='published'
          AND a.sha256=? AND a.r2_key=? AND a.revision=? AND a.archived_at IS NULL AND a.processing_state='ready' AND a.review_status NOT IN ('rejected','placeholder'))
      AND EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=cd.id)
      AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
        LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id
        WHERE cc.card_id=cd.id AND (c.id IS NULL OR c.status<>'published' OR c.archived_at IS NOT NULL OR COALESCE(bc.enabled,0)<>1
          OR (c.scope='bot' AND c.owner_tenant_id IS NOT b.tenant_id)
          OR NOT ((c.scope='global' AND c.view_audience='public' AND c.public_approved_at IS NOT NULL)
            OR (c.view_audience='members' AND (c.scope='global' OR (c.scope='bot' AND c.owner_tenant_id=b.tenant_id)))
            OR (c.view_audience='private' AND EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=c.id AND cv.user_id=? AND cv.revoked_at IS NULL)))))
  ) THEN 1 ELSE json('gift_card_visibility_changed') END`).bind(variant.id,variant.edition_id,award.tenant_id,cardId,ctx.tenant.id,variant.render_id,variant.asset_id,variant.render_sha,variant.asset_sha,variant.r2_key,variant.asset_revision,award.user_id);
}

async function requireLiveGiftAuthority(ctx: Ctx) {
  if (!ctx.user || ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user.id || ctx.actor.representedUserId !== ctx.user.id ||
    !(await first<{ok:number}>(ctx.db, `SELECT ${liveGiftAuthority} AS ok`, ...giftAuthorityArgs(ctx)))?.ok)
    throw new ApiError(403, 'gift_authority_changed', 'Your gift authority or recent sign-in changed. Sign in again and reload.');
}

/** Minimal same-Bot recipient choices for an authorised gift sender. */
export async function listGiftRecipients(ctx: Ctx) {
  assertGiftAuthority(ctx, {kind:'foil',scope:'single',reason:'Gift recipients',idempotency:{key:'recipients',digest:'recipients'}});
  await requireLiveGiftAuthority(ctx);
  const rows=await all<{id:string;display_name:string}>(ctx.db, `SELECT u.id,u.display_name
    FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
    WHERE m.tenant_id=? AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND u.is_synthetic=0 AND ${liveGiftAuthority}
    ORDER BY u.display_name,u.id LIMIT ?`,ctx.tenant.id,...giftAuthorityArgs(ctx),MAX_RECIPIENTS+1);
  if(rows.length>MAX_RECIPIENTS) throw new ApiError(503,'gift_recipient_list_overloaded','Too many members to list safely. Ask an administrator for help.');
  return rows;
}

/** A conservative public-only card selector; delivery separately rechecks each recipient. */
export async function listGiftCards(ctx: Ctx) {
  assertGiftAuthority(ctx, {kind:'foil',scope:'single',reason:'Gift cards',idempotency:{key:'cards',digest:'cards'}});
  await requireLiveGiftAuthority(ctx);
  const rows=await all<{id:string;name:string;variant_id:string}>(ctx.db, `WITH choices AS (SELECT cd.id,cd.name,
    (SELECT v.id FROM fb_variants v JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.card_id=cd.id AND e.tenant_id=cd.tenant_id AND e.status='published' AND e.archived_at IS NULL
      JOIN fb_variant_renders vr ON vr.variant_id=v.id AND vr.tenant_id=v.tenant_id AND vr.status='published'
      JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id AND a.archived_at IS NULL AND a.processing_state='ready' AND a.review_status='approved' AND a.access_classification='public' AND a.visibility='public_export'
      WHERE v.card_id=cd.id AND v.tenant_id=cd.tenant_id AND v.status='published' AND v.archived_at IS NULL
      ORDER BY v.id LIMIT 1) AS variant_id
    FROM fb_card_definitions cd JOIN fb_bots b ON b.tenant_id=cd.tenant_id AND b.status='active'
    WHERE cd.tenant_id=? AND cd.status='published' AND cd.archived_at IS NULL AND ${liveGiftAuthority}
      AND EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=cd.id)
      AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections c ON c.id=cc.collection_id
        LEFT JOIN fb_bot_collections bc ON bc.collection_id=c.id AND bc.bot_id=b.id WHERE cc.card_id=cd.id
        AND (c.id IS NULL OR c.scope<>'global' OR c.status<>'published' OR c.archived_at IS NOT NULL OR c.view_audience<>'public' OR c.public_approved_at IS NULL OR COALESCE(bc.enabled,0)<>1))
      AND EXISTS (SELECT 1 FROM fb_variants v JOIN fb_artwork_editions e ON e.id=v.edition_id AND e.card_id=cd.id AND e.tenant_id=cd.tenant_id AND e.status='published' AND e.archived_at IS NULL
        JOIN fb_variant_renders vr ON vr.variant_id=v.id AND vr.tenant_id=v.tenant_id AND vr.status='published'
        JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id AND a.archived_at IS NULL AND a.processing_state='ready' AND a.review_status='approved' AND a.access_classification='public' AND a.visibility='public_export'
        WHERE v.card_id=cd.id AND v.tenant_id=cd.tenant_id AND v.status='published' AND v.archived_at IS NULL)
    ORDER BY cd.name,cd.id LIMIT ?) SELECT choices.* FROM choices ORDER BY choices.name,choices.id`,ctx.tenant.id,...giftAuthorityArgs(ctx),MAX_RECIPIENTS+1);
  if(rows.length>MAX_RECIPIENTS) throw new ApiError(503,'gift_card_list_overloaded','Too many cards to list safely. Ask an administrator for help.');
  return rows;
}

/** Current administrator's own Foil policy; no recipient information is returned. */
export async function getGiftPolicy(ctx: Ctx) {
  assertGiftAuthority(ctx, {kind:'foil',scope:'single',reason:'Gift policy',idempotency:{key:'policy',digest:'policy'}});
  await requireLiveGiftAuthority(ctx);
  const row = await first<{per_recipient_foil:number;self_grants_allowed:number}>(ctx.db, `SELECT
    CASE WHEN ?=1 THEN 10000 WHEN m.role='owner' AND b.owner_user_id=m.user_id THEN 1000
      ELSE MAX(0,MIN(1000,COALESCE(m.grant_limit,0))) END AS per_recipient_foil,
    CASE WHEN ?=1 OR (m.role='owner' AND b.owner_user_id=m.user_id) OR m.self_grants_enabled=1 THEN 1 ELSE 0 END AS self_grants_allowed
    FROM fb_memberships m JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
    WHERE m.tenant_id=? AND m.user_id=? AND ${liveGiftAuthority}`,
    ctx.user!.platformAdmin?1:0,ctx.user!.platformAdmin?1:0,ctx.tenant.id,ctx.user!.id,...giftAuthorityArgs(ctx));
  if (!row) throw new ApiError(403,'gift_authority_changed','Your gift authority or recent sign-in changed. Sign in again and reload.');
  return { per_recipient_foil:Number(row.per_recipient_foil), self_grants_allowed:Boolean(row.self_grants_allowed) };
}

function sanitizeMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@everyone|@here/gi, "everyone")
    .replace(/<@[!&]?\d+>/g, "a member")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
  return clean || null;
}

function assertGiftAuthority(ctx: Ctx, input: GiftInput): { botId: string | null; tenantId: string } {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to send a gift.");
  if (ctx.actor.type === "agent") {
    throw new ApiError(403, "human_required", "A gift needs a signed-in human administrator.");
  }
  requireRecentStrongAuth(ctx, 15);
  if (user.platformAdmin) {
    return { botId: input.botId ?? null, tenantId: ctx.tenant.id };
  }
  if (!["owner", "editor", "economy_admin"].includes(user.role)) {
    throw new ApiError(403, "insufficient_role", "Only a Bot Owner or delegated administrator can send gifts.");
  }
  if (input.scope === "platform_members") {
    throw new ApiError(403, "super_admin_required", "Only the Super Admin can send a platform-wide gift.");
  }
  return { botId: input.botId ?? null, tenantId: ctx.tenant.id };
}

async function resolveRecipients(ctx: Ctx, input: GiftInput, authority: { botId: string | null; tenantId: string }): Promise<Recipient[]> {
  if (input.scope === "single" || input.scope === "recipients") {
    const ids = [...new Set(input.scope === "single" ? (input.userIds ?? []).slice(0, 1) : (input.userIds ?? []))];
    if (!ids.length) throw new ApiError(422, "recipients_required", "Choose at least one recipient.");
    if (ids.length > MAX_RECIPIENTS) throw new ApiError(422, "recipient_limit", `Send to at most ${MAX_RECIPIENTS} people at once.`);
    const rows = await all<Recipient>(
      ctx.db,
      `SELECT DISTINCT u.id AS user_id, u.email, u.display_name, m.tenant_id, t.name AS tenant_name
         FROM fb_users u
         JOIN fb_memberships m ON m.user_id = u.id AND m.status = 'active' AND m.revoked_at IS NULL
         JOIN fb_tenants t ON t.id = m.tenant_id
        WHERE u.id IN (${ids.map(() => "?").join(",")}) AND u.disabled_at IS NULL AND u.is_synthetic = 0
          AND (? = 0 OR m.tenant_id = ?) AND ${liveGiftAuthority}
        ORDER BY u.display_name`,
      ...ids,
      authority.tenantId,
      authority.tenantId,
      ...giftAuthorityArgs(ctx),
    );
    if (rows.length !== ids.length) {
      throw new ApiError(422, "recipient_invalid", "One or more recipients are not active members of this Bot.");
    }
    return rows;
  }
  if (input.scope === "bot_members") {
    const rows = await all<Recipient>(
      ctx.db,
      `SELECT u.id AS user_id, u.email, u.display_name, m.tenant_id, t.name AS tenant_name
         FROM fb_memberships m
         JOIN fb_users u ON u.id = m.user_id AND u.disabled_at IS NULL
         JOIN fb_tenants t ON t.id = m.tenant_id
        WHERE m.tenant_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.is_synthetic = 0 AND ${liveGiftAuthority}
        ORDER BY u.display_name LIMIT ?`,
      authority.tenantId,
      ...giftAuthorityArgs(ctx),
      MAX_RECIPIENTS + 1,
    );
    if (rows.length > MAX_RECIPIENTS) {
      throw new ApiError(422, "recipient_limit", `This Bot has more than ${MAX_RECIPIENTS} members. Use a smaller recipient list.`);
    }
    return rows;
  }
  // platform_members: Super Admin only. Deliberate per-tenant membership rows,
  // never a synthetic "all wallets" credit.
  const rows = await all<Recipient>(
    ctx.db,
    `SELECT u.id AS user_id, u.email, u.display_name, m.tenant_id, t.name AS tenant_name
       FROM fb_memberships m
       JOIN fb_users u ON u.id = m.user_id AND u.disabled_at IS NULL
       JOIN fb_tenants t ON t.id = m.tenant_id
      WHERE m.status = 'active' AND m.revoked_at IS NULL AND u.is_synthetic=0 AND ${liveGiftAuthority}
      ORDER BY u.display_name LIMIT ?`,
    ...giftAuthorityArgs(ctx), MAX_RECIPIENTS + 1,
  );
  if (rows.length > MAX_RECIPIENTS) {
    throw new ApiError(422, "recipient_limit", `Platform gifts are capped at ${MAX_RECIPIENTS} recipients per campaign.`);
  }
  return rows;
}

function validateAmount(ctx: Ctx, input: GiftInput) {
  if (input.kind === "foil") {
    const amount = Math.floor(Number(input.amount ?? 0));
    if (!Number.isInteger(amount) || amount <= 0) throw new ApiError(422, "amount_invalid", "Enter a whole, positive Foil amount.");
    const limit = ctx.user?.platformAdmin ? 10_000 : 1_000;
    if (amount > limit) throw new ApiError(422, "amount_limit", `This gift is limited to ${limit} Foil per recipient.`);
    return { amount, openings: 0 };
  }
  if (input.kind === "opening") {
    const openings = Math.floor(Number(input.openings ?? 1));
    if (!Number.isInteger(openings) || openings < 1 || openings > 20) {
      throw new ApiError(422, "openings_invalid", "Choose between 1 and 20 openings.");
    }
    return { amount: 0, openings };
  }
  if (!input.cardId) throw new ApiError(422, "card_required", "Choose a card for a card gift.");
  return { amount: 0, openings: 0 };
}

export async function previewAdminGift(ctx: Ctx, input: GiftInput) {
  const authority = assertGiftAuthority(ctx, input);
  await requireLiveGiftAuthority(ctx);
  const recipients = await resolveRecipients(ctx, input, authority);
  if (input.kind === 'opening' && recipients.some((recipient) => recipient.tenant_id !== ctx.tenant.id))
    throw new ApiError(409,'opening_scope_unavailable','Opening-value gifts are available only within the current Bot.');
  const { amount, openings } = validateAmount(ctx, input);
  const pool = await first<{ price: number; revision:number }>(ctx.db, "SELECT price,revision FROM fb_pools WHERE tenant_id = ? AND slug = 'cabinet-draw' AND status = 'active'", authority.tenantId);
  if (input.kind === 'opening' && !pool) throw new ApiError(409,'gift_pool_unavailable','The standard opening pool is unavailable.');
  const price = pool?.price ?? 0;
  const perRecipient = input.kind === "foil" ? amount : input.kind === "opening" ? openings * price : 0;
  if (input.kind === 'opening' && (perRecipient <= 0 || perRecipient > (ctx.user?.platformAdmin ? 10_000 : 1_000)))
    throw new ApiError(422,'amount_limit','The opening value exceeds your per-recipient gift limit.');
  if (perRecipient > 0) {
    try { await ctx.db.batch([giftLimitGuard(ctx,recipients,perRecipient)]); }
    catch (error) {
      await requireLiveGiftAuthority(ctx);
      if (String(error).includes('malformed JSON')) throw new ApiError(403,'gift_grant_limit','This gift exceeds your current grant authority or self-grant policy.');
      throw error;
    }
  }
  const policy = await getGiftPolicy(ctx);
  return {
    bot_id: authority.botId,
    tenant_id: authority.tenantId,
    kind: input.kind,
    scope: input.scope,
    recipient_count: recipients.length,
    recipient_digest: await giftRecipientsDigest(recipients),
    sample: recipients.slice(0, 12).map((row) => ({ user_id: row.user_id, display_name: row.display_name, tenant_name: row.tenant_name })),
    per_recipient_foil: perRecipient,
    total_foil: perRecipient * recipients.length,
    openings_per_recipient: openings,
    standard_opening_price: price,
    standard_opening_revision: pool?.revision ?? null,
    message: sanitizeMessage(input.message),
    reason: input.reason.trim().slice(0, 500),
    limits: { max_recipients: MAX_RECIPIENTS, ...policy },
  };
}

export async function sendAdminGift(ctx: Ctx, input: GiftInput) {
  const authority = assertGiftAuthority(ctx, input);
  await requireLiveGiftAuthority(ctx);
  if (!input.reason.trim() || input.reason.trim().length < 3) {
    throw new ApiError(422, "reason_required", "Record why this gift is being sent.");
  }
  const replay = await first<{request_digest:string;response_json:string;status:string;sent_count:number;failed_count:number;pending_count:number}>(ctx.db, `SELECT k.request_digest,k.response_json,c.status,c.sent_count,c.failed_count,
    (SELECT COUNT(*) FROM fb_gift_awards a WHERE a.campaign_id=c.id AND a.status='pending') AS pending_count
    FROM fb_idempotency_keys k JOIN fb_gift_campaigns c ON c.id=json_extract(k.response_json,'$.campaign_id') AND c.tenant_id=k.tenant_id
    WHERE k.tenant_id=? AND k.actor_type=? AND k.actor_id=? AND k.operation='gift.campaign' AND k.idempotency_key=? AND ${liveGiftAuthority}`,
    ctx.tenant.id,ctx.actor.type,ctx.actor.id,input.idempotency.key,...giftAuthorityArgs(ctx));
  if (replay) {
    if (replay.request_digest !== input.idempotency.digest) throw new ApiError(409,'idempotency_conflict','This key was used for a different gift.');
    return { ...JSON.parse(replay.response_json),status:replay.status,sent_count:replay.sent_count,failed_count:replay.failed_count,pending_count:replay.pending_count,reconciliation_pending:replay.pending_count>0,replayed:true };
  }
  const recipients = await resolveRecipients(ctx, input, authority);
  if ((input.scope === 'bot_members' || input.scope === 'platform_members') && input.expectedRecipientsDigest !== await giftRecipientsDigest(recipients))
    throw new ApiError(409,'gift_recipients_changed','The recipient roster changed. Preview the gift again.');
  if (input.kind === 'opening' && recipients.some((recipient) => recipient.tenant_id !== ctx.tenant.id))
    throw new ApiError(409,'opening_scope_unavailable','Opening-value gifts are available only within the current Bot.');
  if (!recipients.length) throw new ApiError(422, "recipients_required", "No eligible recipients were found.");
  if (input.kind === "card" && input.variantId) {
    const exact = await first<{ id: string }>(
      ctx.db,
      `SELECT v.id FROM fb_variants v JOIN fb_variant_renders vr ON vr.variant_id = v.id AND vr.status = 'published'
        WHERE v.id = ? AND v.card_id = ? AND v.tenant_id = ? AND v.status = 'published' AND v.archived_at IS NULL`,
      input.variantId,
      input.cardId ?? "",
      ctx.tenant.id,
    );
    if (!exact) throw new ApiError(422, "variant_invalid", "That exact finish is not a published variant of the gift card.");
  }
  const validated = validateAmount(ctx, input);
  const openings = validated.openings;
  let amount = validated.amount;
  if (input.kind === 'opening') {
    if (!Number.isSafeInteger(input.expectedOpeningPrice) || !Number.isSafeInteger(input.expectedPoolRevision) || input.expectedOpeningPrice! <= 0 || input.expectedPoolRevision! <= 0)
      throw new ApiError(409,'gift_preview_required','Preview the current opening price before sending.');
    amount = openings * input.expectedOpeningPrice!;
    if (!Number.isSafeInteger(amount) || amount > (ctx.user?.platformAdmin ? 10_000 : 1_000))
      throw new ApiError(422,'amount_limit','The opening value exceeds your per-recipient gift limit.');
  }
  const message = sanitizeMessage(input.message);
  const campaignId = newId("gftc");
  const now = nowIso();
  const item = { amount, openings, opening_price:input.expectedOpeningPrice ?? null, pool_revision:input.expectedPoolRevision ?? null, card_id: input.cardId ?? null, variant_id: input.variantId ?? null };
  const expected = recipients.length;
  const response = {
    campaign_id: campaignId,
    kind: input.kind,
    scope: input.scope,
    recipient_count: expected,
    status: "sending",
    message,
    reason: input.reason.trim().slice(0, 500),
  };
  try {
  await ctx.db.batch([
    ctx.db.prepare(`SELECT CASE WHEN ${liveGiftAuthority} THEN 1 ELSE json('gift_authority_changed') END`).bind(...giftAuthorityArgs(ctx)),
    ...(input.scope === 'bot_members' || input.scope === 'platform_members' ? [massRosterGuard(ctx, input.scope, recipients)] : []),
    ...(input.kind === 'opening' ? [ctx.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM fb_pools WHERE tenant_id=? AND slug='cabinet-draw' AND status='active' AND price=? AND revision=?) THEN 1 ELSE json('gift_price_changed') END`).bind(ctx.tenant.id,input.expectedOpeningPrice,input.expectedPoolRevision)] : []),
    ...(amount > 0 ? [giftLimitGuard(ctx,recipients,amount)] : []),
    ctx.db.prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM json_each(?) r WHERE NOT EXISTS (
      SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
      WHERE m.tenant_id=json_extract(r.value,'$.tenant_id') AND m.user_id=json_extract(r.value,'$.user_id')
       AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND u.is_synthetic=0
    )) THEN 1 ELSE json('gift_recipients_changed') END`).bind(JSON.stringify(recipients.map(({tenant_id,user_id})=>({tenant_id,user_id})))),
    idempotencyStatement(ctx, "gift.campaign", input.idempotency, response),
    ctx.db
      .prepare(
        `INSERT INTO fb_gift_campaigns
          (id, tenant_id, bot_id, created_by, kind, scope, recipient_rule_json, item_json, message, reason,
           status, expected_recipients, sent_count, failed_count, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, 0, 0, ?, ?, ?)`,
      )
      .bind(
        campaignId,
        authority.tenantId,
        authority.botId,
        ctx.user!.id,
        input.kind,
        input.scope,
        JSON.stringify({ user_ids: input.userIds ?? [] }),
        JSON.stringify(item),
        message,
        input.reason.trim().slice(0, 500),
        expected,
        input.idempotency.key,
        now,
        now,
      ),
    ...recipients.map((recipient) =>
      ctx.db
        .prepare(
          `INSERT INTO fb_gift_awards
            (id, campaign_id, tenant_id, user_id, kind, amount, card_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(newId("gfta"), campaignId, recipient.tenant_id, recipient.user_id, input.kind, amount, input.cardId ?? null, now),
    ),
    auditStatement(ctx, "gift.campaign.created", "gift_campaign", campaignId, {
      kind: input.kind,
      scope: input.scope,
      recipients: expected,
      amount,
      openings,
      card_id: input.cardId ?? null,
    }),
  ]);
  } catch (error) {
    await requireLiveGiftAuthority(ctx);
    if (input.kind === 'opening') {
      const current = await first<{price:number;revision:number}>(ctx.db,"SELECT price,revision FROM fb_pools WHERE tenant_id=? AND slug='cabinet-draw' AND status='active'",ctx.tenant.id);
      if (!current || current.price !== input.expectedOpeningPrice || current.revision !== input.expectedPoolRevision)
        throw new ApiError(409,'gift_price_changed','The opening price changed. Preview the gift again before sending.');
    }
    throw error;
  }
  let delivered;
  try { delivered = await processGiftCampaign(ctx, campaignId); }
  catch (error) {
    if (error instanceof ApiError && error.code === 'gift_authority_changed')
      throw new ApiError(409, 'gift_campaign_pending', `Campaign ${campaignId} was created and some gifts may have been delivered. Restore authority and review this campaign before retrying.`);
    throw error;
  }
  return { ...response, ...delivered, replayed: false };
}

export async function processGiftCampaign(ctx: Ctx, campaignId: string) {
  assertGiftAuthority(ctx, { kind:'foil',scope:'single',reason:'Gift retry',idempotency:{key:'retry',digest:'retry'} });
  await requireLiveGiftAuthority(ctx);
  const campaign = await first<{
    id: string;
    tenant_id: string;
    bot_id: string | null;
    created_by: string;
    kind: GiftKind;
    scope: GiftScope;
    message: string | null;
    item_json: string;
    status: string;
  }>(ctx.db, "SELECT * FROM fb_gift_campaigns WHERE id = ? AND tenant_id = ?", campaignId, ctx.tenant.id);
  if (!campaign) throw new ApiError(404, "campaign_not_found", "Gift campaign not found.");
  if (campaign.scope === 'platform_members' && !ctx.user?.platformAdmin)
    throw new ApiError(403, 'super_admin_required', 'Only a Super Admin can resume a platform-wide gift.');
  // Validate and persist the campaign transition before any recipient effect.
  // A failed/partial campaign must explicitly re-enter `sending`; otherwise a
  // late transition assertion after awards were delivered would return an
  // error even though Foil or cards had already moved.
  if (campaign.status !== "sending") {
    assertTransition("gift_campaign", campaign.status, "sending");
    const [, moved] = await ctx.db.batch([giftGuard(ctx), ctx.db
      .prepare("UPDATE fb_gift_campaigns SET status = 'sending', updated_at = ? WHERE id = ? AND tenant_id = ? AND status = ?")
      .bind(nowIso(), campaignId, ctx.tenant.id, campaign.status), ctx.db
      .prepare("UPDATE fb_gift_awards SET status='pending' WHERE campaign_id=? AND status='failed' AND changes()=1")
      .bind(campaignId)]);
    if ((moved?.meta?.changes ?? 0) !== 1) {
      throw new ApiError(409, "campaign_not_sending", "Another worker changed this gift campaign. Reload it before resuming.");
    }
    campaign.status = "sending";
  }
  const awards = await all<{
    id: string;
    tenant_id: string;
    user_id: string;
    kind: GiftKind;
    amount: number;
    card_id: string | null;
    status: string;
  }>(
    ctx.db,
    "SELECT id, tenant_id, user_id, kind, amount, card_id, status FROM fb_gift_awards WHERE campaign_id = ? ORDER BY created_at",
    campaignId,
  );
  for (const award of awards) {
    if (award.status === "delivered") {
      continue;
    }
    try {
      const receipt = await deliverGiftAward(ctx, campaign, award);
      await ctx.db.batch([
        giftGuard(ctx, award),
        ctx.db
          .prepare("UPDATE fb_gift_awards SET status = 'delivered', ledger_id = ?, receipt_json = ?, delivered_at = ?, error = NULL WHERE id = ? AND status <> 'delivered'")
          .bind(receipt.ledgerId ?? null, JSON.stringify(receipt), nowIso(), award.id),
        ctx.db
          .prepare(
            `INSERT INTO fb_outbox (id, tenant_id, topic, payload_json, status, attempts, available_at, created_at)
             SELECT ?, ?, 'gift.received', ?, 'pending', 0, ?, ? WHERE changes()=1`,
          )
          .bind(newId("obx"), award.tenant_id, JSON.stringify({ gift_award_id: award.id, campaign_id: campaignId, user_id: award.user_id }), nowIso(), nowIso()),
        giftSummary(ctx, campaignId),
      ]);
    } catch (error) {
      // A previous award may already have committed. Stop without rewriting
      // its pending receipt when the operator's authority has changed.
      await requireLiveGiftAuthority(ctx);
      // Delivery and receipt recording are separate transactions. A thrown
      // error cannot prove no credit or instance was committed (including a
      // concurrent attempt), so leave the award pending for idempotent retry.
    }
  }
  let finished: D1Result | undefined;
  try {
  [, finished] = await ctx.db.batch([giftGuard(ctx),giftSummary(ctx,campaignId),ctx.db.prepare(`INSERT INTO fb_audit_events
    (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,tenant_id,'user',?,?,'gift.campaign.processed','gift_campaign',id,
      json_object('sent',sent_count,'failed',failed_count,'status',status),?,? FROM fb_gift_campaigns WHERE id=? AND tenant_id=? AND changes()=1`)
    .bind(newId('aud'),ctx.actor.id,ctx.user!.id,ctx.requestId,nowIso(),campaignId,ctx.tenant.id)]);
  } catch (error) { await requireLiveGiftAuthority(ctx); throw error; }
  if ((finished?.meta?.changes ?? 0) !== 1) {
    throw new ApiError(409, "campaign_not_sending", "The gift campaign was changed by another worker. Inspect the recorded awards before retrying.");
  }
  const summary = await first<{sent_count:number;failed_count:number;status:string;pending_count:number}>(ctx.db,`SELECT sent_count,failed_count,status,
    (SELECT COUNT(*) FROM fb_gift_awards WHERE campaign_id=fb_gift_campaigns.id AND status='pending') AS pending_count
    FROM fb_gift_campaigns WHERE id=? AND tenant_id=?`,campaignId,ctx.tenant.id);
  if (!summary) throw new ApiError(409,'campaign_not_sending','The gift campaign is unavailable.');
  const {sent_count:sent,failed_count:failed,status}=summary;
  return { sent_count: sent, failed_count: failed, pending_count: summary.pending_count, reconciliation_pending: summary.pending_count > 0, status };
}

async function deliverGiftAward(
  ctx: Ctx,
  campaign: { id: string; kind: GiftKind; item_json: string; message: string | null; created_by: string },
  award: { id: string; tenant_id: string; user_id: string; kind: GiftKind; amount: number; card_id: string | null },
): Promise<{ ledgerId?: string; instanceId?: string; serial?: string; description: string; amount?: number }> {
  const item = JSON.parse(campaign.item_json) as { amount?: number; openings?: number; opening_price?:number; pool_revision?:number; card_id?: string | null; variant_id?: string | null };
  const idempotencyKey = `gift:${campaign.id}:${award.user_id}:${award.id}`;
  if (award.kind === "foil" || award.kind === "opening") {
    if (award.kind === 'opening' && (!Number.isSafeInteger(item.opening_price) || !Number.isSafeInteger(item.pool_revision) || !Number.isSafeInteger(item.amount)))
      throw new ApiError(409,'gift_price_unbound','This legacy opening gift needs review before delivery.');
    const amount = Math.floor(item.amount ?? award.amount);
    const description =
      award.kind === "foil"
        ? `Gift from ${campaign.created_by === ctx.user?.id ? "the Foilbury team" : "a Foilbury administrator"}`
        : `Gift: Foil equal to ${Math.floor(item.openings ?? 1)} standard opening${Math.floor(item.openings ?? 1) === 1 ? "" : "s"} at the reviewed price`;
    const credit = await creditWallet(ctx.db, {
      tenantId: award.tenant_id,
      userId: award.user_id,
      amount,
      kind: "issue",
      description,
      idempotencyKey,
      referenceType: "admin_gift",
      referenceId: campaign.id,
      metadata: { campaign_id: campaign.id, campaign_created_by: campaign.created_by, message: campaign.message },
      actorType: "user",
      actorId: ctx.user!.id,
      requireActiveMember: true,
      transactionGuard: giftGuard(ctx, award, campaign.id, amount),
    });
    return { ledgerId: credit.ledgerId, amount, description };
  }

  const card = await first<{ id: string; name: string }>(
    ctx.db,
    "SELECT id, name FROM fb_card_definitions WHERE id = ? AND tenant_id = ? AND status = 'published' AND archived_at IS NULL",
    award.card_id ?? item.card_id ?? "",
    ctx.tenant.id,
  );
  if (!card) throw new ApiError(422, "card_invalid", "The gift card is not published.");
  const variant = await first<{id:string;name:string;edition_id:string;render_id:string;asset_id:string;render_sha:string;asset_sha:string;r2_key:string;asset_revision:number}>(ctx.db,
    `SELECT v.id,v.name,v.edition_id,vr.id AS render_id,vr.asset_id,vr.sha256 AS render_sha,a.sha256 AS asset_sha,a.r2_key,a.revision AS asset_revision
       FROM fb_variants v JOIN fb_variant_renders vr ON vr.variant_id=v.id AND vr.tenant_id=v.tenant_id AND vr.status='published'
       JOIN fb_assets a ON a.id=vr.asset_id AND a.tenant_id=vr.tenant_id
      WHERE v.card_id=? AND v.tenant_id=? AND v.status='published' AND v.archived_at IS NULL AND (? IS NULL OR v.id=?)
      ORDER BY CASE WHEN v.name LIKE '%Plain%' OR v.name LIKE '%Base%' THEN 0 ELSE 1 END,v.name,v.id,vr.id LIMIT 1`,
    card.id,ctx.tenant.id,item.variant_id ?? null,item.variant_id ?? null);
  if (!variant) throw new ApiError(409, "card_unavailable", "The gift card has no published finish.");
  const existing = await first<{ id: string; serial: string }>(
    ctx.db,
    "SELECT id, serial FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND acquired_via = ? LIMIT 1",
    award.tenant_id,
    award.user_id,
    `gift:${campaign.id}`,
  );
  if (existing) return { instanceId: existing.id, serial: existing.serial, description: 'Card gift' };
  const instanceId = newId("ins");
  const serial = `FB-G-${newId("s").slice(-6).toUpperCase()}`;
  const now = nowIso();
  try {
    await ctx.db.batch([
      giftGuard(ctx, award, campaign.id),
      publicCardGiftGuard(ctx, award, card.id, variant),
      ctx.db
        .prepare(
          `INSERT INTO fb_card_instances
            (id, tenant_id, user_id, card_id, variant_id, serial, acquired_via, acquired_at, status, favourite, locked, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'owned', 0, 0, ?)`,
        )
        .bind(instanceId, award.tenant_id, award.user_id, card.id, variant.id, serial, `gift:${campaign.id}`, now, now),
      ctx.db
        .prepare(
          `INSERT INTO fb_instance_history (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at)
           VALUES (?, ?, ?, 'gifted', ?, ?, 'admin_gift', ?, ?, ?)`,
        )
        .bind(newId("ih"), award.tenant_id, instanceId, campaign.created_by, award.user_id, campaign.id, JSON.stringify({ message: campaign.message, campaign_created_by: campaign.created_by, processed_by: ctx.user!.id }), now),
    ]);
  } catch (error) {
    // A concurrent worker may have inserted the one permitted gift instance.
    // Re-read it rather than failing an already-delivered award or inserting a
    // duplicate; the partial unique index is the storage-level guard.
    const raced = await first<{ id: string; serial: string }>(
      ctx.db,
      "SELECT id, serial FROM fb_card_instances WHERE tenant_id = ? AND user_id = ? AND acquired_via = ? LIMIT 1",
      award.tenant_id,
      award.user_id,
      `gift:${campaign.id}`,
    );
    if (raced) return { instanceId: raced.id, serial: raced.serial, description: 'Card gift' };
    throw error;
  }
  return { instanceId, serial, description: 'Card gift' };
}

export async function listAdminGiftCampaigns(ctx: Ctx, limit = 50) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see gift campaigns.");
  if (!user.platformAdmin && !["owner", "editor", "economy_admin"].includes(user.role)) {
    throw new ApiError(403, "insufficient_role", "Only administrators can see gift campaigns.");
  }
  assertGiftAuthority(ctx, {kind:'foil',scope:'single',reason:'Gift history',idempotency:{key:'history',digest:'history'}});
  await requireLiveGiftAuthority(ctx);
  return all(
    ctx.db,
    `SELECT c.*, u.display_name AS created_by_name,
            (SELECT COUNT(*) FROM fb_gift_awards a WHERE a.campaign_id = c.id AND a.status = 'delivered') AS delivered
       FROM fb_gift_campaigns c JOIN fb_users u ON u.id = c.created_by
      WHERE c.tenant_id = ? AND ${liveGiftAuthority} ORDER BY c.created_at DESC LIMIT ?`,
    ctx.tenant.id,
    ...giftAuthorityArgs(ctx),
    Math.min(200, Math.max(1, limit)),
  );
}

/** Recover a campaign by its original key without needing the gift payload. */
export async function recoverAdminGift(ctx: Ctx, key: string) {
  assertGiftAuthority(ctx, {kind:'foil',scope:'single',reason:'Gift recovery',idempotency:{key,digest:''}});
  await requireLiveGiftAuthority(ctx);
  const row=await first<{id:string;status:string;sent_count:number;failed_count:number;pending_count:number}>(ctx.db,`SELECT c.id,c.status,c.sent_count,c.failed_count,
    (SELECT COUNT(*) FROM fb_gift_awards a WHERE a.campaign_id=c.id AND a.status='pending') AS pending_count
    FROM fb_idempotency_keys k JOIN fb_gift_campaigns c ON c.id=json_extract(k.response_json,'$.campaign_id') AND c.tenant_id=k.tenant_id
    WHERE k.tenant_id=? AND k.actor_type='user' AND k.actor_id=? AND k.operation='gift.campaign' AND k.idempotency_key=? AND ${liveGiftAuthority}`,
    ctx.tenant.id,ctx.user!.id,key,...giftAuthorityArgs(ctx));
  return row ? {found:true as const,campaign:row} : {found:false as const};
}

export async function listMyGiftReceipts(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new ApiError(401, "authentication_required", "Sign in to see your gifts.");
  if (ctx.actor.representedUserId !== user.id || (ctx.actor.type === 'user' && ctx.actor.id !== user.id)) return [];
  const access=ctx.sessionAssurance==='access' && ctx.accessStatus==='linked' ? ctx.accessIdentity : null;
  const rows = await all<{
    id: string;
    campaign_id: string;
    kind: GiftKind;
    amount: number;
    status: string;
    receipt_json: string;
    created_at: string;
    delivered_at: string;
    message: string | null;
    reason: string;
    campaign_kind: GiftKind;
    can_view_card: number;
  }>(
    ctx.db,
    `SELECT a.id, a.campaign_id, a.kind, a.amount, a.status, a.receipt_json, a.created_at, a.delivered_at,
            c.message, c.reason, c.kind AS campaign_kind,
            CASE WHEN a.kind<>'card' THEN 1 ELSE EXISTS (
              SELECT 1 FROM fb_card_definitions cd JOIN fb_bots b ON b.tenant_id=a.tenant_id AND b.status='active'
              WHERE cd.id=a.card_id AND cd.tenant_id=a.tenant_id AND cd.status='published' AND cd.archived_at IS NULL
                AND EXISTS (SELECT 1 FROM fb_collection_cards cc WHERE cc.card_id=cd.id)
                AND NOT EXISTS (SELECT 1 FROM fb_collection_cards cc LEFT JOIN fb_collections col ON col.id=cc.collection_id
                  LEFT JOIN fb_bot_collections bc ON bc.collection_id=col.id AND bc.bot_id=b.id
                  WHERE cc.card_id=cd.id AND (col.id IS NULL OR col.status<>'published' OR col.archived_at IS NOT NULL OR COALESCE(bc.enabled,0)<>1
                    OR (col.scope='bot' AND col.owner_tenant_id IS NOT b.tenant_id)
                    OR NOT ((col.scope='global' AND col.view_audience='public' AND col.public_approved_at IS NOT NULL)
                      OR (col.view_audience='members' AND (col.scope='global' OR (col.scope='bot' AND col.owner_tenant_id=b.tenant_id)))
                      OR (col.view_audience='private' AND EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=col.id AND cv.user_id=a.user_id AND cv.revoked_at IS NULL)))))
            ) END AS can_view_card
       FROM fb_gift_awards a JOIN fb_gift_campaigns c ON c.id = a.campaign_id
       JOIN fb_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id AND m.status='active' AND m.revoked_at IS NULL
       JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
      WHERE a.user_id = ? AND a.tenant_id = ? AND a.status = 'delivered'
        AND ((?='user' AND (EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=u.id AND s.tenant_id=m.tenant_id AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))
          OR (?='agent' AND EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id WHERE t.id=? AND g.id=? AND t.revoked_at IS NULL
            AND g.agent_id=? AND g.represented_user_id=u.id AND g.tenant_id=m.tenant_id AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
            AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
            AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
            AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='trade:write'))))
      ORDER BY a.delivered_at DESC LIMIT 50`,
    user.id,
    ctx.tenant.id,
    ctx.actor.type,ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? '',access?.email ?? '',access?.email ?? '',
    ctx.actor.type,ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,
  );
  return rows.map((row) => {
    let receipt: Record<string, unknown> = {};
    try {
      receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
    } catch {
      receipt = {};
    }
    if (row.kind === 'card' && !row.can_view_card) return { id:row.id,campaign_id:row.campaign_id,kind:'card' as const,amount:0,description:'A card gift is not currently available.',message:null,reason:null,delivered_at:row.delivered_at,receipt:{} };
    if (row.kind === 'card') return { id:row.id,campaign_id:row.campaign_id,kind:'card' as const,amount:0,description:'Card gift',message:row.message,reason:row.reason,delivered_at:row.delivered_at,receipt:{} };
    return {
      id: row.id,
      campaign_id: row.campaign_id,
      kind: row.campaign_kind,
      amount: Number(receipt.amount ?? row.amount),
      description: String(receipt.description ?? "A gift from Foilbury"),
      message: row.message,
      reason: row.reason,
      delivered_at: row.delivered_at,
      receipt,
    };
  });
}
