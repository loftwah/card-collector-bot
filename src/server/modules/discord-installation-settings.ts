import { ApiError, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import { botForTenant } from "./bots";

interface InstallationSettings {
  id: string;
  guild_name: string;
  guild_id: string;
  collection_allowlist_json: string | null;
  configuration_revision: number;
  game_enabled: number;
  website_enabled: number;
  api_enabled: number;
  public_catalogue_enabled: number;
  admin_gui_enabled: number;
}

// Explicit Bot Admin grants supersede legacy role mapping. A revoked grant is
// deliberately not treated as a missing legacy record. Both membership and
// grant must retain content authority when an explicit grant exists.
const liveContentAuthority = `EXISTS (
  SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id = m.user_id
  JOIN fb_bots b ON b.id = ? AND b.tenant_id = m.tenant_id AND b.status <> 'archived'
  LEFT JOIN fb_bot_admins ba ON ba.bot_id = b.id AND ba.user_id = m.user_id
  WHERE m.tenant_id = ? AND m.user_id = ? AND m.status = 'active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
    AND (? IS NULL OR EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id = ? AND s.user_id = m.user_id
      AND s.tenant_id = m.tenant_id AND s.revoked_at IS NULL AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    AND ((m.role = 'owner' AND b.owner_user_id = m.user_id)
      OR (u.platform_admin = 1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.revoked_at IS NULL))
      OR (m.role <> 'owner' AND ba.id IS NOT NULL AND ba.role = 'admin' AND ba.status = 'active' AND ba.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'content')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value = 'content'))
      OR (m.role <> 'owner' AND ba.id IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value = 'content')))
)`;
const liveSettingsAuthority = liveContentAuthority.replaceAll("'content'", "'settings'");

function authorityArgs(ctx: Ctx, botId: string) {
  return [botId, ctx.tenant.id, ctx.user?.id ?? "", ctx.sessionId, ctx.sessionId];
}

const liveStrongSession = `EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=? AND s.tenant_id=?
 AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND s.assurance=? AND s.assurance IN ('mfa','passkey')
 AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
function strongArgs(ctx: Ctx) { return [ctx.sessionId,ctx.user?.id ?? '',ctx.tenant.id,ctx.sessionAssurance]; }
async function requireLiveStrongSession(ctx: Ctx) {
  if (ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user?.id || ctx.actor.representedUserId !== ctx.user?.id ||
      !(await first<{ok:number}>(ctx.db, `SELECT ${liveStrongSession} AS ok`, ...strongArgs(ctx)))?.ok)
    throw new ApiError(403,'strong_auth_required','Confirm with a passkey or authenticator code before changing server collections.');
}

// Evaluated inside the UPDATE, so a viewer grant, collection audience, or
// scoped role cannot disappear between the editor read and the save.
// Foreign Bot collections never become installation choices.
const safeScopes = "CASE WHEN json_valid(p.scopes_json) THEN p.scopes_json ELSE '{}' END";
const liveManagedTenant = `EXISTS (
  SELECT 1 FROM fb_memberships vm JOIN fb_bots vb ON vb.tenant_id=vm.tenant_id AND vb.status<>'archived'
  LEFT JOIN fb_bot_admins va ON va.bot_id=vb.id AND va.user_id=vm.user_id
  WHERE vm.tenant_id=c.owner_tenant_id AND vm.user_id=? AND vm.status='active' AND vm.revoked_at IS NULL AND vm.role IN ('owner','editor','economy_admin')
    AND ((vm.role='owner' AND vb.owner_user_id=vm.user_id) OR (vm.role<>'owner'
      AND json_type(CASE WHEN json_valid(vm.capabilities_json) THEN vm.capabilities_json ELSE 'null' END)='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(vm.capabilities_json) THEN vm.capabilities_json ELSE '[]' END) WHERE type<>'text')
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(vm.capabilities_json) THEN vm.capabilities_json ELSE '[]' END) WHERE value='content')
      AND (va.id IS NULL OR (va.role='admin' AND va.status='active' AND va.revoked_at IS NULL
        AND json_type(CASE WHEN json_valid(va.capabilities_json) THEN va.capabilities_json ELSE 'null' END)='array'
        AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(va.capabilities_json) THEN va.capabilities_json ELSE '[]' END) WHERE type<>'text')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(va.capabilities_json) THEN va.capabilities_json ELSE '[]' END) WHERE value='content')))))
)`;
const liveSelection = `NOT EXISTS (
 SELECT 1 FROM json_each(?) wanted
 LEFT JOIN fb_collections c ON c.id = wanted.value
 WHERE c.id IS NULL OR c.archived_at IS NOT NULL OR c.status = 'archived' OR COALESCE((
   (c.scope = 'bot' AND c.owner_tenant_id = ? AND (${liveManagedTenant} OR EXISTS (SELECT 1 FROM fb_platform_admins pa JOIN fb_users u ON u.id=pa.user_id WHERE pa.user_id=? AND pa.status='active' AND pa.revoked_at IS NULL AND u.platform_admin=1 AND u.disabled_at IS NULL) OR (c.status='published' AND (c.view_audience='members' OR (c.view_audience='public' AND c.public_approved_at IS NOT NULL) OR (c.view_audience='private' AND EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=c.id AND cv.user_id=? AND cv.revoked_at IS NULL))))))
   OR (c.scope = 'global' AND (
     EXISTS (SELECT 1 FROM fb_platform_admins pa JOIN fb_users u ON u.id=pa.user_id WHERE pa.user_id=? AND pa.status='active' AND pa.revoked_at IS NULL AND u.platform_admin=1 AND u.disabled_at IS NULL)
     OR EXISTS (SELECT 1 FROM fb_platform_role_assignments p WHERE p.user_id=? AND p.role='global_collection_admin' AND p.status='active' AND p.revoked_at IS NULL AND
       (json_type(${safeScopes},'$.all')='true' OR (json_type(${safeScopes},'$.all')='false' AND json_type(${safeScopes},'$.collectionIds')='array' AND json_array_length(${safeScopes},'$.collectionIds')>0 AND NOT EXISTS (SELECT 1 FROM json_each(${safeScopes},'$.collectionIds') j WHERE j.type<>'text') AND EXISTS (SELECT 1 FROM json_each(${safeScopes},'$.collectionIds') j WHERE j.value=c.id))))
     OR (c.status='published' AND (
       (c.view_audience='public' AND c.public_approved_at IS NOT NULL)
       OR c.view_audience='members'
       OR (c.view_audience='private' AND ((c.owner_tenant_id=? AND ${liveManagedTenant}) OR EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=c.id AND cv.user_id=? AND cv.revoked_at IS NULL)))
     ))
   ))
 ), 0) = 0)`;
function selectionArgs(ctx: Ctx) {
  const user = ctx.user?.id ?? "";
  return [ctx.tenant.id,user,user,user,user,user,ctx.tenant.id,user,user];
}
/** Transaction-bound single-collection audience predicate for a human viewer. */
export function liveHumanCollectionSelection(ctx: Ctx, collectionId: string) {
  if (!ctx.user || ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user.id || ctx.actor.representedUserId !== ctx.user.id)
    throw new ApiError(403,'human_auth_required','Sign in as a member to record this action.');
  return { sql: liveSelection, args: [JSON.stringify([collectionId]), ...selectionArgs(ctx)] };
}
async function liveCollectionChoices(ctx: Ctx, botId: string) {
  if (ctx.actor.type === 'agent') {
    if (!ctx.agentCredential || ctx.actor.representedUserId !== ctx.user?.id) throw new ApiError(403,'human_auth_required','The delegated credential cannot be verified.');
    return all<{id:string;name:string;enabled:number;status:string}>(ctx.db,
      `SELECT picked.id,picked.name,COALESCE(bc.enabled,0) AS enabled,picked.status FROM fb_collections picked
       LEFT JOIN fb_bot_collections bc ON bc.collection_id=picked.id AND bc.bot_id=?
       WHERE ${liveAgentRead} AND picked.archived_at IS NULL AND picked.status='published'
        AND (picked.scope='global' OR (picked.scope='bot' AND picked.owner_tenant_id=?))
        AND ((picked.view_audience='public' AND picked.public_approved_at IS NOT NULL) OR picked.view_audience='members'
          OR (picked.view_audience='private' AND EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=picked.id AND cv.user_id=? AND cv.revoked_at IS NULL)))
       ORDER BY CASE picked.scope WHEN 'global' THEN 0 ELSE 1 END,picked.sort,picked.name`,
      botId,...agentArgs(ctx,botId),ctx.tenant.id,ctx.user!.id);
  }
  if (ctx.actor.type !== 'user' || ctx.actor.id !== ctx.user?.id || ctx.actor.representedUserId !== ctx.user?.id)
    throw new ApiError(403,'human_auth_required','Sign in to manage server collections.');
  return all<{id:string;name:string;enabled:number;status:string}>(ctx.db,
    `SELECT picked.id,picked.name,COALESCE(bc.enabled,0) AS enabled,picked.status FROM fb_collections picked
     LEFT JOIN fb_bot_collections bc ON bc.collection_id=picked.id AND bc.bot_id=?
     WHERE ${liveContentAuthority} AND ${liveSelection.replace('json_each(?)','json_each(json_array(picked.id))')}
     ORDER BY CASE picked.scope WHEN 'global' THEN 0 ELSE 1 END,picked.sort,picked.name`,
    botId,...authorityArgs(ctx,botId),...selectionArgs(ctx));
}

async function requireLiveContentAuthority(ctx: Ctx, botId: string) {
  const row = await first<{ allowed: number }>(ctx.db, `SELECT ${liveContentAuthority} AS allowed`, ...authorityArgs(ctx, botId));
  if (!row?.allowed) throw new ApiError(403, "insufficient_role", "Your Bot content access has changed. Refresh your session or ask the Bot Owner.");
}
async function requireLiveSettingsAuthority(ctx: Ctx, botId: string) {
  const row=await first<{allowed:number}>(ctx.db,`SELECT ${liveSettingsAuthority} AS allowed`,...authorityArgs(ctx,botId));
  if (!row?.allowed) throw new ApiError(403,'insufficient_role','Your Bot settings access has changed. Refresh your session or ask the Bot Owner.');
}

const liveAgentRead = `EXISTS (SELECT 1 FROM fb_agent_tokens t JOIN fb_agent_grants g ON g.id=t.grant_id
 JOIN fb_memberships m ON m.tenant_id=g.tenant_id AND m.user_id=g.represented_user_id
 JOIN fb_users u ON u.id=m.user_id AND u.disabled_at IS NULL
 JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
 LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=m.user_id
 WHERE t.id=? AND g.id=? AND g.agent_id=? AND g.represented_user_id=? AND g.tenant_id=? AND b.id=?
 AND t.revoked_at IS NULL AND g.status='active' AND g.revoked_at IS NULL AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND m.status='active' AND m.revoked_at IS NULL
 AND json_type(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE 'null' END)='array'
 AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE type<>'text')
 AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(g.scopes_json) THEN g.scopes_json ELSE '[]' END) WHERE value='content:read')
 AND ((m.role='owner' AND b.owner_user_id=m.user_id) OR (m.role<>'owner' AND ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content')
  AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='content'))))`;
function agentArgs(ctx: Ctx, botId: string) {
 return [ctx.agentCredential?.tokenId ?? '',ctx.agentCredential?.grantId ?? '',ctx.actor.id,ctx.user?.id ?? '',ctx.tenant.id,botId];
}
async function requireReadAuthority(ctx: Ctx, botId: string) {
 if (ctx.actor.type !== 'agent') return requireLiveContentAuthority(ctx,botId);
 if (!ctx.user || ctx.actor.representedUserId!==ctx.user.id || !ctx.agentCredential || !(await first<{ok:number}>(ctx.db,`SELECT ${liveAgentRead} AS ok`,...agentArgs(ctx,botId)))?.ok)
   throw new ApiError(403,'insufficient_role','The delegated content access is no longer active.');
}

export async function listDiscordInstallationSettings(ctx: Ctx) {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  if (!bot) return { installations: [], collections: [], permissions:{canManageCollections:false,canManageAvailability:false} };
  if (ctx.actor.type!=='agent' && (ctx.actor.type!=='user' || ctx.actor.id!==ctx.user?.id || ctx.actor.representedUserId!==ctx.user?.id))
    throw new ApiError(403,'human_auth_required','Sign in to manage server settings.');
  const capabilities=ctx.actor.type==='agent' ? {content:true,settings:false} : await first<{content:number;settings:number}>(ctx.db,
    `SELECT ${liveContentAuthority} AS content,${liveSettingsAuthority} AS settings`,...authorityArgs(ctx,bot.id),...authorityArgs(ctx,bot.id));
  if (!capabilities?.content && !capabilities?.settings) throw new ApiError(403,'insufficient_role','Your Bot access has changed. Refresh your session or ask the Bot Owner.');
  if (capabilities.content) await requireReadAuthority(ctx,bot.id);
  const installations = await all<InstallationSettings>(ctx.db,
    `SELECT id, guild_name, guild_id, collection_allowlist_json, configuration_revision, game_enabled, website_enabled, api_enabled, public_catalogue_enabled, admin_gui_enabled
       FROM fb_discord_installations WHERE tenant_id = ? AND bot_id = ? AND active = 1 AND ${ctx.actor.type === 'agent' ? liveAgentRead : capabilities.content ? liveContentAuthority : liveSettingsAuthority} ORDER BY guild_name, id`,
    ctx.tenant.id, bot.id, ...(ctx.actor.type === 'agent' ? agentArgs(ctx,bot.id) : authorityArgs(ctx, bot.id)));
  const collections = capabilities.content ? await liveCollectionChoices(ctx, bot.id) : [];
  // Do not return the multi-query result if authority was revoked while the
  // collection list was being loaded. This is a read decision at this check;
  // a later revocation cannot recall a response already sent.
  if (capabilities.content) await requireReadAuthority(ctx, bot.id);
  if (capabilities.settings) await requireLiveSettingsAuthority(ctx,bot.id);
  const available = new Set(collections.map(collection=>collection.id));
  const safeInstallations = installations.map(installation => {
    const {game_enabled,website_enabled,api_enabled,public_catalogue_enabled,admin_gui_enabled,...base}=installation;
    const safe={...base,...(capabilities.settings ? {game_enabled} : {})};
    if (!capabilities.content) return {...safe,collection_allowlist_json:null,selection_state:'unavailable' as const};
    if (installation.collection_allowlist_json === null) return {...safe,selection_state:'available' as const};
    try {
      const parsed:unknown=JSON.parse(installation.collection_allowlist_json);
      if (!Array.isArray(parsed) || parsed.some(id=>typeof id!=='string' || !id))
        return {...safe,collection_allowlist_json:null,selection_state:'invalid' as const};
      if (parsed.some(id=>!available.has(id)))
        return {...safe,collection_allowlist_json:null,selection_state:'unavailable' as const};
      return {...safe,selection_state:'available' as const};
    } catch { return {...safe,collection_allowlist_json:null,selection_state:'invalid' as const}; }
  });
  return { installations:safeInstallations, collections: collections.map(({ id, name, enabled, status }) => ({ id, name, enabled: Boolean(enabled), status })), permissions:{canManageCollections:Boolean(capabilities.content),canManageAvailability:Boolean(capabilities.settings)} };
}

const availabilityColumns = {game:'game_enabled'} as const;
export async function updateDiscordInstallationAvailability(ctx: Ctx, id: string, body: {revision:number;surface:keyof typeof availabilityColumns;enabled:boolean}) {
  const bot=await botForTenant(ctx.db,ctx.tenant.id);
  if (!bot) throw new ApiError(404,'installation_not_found','That active installation is not available for this Bot.');
  await requireLiveSettingsAuthority(ctx,bot.id);
  await requireLiveStrongSession(ctx);
  const column=availabilityColumns[body.surface];
  if (!column) throw new ApiError(422,'surface_invalid','Choose a valid availability surface.');
  const now=nowIso();
  const [updated]=await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_discord_installations SET ${column}=?,configuration_revision=configuration_revision+1,updated_at=?
      WHERE id=? AND tenant_id=? AND bot_id=? AND active=1 AND revoked_at IS NULL AND configuration_revision=? AND ${liveSettingsAuthority} AND ${liveStrongSession}`)
      .bind(body.enabled?1:0,now,id,ctx.tenant.id,bot.id,body.revision,...authorityArgs(ctx,bot.id),...strongArgs(ctx)),
    ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,?,'user',?,?,'discord.installation.availability.updated','discord_installation',?,?,?,? WHERE changes()=1`)
      .bind(newId('aud'),ctx.tenant.id,ctx.user!.id,ctx.user!.id,id,JSON.stringify({surface:body.surface,enabled:body.enabled,previousRevision:body.revision}),ctx.requestId,now),
  ]);
  if (!updated?.meta.changes) {
    await requireLiveStrongSession(ctx);
    await requireLiveSettingsAuthority(ctx,bot.id);
    throw new ApiError(409,'stale_installation','This server’s settings changed or the server is unavailable. Reload before saving.');
  }
  return {ok:true,revision:body.revision+1};
}

const livePlatformReviewer = `EXISTS (SELECT 1 FROM fb_sessions s JOIN fb_users u ON u.id=s.user_id
 JOIN fb_memberships m ON m.user_id=u.id AND m.tenant_id=s.tenant_id
 JOIN fb_platform_admins pa ON pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL
 WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND s.assurance IN ('passkey','mfa') AND s.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND s.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND u.platform_admin=1 AND u.disabled_at IS NULL AND m.status='active' AND m.revoked_at IS NULL)`;
export async function updatePlatformInstallation(ctx: Ctx,id:string,body:{revision:number;channelAllowlist?:string[];gameEnabled?:boolean;active?:boolean}) {
  if (!ctx.user || ctx.actor.type!=='user' || ctx.actor.id!==ctx.user.id || ctx.actor.representedUserId!==ctx.user.id)
    throw new ApiError(403,'strong_auth_required','Sign in with a passkey or authenticator before changing an installation.');
  const authority=[ctx.sessionId,ctx.user.id,ctx.tenant.id];
  if (!(await first<{ok:number}>(ctx.db,`SELECT ${livePlatformReviewer} AS ok`,...authority))?.ok)
    throw new ApiError(403,'strong_auth_required','Sign in with a recent passkey or authenticator before changing an installation.');
  const fields:string[]=[],values:unknown[]=[];
  if(body.channelAllowlist!==undefined){fields.push('channel_allowlist_json=?');values.push(JSON.stringify(body.channelAllowlist));}
  if(body.gameEnabled!==undefined){fields.push('game_enabled=?');values.push(body.gameEnabled?1:0);}
  if(body.active!==undefined){fields.push('active=?');values.push(body.active?1:0);}
  if(!fields.length) throw new ApiError(422,'installation_change_required','Choose a setting to change.');
  const now=nowIso();
  const [updated]=await ctx.db.batch([
    ctx.db.prepare(`UPDATE fb_discord_installations SET ${fields.join(',')},configuration_revision=configuration_revision+1,updated_at=? WHERE id=? AND configuration_revision=? AND ${livePlatformReviewer}`)
      .bind(...values,now,id,body.revision,...authority),
    ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
      SELECT ?,di.tenant_id,'user',?,?,'platform.installation.updated','discord_installation',di.id,?,?,? FROM fb_discord_installations di WHERE di.id=? AND changes()=1`)
      .bind(newId('aud'),ctx.user.id,ctx.user.id,JSON.stringify(body),ctx.requestId,now,id),
  ]);
  if(!updated?.meta.changes) throw new ApiError(409,'stale_installation','The installation or your access changed. Reload before saving.');
  return {ok:true,revision:body.revision+1};
}

export async function updateDiscordInstallationSettings(ctx: Ctx, id: string, body: { revision: number; collectionIds: string[] | null }) {
  const bot = await botForTenant(ctx.db, ctx.tenant.id);
  const installation = bot && await first<InstallationSettings>(ctx.db,
    `SELECT id, guild_name, guild_id, collection_allowlist_json, configuration_revision
       FROM fb_discord_installations WHERE id = ? AND tenant_id = ? AND bot_id = ? AND active = 1`,
    id, ctx.tenant.id, bot.id);
  if (!installation) throw new ApiError(404, "installation_not_found", "That active installation is not available for this Bot.");
  await requireLiveContentAuthority(ctx, bot!.id);
  await requireLiveStrongSession(ctx);
  const ids = body.collectionIds === null ? null : [...new Set(body.collectionIds)].sort();
  const collections = await liveCollectionChoices(ctx, bot!.id);
  const permitted = new Set(collections.map((collection) => collection.id));
  if (ids?.some((item) => !permitted.has(item))) throw new ApiError(400, "invalid_collection", "A selected collection is unavailable to this Bot. Reload and try again.");
  const update = ctx.db.prepare(
    `UPDATE fb_discord_installations SET collection_allowlist_json = ?, configuration_revision = configuration_revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND bot_id = ? AND active = 1 AND configuration_revision = ? AND ${liveContentAuthority} AND ${liveStrongSession} AND ${liveSelection}`,
  ).bind(ids === null ? null : JSON.stringify(ids), nowIso(), id, ctx.tenant.id, bot!.id, body.revision, ...authorityArgs(ctx, bot!.id), ...strongArgs(ctx), JSON.stringify(ids ?? []), ...selectionArgs(ctx));
  const audit = ctx.db.prepare(`INSERT INTO fb_audit_events
    (id, tenant_id, actor_type, actor_id, represented_user_id, action, object_type, object_id, metadata_json, request_id, created_at)
    SELECT ?, ?, ?, ?, ?, 'discord.installation.collections.updated', 'discord_installation', ?, ?, ?, ? WHERE changes() = 1`)
    .bind(newId("aud"), ctx.tenant.id, ctx.actor.type, ctx.actor.id, ctx.actor.representedUserId, id,
      JSON.stringify({ collectionIds: ids, previousRevision: body.revision }), ctx.requestId, nowIso());
  const [result] = await ctx.db.batch([update, audit]);
  // D1's change count includes writes made by the draw-scope epoch trigger.
  if (!result || !result.meta.changes) {
    await requireLiveContentAuthority(ctx, bot!.id);
    await requireLiveStrongSession(ctx);
    throw new ApiError(409, "stale_installation", "This server's settings or available collections changed. Reload before saving.");
  }
  return { ok: true, revision: body.revision + 1 };
}
