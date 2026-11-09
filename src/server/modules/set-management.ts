import { ApiError, requireRecentStrongAuth, type Ctx } from "../context";
import { all, first, nowIso } from "../db";
import { newId } from "../ids";
import type { SetView } from "./catalogue";

// Bot owners and explicitly content-authorized Bot admins; Access authenticates
// but never supplies the role. Explicit revoked grants override legacy roles.
const authority = `EXISTS (SELECT 1 FROM fb_memberships m JOIN fb_users u ON u.id=m.user_id
  JOIN fb_bots b ON b.tenant_id=m.tenant_id AND b.status='active'
  LEFT JOIN fb_bot_admins ba ON ba.bot_id=b.id AND ba.user_id=m.user_id
  WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND m.revoked_at IS NULL AND u.disabled_at IS NULL
    AND ((m.role='owner' AND b.owner_user_id=u.id) OR (u.platform_admin=1 AND EXISTS (SELECT 1 FROM fb_platform_admins pa WHERE pa.user_id=u.id AND pa.status='active' AND pa.revoked_at IS NULL))
      OR (m.role<>'owner' AND ((ba.id IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content'))
        OR (ba.id IS NOT NULL AND ba.role='admin' AND ba.status='active' AND ba.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.capabilities_json) THEN m.capabilities_json ELSE '[]' END) WHERE value='content') AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ba.capabilities_json) THEN ba.capabilities_json ELSE '[]' END) WHERE value='content')))))
    AND (EXISTS (SELECT 1 FROM fb_sessions sess WHERE sess.id=? AND sess.user_id=u.id AND sess.tenant_id=m.tenant_id AND sess.revoked_at IS NULL AND sess.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=u.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? AND ai.revoked_at IS NULL) AND u.email=? COLLATE NOCASE)))`;
function authorityArgs(ctx: Ctx) {
  const access = ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" ? ctx.accessIdentity : null;
  return [ctx.tenant.id,ctx.user?.id ?? "",ctx.sessionId,ctx.sessionAssurance,access?.payload.exp ?? 0,ctx.config.access.teamDomain,access?.subject ?? "",access?.email ?? "",access?.email ?? ""];
}
async function assertAuthority(ctx: Ctx) {
  if (!ctx.user || ctx.actor.type !== "user" || ctx.actor.id !== ctx.user.id || ctx.actor.representedUserId !== ctx.user.id) throw new ApiError(403,"set_management_forbidden","A signed-in Bot content administrator is required.");
  const row = await first<{ok:number}>(ctx.db, `SELECT CASE WHEN ${authority} THEN 1 ELSE 0 END AS ok`, ...authorityArgs(ctx));
  if (!row?.ok) throw new ApiError(403,"set_management_forbidden","Your Bot content access or session has changed.");
}

// Evaluated inside the statement that returns or changes card-bound content.
// Bot-private collections from another Bot are never inherited by this workspace.
const liveVisibleCard = `NOT EXISTS (SELECT 1 FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id
  WHERE cc.card_id=cd.id AND NOT (c.status='published' AND c.archived_at IS NULL AND (c.scope<>'bot' OR c.owner_tenant_id=?) AND (
    EXISTS (SELECT 1 FROM fb_users u JOIN fb_platform_admins pa ON pa.user_id=u.id WHERE u.id=? AND u.disabled_at IS NULL AND u.platform_admin=1 AND pa.status='active' AND pa.revoked_at IS NULL)
    OR (c.scope='global' AND EXISTS (SELECT 1 FROM fb_platform_role_assignments p WHERE p.user_id=? AND p.role='global_collection_admin' AND p.status='active' AND p.revoked_at IS NULL AND json_valid(p.scopes_json) AND
      (json_type(p.scopes_json,'$.all')='true' OR (json_type(p.scopes_json,'$.all')='false' AND json_type(p.scopes_json,'$.collectionIds')='array' AND json_array_length(p.scopes_json,'$.collectionIds')>0 AND NOT EXISTS (SELECT 1 FROM json_each(p.scopes_json,'$.collectionIds') j WHERE j.type<>'text') AND EXISTS (SELECT 1 FROM json_each(p.scopes_json,'$.collectionIds') j WHERE j.value=c.id)))))
    OR (c.view_audience='public' AND c.public_approved_at IS NOT NULL)
    OR (c.view_audience='members' AND (c.scope='global' OR c.owner_tenant_id=?))
    OR (c.view_audience='private' AND (c.owner_tenant_id=? OR EXISTS (SELECT 1 FROM fb_collection_viewers cv WHERE cv.collection_id=c.id AND cv.user_id=? AND cv.revoked_at IS NULL)))
  )))`;
function visibleArgs(ctx: Ctx) { return [ctx.tenant.id,ctx.user!.id,ctx.user!.id,ctx.tenant.id,ctx.tenant.id,ctx.user!.id]; }

// Exact live authorization and collection membership state, captured before
// validation and compared in the transaction; no stale collection grant may
// authorize the subsequent write. JSON parameters avoid per-card bind growth.
const snapshotSql = `SELECT json_object(
  'user',json((SELECT COALESCE(json_group_array(json_array(platform_admin,disabled_at)),'[]') FROM (SELECT platform_admin,disabled_at FROM fb_users WHERE id=?))),
  'bots',json((SELECT COALESCE(json_group_array(json_array(id,tenant_id,owner_user_id,status)),'[]') FROM (SELECT id,tenant_id,owner_user_id,status FROM fb_bots WHERE tenant_id IN (SELECT tenant_id FROM fb_memberships WHERE user_id=?) ORDER BY id))),
  'memberships',json((SELECT COALESCE(json_group_array(json_array(tenant_id,role,status,revoked_at,capabilities_json)),'[]') FROM (SELECT tenant_id,role,status,revoked_at,capabilities_json FROM fb_memberships WHERE user_id=? ORDER BY tenant_id))),
  'admins',json((SELECT COALESCE(json_group_array(json_array(bot_id,role,status,revoked_at,capabilities_json)),'[]') FROM (SELECT bot_id,role,status,revoked_at,capabilities_json FROM fb_bot_admins WHERE user_id=? ORDER BY bot_id))),
  'platform',json((SELECT COALESCE(json_group_array(json_array(status,revoked_at)),'[]') FROM (SELECT status,revoked_at FROM fb_platform_admins WHERE user_id=?))),
  'scopes',json((SELECT COALESCE(json_group_array(json_array(id,status,revoked_at,scopes_json)),'[]') FROM (SELECT id,status,revoked_at,scopes_json FROM fb_platform_role_assignments WHERE user_id=? ORDER BY id))),
  'viewers',json((SELECT COALESCE(json_group_array(json_array(collection_id,revoked_at)),'[]') FROM (SELECT collection_id,revoked_at FROM fb_collection_viewers WHERE user_id=? ORDER BY collection_id))),
  'cards',json((SELECT COALESCE(json_group_array(json_array(id,status,archived_at,slug,name)),'[]') FROM (SELECT id,status,archived_at,slug,name FROM fb_card_definitions WHERE tenant_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id))),
  'collections',json((SELECT COALESCE(json_group_array(json_array(card_id,collection_id,scope,owner_tenant_id,status,view_audience,public_approved_at,archived_at)),'[]') FROM
    (SELECT cc.card_id, c.id collection_id,c.scope,c.owner_tenant_id,c.status,c.view_audience,c.public_approved_at,c.archived_at FROM fb_collection_cards cc JOIN fb_collections c ON c.id=cc.collection_id WHERE cc.card_id IN (SELECT value FROM json_each(?)) ORDER BY cc.card_id,c.id)))
) AS snapshot`;
function snapshotArgs(ctx: Ctx, idsJson: string) { return [ctx.user!.id,ctx.user!.id,ctx.user!.id,ctx.user!.id,ctx.user!.id,ctx.user!.id,ctx.user!.id,ctx.tenant.id,idsJson,idsJson]; }

// Do not let hidden sets or their card counts affect an observable overload
// response. Apply the same whole-roster eligibility before every list bound.
const eligibleSet = `NOT EXISTS (SELECT 1 FROM fb_set_memberships hidden LEFT JOIN fb_card_definitions cd ON cd.id=hidden.card_id AND cd.tenant_id=hidden.tenant_id
 WHERE hidden.tenant_id=s.tenant_id AND hidden.set_id=s.id AND hidden.set_version=s.version
 AND (cd.id IS NULL OR cd.archived_at IS NOT NULL OR NOT (${liveVisibleCard})))`;

export async function listManagedSets(ctx: Ctx): Promise<SetView[]> {
  await assertAuthority(ctx);
  const totalSets = await first<{n:number}>(ctx.db,`SELECT COUNT(*) AS n FROM fb_sets s WHERE s.tenant_id=? AND ${eligibleSet}`,ctx.tenant.id,...visibleArgs(ctx));
  if (Number(totalSets?.n ?? 0) > 100) throw new ApiError(503,"set_list_overloaded","Too many sets to check safely in one workspace view.");
  const registrySql = `SELECT COALESCE(json_group_array(json_array(id,version,status,slug,name,description,reward,card_id,sort,published_at)),'[]') AS snapshot FROM
    (SELECT s.id,s.version,s.status,s.slug,s.name,s.description,r.reward_amount AS reward,sm.card_id,sm.sort,s.published_at FROM fb_sets s
     LEFT JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version
     LEFT JOIN fb_set_memberships sm ON sm.tenant_id=s.tenant_id AND sm.set_id=s.id AND sm.set_version=s.version
     WHERE s.tenant_id=? AND ${eligibleSet} ORDER BY s.id,sm.card_id)`;
  const beforeRegistry = await first<{snapshot:string}>(ctx.db,registrySql,ctx.tenant.id,...visibleArgs(ctx));
  const memberIds = await all<{card_id:string}>(ctx.db,`SELECT DISTINCT sm.card_id FROM fb_set_memberships sm JOIN fb_sets s ON s.tenant_id=sm.tenant_id AND s.id=sm.set_id AND s.version=sm.set_version WHERE s.tenant_id=? AND ${eligibleSet} ORDER BY sm.card_id LIMIT 2001`,ctx.tenant.id,...visibleArgs(ctx));
  if (memberIds.length > 2000) throw new ApiError(503,"set_list_overloaded","Too many set members to check safely in one workspace view.");
  const idsJson = JSON.stringify(memberIds.map(row=>row.card_id));
  const beforeAuthority = await first<{snapshot:string}>(ctx.db,snapshotSql,...snapshotArgs(ctx,idsJson));
  const sets = await all<{id:string;slug:string;name:string;description:string;status:string;version:number;published_at:string|null;reward_amount:number|null}>(ctx.db,
    `SELECT s.id,s.slug,s.name,s.description,s.status,s.version,s.published_at,r.reward_amount FROM fb_sets s LEFT JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version WHERE s.tenant_id=? AND ${authority} AND ${eligibleSet} ORDER BY s.name LIMIT 101`,ctx.tenant.id,...authorityArgs(ctx),...visibleArgs(ctx));
  if (sets.length > 100) throw new ApiError(503,"set_list_overloaded","Too many sets to check safely in one workspace view.");
  const setIdsJson = JSON.stringify(sets.map(set=>set.id));
  const counts = await all<{set_id:string;n:number}>(ctx.db,`SELECT sm.set_id,COUNT(*) AS n FROM fb_set_memberships sm JOIN fb_sets s ON s.id=sm.set_id AND s.tenant_id=sm.tenant_id AND s.version=sm.set_version WHERE sm.tenant_id=? AND sm.set_id IN (SELECT value FROM json_each(?)) GROUP BY sm.set_id`,ctx.tenant.id,setIdsJson);
  const cards = await all<{set_id:string;id:string;slug:string;name:string;sort:number}>(ctx.db,`SELECT sm.set_id,cd.id,cd.slug,cd.name,sm.sort FROM fb_set_memberships sm JOIN fb_sets s ON s.id=sm.set_id AND s.tenant_id=sm.tenant_id AND s.version=sm.set_version JOIN fb_card_definitions cd ON cd.id=sm.card_id WHERE sm.tenant_id=? AND sm.set_id IN (SELECT value FROM json_each(?)) AND cd.archived_at IS NULL AND (${liveVisibleCard}) AND ${authority} ORDER BY sm.set_id,sm.sort,cd.name`,ctx.tenant.id,setIdsJson,...visibleArgs(ctx),...authorityArgs(ctx));
  const countBySet = new Map(counts.map(row=>[row.set_id,Number(row.n)]));
  const cardsBySet = new Map<string,Array<{id:string;slug:string;name:string;sort:number}>>();
  for (const {set_id,...card} of cards) { const items=cardsBySet.get(set_id) ?? []; items.push(card); cardsBySet.set(set_id,items); }
  // Output labels are taken from the initial snapshot, never transient rows
  // observed while a grant or roster temporarily changed and changed back.
  const baselineRows = JSON.parse(beforeRegistry?.snapshot ?? "[]") as Array<[string,number,string,string,string,string,number|null,string|null,number|null,string|null]>;
  const baselineCards = new Map<string,{slug:string;name:string}>((JSON.parse(beforeAuthority?.snapshot ?? "{}") as {cards?: Array<[string,string,string|null,string,string]>}).cards?.map(([id,, ,slug,name])=>[id,{slug,name}]) ?? []);
  const baselineSets = new Map(baselineRows.map(([id,version,status,slug,name,description,reward,,,published_at])=>[id,{version,status,slug,name,description,reward,published_at}]));
  const baselineSort = new Map(baselineRows.filter(row=>row[7] !== null).map(row=>[`${row[0]}:${row[7]}`,row[8] ?? 0]));
  const result: SetView[] = [];
  for (const set of sets) {
    const members=cardsBySet.get(set.id) ?? [], baseline=baselineSets.get(set.id);
    if (!baseline || members.length !== (countBySet.get(set.id) ?? 0) || members.some(card=>!baselineCards.has(card.id))) continue;
    result.push({...set,...baseline,cards:members.map(card=>({...card,...baselineCards.get(card.id)!,sort:baselineSort.get(`${set.id}:${card.id}`) ?? 0})),reward_amount:baseline.reward ?? 0});
  }
  await assertAuthority(ctx);
  const afterRegistry = await first<{snapshot:string}>(ctx.db,registrySql,ctx.tenant.id,...visibleArgs(ctx));
  const afterAuthority = await first<{snapshot:string}>(ctx.db,snapshotSql,...snapshotArgs(ctx,idsJson));
  if (!beforeRegistry || !afterRegistry || !beforeAuthority || !afterAuthority || beforeRegistry.snapshot !== afterRegistry.snapshot || beforeAuthority.snapshot !== afterAuthority.snapshot) throw new ApiError(409,"set_changed","Set data or access changed. Reload the workspace.");
  // This final statement is the read authorization point. It prevents a
  // transient grant used during an earlier query from escaping after revocation.
  const finalIds = JSON.stringify(result.map(set=>set.id));
  const permitted = await all<{id:string}>(ctx.db,`SELECT s.id FROM fb_sets s WHERE s.tenant_id=? AND s.id IN (SELECT value FROM json_each(?)) AND ${authority}
    AND NOT EXISTS (SELECT 1 FROM fb_set_memberships sm LEFT JOIN fb_card_definitions cd ON cd.id=sm.card_id AND cd.tenant_id=sm.tenant_id WHERE sm.tenant_id=s.tenant_id AND sm.set_id=s.id AND sm.set_version=s.version AND (cd.id IS NULL OR cd.archived_at IS NOT NULL OR NOT (${liveVisibleCard})))`,ctx.tenant.id,finalIds,...authorityArgs(ctx),...visibleArgs(ctx));
  const allowed = new Set(permitted.map(row=>row.id));
  return result.filter(set=>allowed.has(set.id));
}

export async function changeManagedSet(ctx: Ctx, action: "create" | "members" | "publish", input: {id?:string;slug?:string;name?:string;description?:string;rewardAmount?:number;cardIds?:string[]}) {
  await assertAuthority(ctx);
  if (action === "publish") {
    requireRecentStrongAuth(ctx,30);
    // The verified Access token currently has no verified login-time binding.
    if (ctx.sessionAssurance === "access") throw new ApiError(403,"strong_auth_required","Confirm with a passkey or authenticator code to publish this set.");
  }
  const set = action === "create" ? null : await first<{id:string;version:number;status:string;slug:string;name:string;description:string;reward_amount:number|null}>(ctx.db,"SELECT s.id,s.version,s.status,s.slug,s.name,s.description,r.reward_amount FROM fb_sets s LEFT JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version WHERE s.id=? AND s.tenant_id=?",input.id ?? "",ctx.tenant.id);
  if (action !== "create" && !set) throw new ApiError(404,"set_not_found","That set is not available in this Bot.");
  const rosterSnapshotSql = "SELECT COALESCE(json_group_array(json_array(card_id,sort)),'[]') AS snapshot FROM (SELECT card_id,sort FROM fb_set_memberships WHERE tenant_id=? AND set_id=? AND set_version=? ORDER BY card_id)";
  const rosterBefore = set ? await first<{snapshot:string}>(ctx.db,rosterSnapshotSql,ctx.tenant.id,set.id,set.version) : null;
  const current = set ? await all<{card_id:string}>(ctx.db,"SELECT card_id FROM fb_set_memberships WHERE tenant_id=? AND set_id=? AND set_version=?",ctx.tenant.id,set.id,set.version) : [];
  const proposed = action === "members" ? input.cardIds ?? [] : current.map(c=>c.card_id);
  if (new Set(proposed).size !== proposed.length) throw new ApiError(422,"duplicate_card","A card can appear once in a set.");
  if (proposed.length > 200) throw new ApiError(422,"set_limit","A set can contain at most 200 cards.");
  if (action === "publish" && !proposed.length) throw new ApiError(422,"set_empty","Add cards before publishing a set.");
  const ids = [...new Set([...current.map(c=>c.card_id),...proposed])].sort(), idsJson = JSON.stringify(ids);
  const before = await first<{snapshot:string}>(ctx.db,snapshotSql,...snapshotArgs(ctx,idsJson));
  if (ids.length) {
    const found=await all<{id:string}>(ctx.db,`SELECT cd.id FROM fb_card_definitions cd WHERE cd.tenant_id=? AND cd.archived_at IS NULL AND cd.id IN (SELECT value FROM json_each(?)) AND (${liveVisibleCard}) AND ${authority}`,ctx.tenant.id,idsJson,...visibleArgs(ctx),...authorityArgs(ctx));
    if (found.length !== ids.length) throw new ApiError(404,"set_member_unavailable","One or more set members are unavailable to this account.");
  }
  const id = set?.id ?? newId("set"), now=nowIso(), marker=newId("aud"), nextVersion=set && action === "members" && set.status === "published" ? set.version+1 : set?.version ?? 1;
  const session = authorityArgs(ctx);
  const strongSql = action === "publish" ? `AND (? IN ('passkey','mfa') AND EXISTS (SELECT 1 FROM fb_sessions ss WHERE ss.id=? AND ss.user_id=? AND ss.tenant_id=? AND ss.revoked_at IS NULL AND ss.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ss.assurance=? AND ss.auth_time>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') AND ss.auth_time<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))` : "";
  const strongArgs = action === "publish" ? [ctx.sessionAssurance,ctx.sessionId,ctx.user!.id,ctx.tenant.id,ctx.sessionAssurance] : [];
  const audit = ctx.db.prepare(`INSERT INTO fb_audit_events (id,tenant_id,actor_type,actor_id,represented_user_id,action,object_type,object_id,metadata_json,request_id,created_at)
    SELECT ?,?,'user',?,? ,?,'set',?,?,?,? WHERE ${authority} AND (${snapshotSql})=? ${set ? "AND EXISTS (SELECT 1 FROM fb_sets s LEFT JOIN fb_set_reward_rules r ON r.tenant_id=s.tenant_id AND r.set_id=s.id AND r.set_version=s.version WHERE s.id=? AND s.tenant_id=? AND s.version=? AND s.status=? AND s.slug=? AND s.name=? AND s.description=? AND r.reward_amount IS ?) AND ("+rosterSnapshotSql+")=?" : ""} AND NOT EXISTS (SELECT 1 FROM json_each(?) wanted LEFT JOIN fb_card_definitions cd ON cd.id=wanted.value AND cd.tenant_id=? WHERE cd.id IS NULL OR cd.archived_at IS NOT NULL OR NOT (${liveVisibleCard})) ${strongSql}`)
    .bind(marker,ctx.tenant.id,ctx.user!.id,ctx.user!.id,`set.${action}`,id,JSON.stringify({version:nextVersion}),ctx.requestId,now,...session,...snapshotArgs(ctx,idsJson),before?.snapshot ?? "",...(set ? [set.id,ctx.tenant.id,set.version,set.status,set.slug,set.name,set.description,set.reward_amount,ctx.tenant.id,set.id,set.version,rosterBefore?.snapshot ?? ""] : []),idsJson,ctx.tenant.id,...visibleArgs(ctx),...strongArgs);
  const markerExists = "EXISTS (SELECT 1 FROM fb_audit_events WHERE id = ?)";
  const statements = [audit];
  if (action === "create") {
    const slug=(input.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
    if (!slug || !input.name?.trim()) throw new ApiError(422,"set_invalid","A name and slug are required.");
    statements.push(ctx.db.prepare(`INSERT INTO fb_sets (id,tenant_id,slug,name,description,status,version,created_at) SELECT ?,?,?,?,?,'draft',1,? WHERE ${markerExists}`).bind(id,ctx.tenant.id,slug,input.name.trim(),input.description?.trim() ?? "",now,marker));
    statements.push(ctx.db.prepare(`INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) SELECT ?,?,?,1,?,? WHERE ${markerExists}`).bind(newId("sr"),ctx.tenant.id,id,Math.max(0,Math.floor(input.rewardAmount ?? 0)),now,marker));
  } else if (action === "members" && set) {
    statements.push(ctx.db.prepare(`UPDATE fb_sets SET version=?,status=CASE WHEN status='published' THEN 'draft' ELSE status END WHERE id=? AND tenant_id=? AND ${markerExists}`).bind(nextVersion,id,ctx.tenant.id,marker));
    if (nextVersion !== set.version) statements.push(ctx.db.prepare(`INSERT INTO fb_set_reward_rules (id,tenant_id,set_id,set_version,reward_amount,created_at) SELECT ?,?,?,?,COALESCE((SELECT reward_amount FROM fb_set_reward_rules WHERE tenant_id=? AND set_id=? AND set_version=?),0),? WHERE ${markerExists}`).bind(newId("sr"),ctx.tenant.id,id,nextVersion,ctx.tenant.id,id,set.version,now,marker));
    else statements.push(ctx.db.prepare(`DELETE FROM fb_set_memberships WHERE tenant_id=? AND set_id=? AND set_version=? AND ${markerExists}`).bind(ctx.tenant.id,id,nextVersion,marker));
    for (const [index,cardId] of proposed.entries()) statements.push(ctx.db.prepare(`INSERT INTO fb_set_memberships (id,tenant_id,set_id,set_version,card_id,sort,created_at) SELECT ?,?,?,?,?,?,? WHERE ${markerExists}`).bind(newId("smi"),ctx.tenant.id,id,nextVersion,cardId,index,now,marker));
  } else if (set) statements.push(ctx.db.prepare(`UPDATE fb_sets SET status='published',published_at=? WHERE id=? AND tenant_id=? AND ${markerExists}`).bind(now,id,ctx.tenant.id,marker));
  let results;
  try { results = await ctx.db.batch(statements); } catch (error) { if (String(error).includes("UNIQUE") && action === "create") throw new ApiError(409,"set_exists","That set slug already exists."); throw error; }
  if (!results[0]?.meta.changes) throw new ApiError(409,"set_changed","The set or your access changed. Reload before trying again.");
  let found: SetView | undefined;
  try { found = (await listManagedSets(ctx)).find(item=>item.id===id); }
  catch { throw new ApiError(503,"set_saved_reload_failed","The set was saved, but the workspace could not reload it. Refresh before making another change."); }
  if (!found) throw new ApiError(409,"set_saved_visibility_changed","The set was saved but is no longer visible. Reload your workspace.");
  return found;
}
