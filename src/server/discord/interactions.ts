import { nowIso } from "../db";
import type { DiscordEnv, DiscordInteraction } from "./types";

type Visibility = "private" | "public" | "private_fallback";

function interactionName(interaction: DiscordInteraction): string {
  if (interaction.type === 3) return interaction.data?.custom_id?.slice(0, 80) ?? "component";
  return interaction.data?.name ?? "unknown";
}

/** Test-only attempt logging prototype. Failure to log must not start a draw
 * twice or let an unowned attempt mutate the parent projection. */
export async function recordInteractionStart(env: DiscordEnv, interaction: DiscordInteraction): Promise<string | null> {
  const attemptId=crypto.randomUUID(), now=nowIso();
  const actor=interaction.member?.user?.id ?? interaction.user?.id ?? "";
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO fb_discord_interaction_attempts
        (attempt_id,interaction_id,application_id,guild_id,discord_user_id,started_at,status)
        VALUES (?,?,?,?,?,?,'processing')`).bind(attemptId,interaction.id,interaction.application_id,interaction.guild_id??null,actor,now),
      env.DB.prepare(`INSERT INTO fb_discord_interactions
        (interaction_id,application_id,guild_id,channel_id,discord_user_id,command_name,status,created_at,current_attempt_id)
        VALUES (?,?,?,?,?,?,'processing',?,?)
        ON CONFLICT(interaction_id) DO UPDATE SET status='processing',error_code=NULL,completed_at=NULL,delivery_visibility=NULL,current_attempt_id=excluded.current_attempt_id
        WHERE fb_discord_interactions.application_id=excluded.application_id
          AND fb_discord_interactions.guild_id IS excluded.guild_id
          AND fb_discord_interactions.channel_id IS excluded.channel_id
          AND fb_discord_interactions.discord_user_id IS excluded.discord_user_id
          AND NOT EXISTS (SELECT 1 FROM fb_draws d
            JOIN fb_discord_installations i ON i.tenant_id=d.tenant_id AND i.application_id=excluded.application_id AND i.guild_id=excluded.guild_id
            JOIN fb_discord_identities di ON di.tenant_id=d.tenant_id AND di.user_id=d.user_id AND di.discord_user_id=excluded.discord_user_id
            WHERE d.idempotency_key='discord:' || excluded.interaction_id || ':open')`)
        .bind(interaction.id,interaction.application_id,interaction.guild_id??null,interaction.channel_id??null,actor,interactionName(interaction),now,attemptId),
    ]);
    return attemptId;
  } catch { return null; }
}

export async function recordInteractionFinish(env: DiscordEnv, interactionId: string, status: "completed" | "failed", errorCode?: string, attemptId?: string | null, visibility?: Visibility): Promise<void> {
  if (!attemptId) return;
  const now=nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE fb_discord_interaction_attempts SET status=?,error_code=?,delivery_visibility=?,finished_at=?
        WHERE attempt_id=? AND interaction_id=? AND status='processing'`).bind(status,errorCode??null,visibility??null,now,attemptId,interactionId),
      env.DB.prepare(`UPDATE fb_discord_interactions SET status=CASE WHEN EXISTS (
        SELECT 1 FROM fb_draws d WHERE d.idempotency_key='discord:' || fb_discord_interactions.interaction_id || ':open'
          AND EXISTS (SELECT 1 FROM fb_discord_installations i WHERE i.tenant_id=d.tenant_id AND i.application_id=fb_discord_interactions.application_id AND i.guild_id=fb_discord_interactions.guild_id)
          AND EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=d.tenant_id AND di.user_id=d.user_id AND di.discord_user_id=fb_discord_interactions.discord_user_id)
        ) THEN 'completed' ELSE ? END,error_code=?,delivery_visibility=?,completed_at=?
        WHERE interaction_id=? AND current_attempt_id=? AND status='processing' AND changes()=1`)
        .bind(status,errorCode??null,visibility??null,now,interactionId,attemptId),
      // An expired/stale execution can still have committed. Its own attempt
      // remains immutable, while the aggregate must not claim a failed draw.
      env.DB.prepare(`UPDATE fb_discord_interactions SET status='completed',error_code='late_commit_reconciled',completed_at=?
        WHERE interaction_id=? AND status='failed'
          AND EXISTS (SELECT 1 FROM fb_discord_interaction_attempts a WHERE a.attempt_id=? AND a.interaction_id=fb_discord_interactions.interaction_id
            AND a.application_id=fb_discord_interactions.application_id AND a.guild_id IS fb_discord_interactions.guild_id AND a.discord_user_id=fb_discord_interactions.discord_user_id)
          AND EXISTS (SELECT 1 FROM fb_draws d WHERE d.idempotency_key='discord:' || fb_discord_interactions.interaction_id || ':open'
            AND EXISTS (SELECT 1 FROM fb_discord_installations i WHERE i.tenant_id=d.tenant_id AND i.application_id=fb_discord_interactions.application_id AND i.guild_id=fb_discord_interactions.guild_id)
            AND EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=d.tenant_id AND di.user_id=d.user_id AND di.discord_user_id=fb_discord_interactions.discord_user_id))`)
        .bind(now,interactionId,attemptId),
    ]);
  } catch { /* operational logging is best-effort */ }
}

export async function abandonInteraction(env: DiscordEnv, interactionId: string, attemptId?: string | null): Promise<void> {
  await recordInteractionFinish(env,interactionId,"failed","workflow_cancelled",attemptId);
}

/** Scan one indexed page against a fixed cycle high-water mark. CAS protects
 * concurrent passes; a finite cycle revisits late commits behind the cursor. */
export async function reconcileTimedOutDraws(db: DiscordEnv['DB'], mayWrap=true): Promise<number> {
  const cursor=await db.prepare('SELECT completed_at,interaction_id,high_completed_at,high_interaction_id,generation FROM fb_discord_timeout_reconcile_cursor WHERE id=1').first<{completed_at:string;interaction_id:string;high_completed_at:string;high_interaction_id:string;generation:number}>();
  if(!cursor) throw new Error('Discord timeout reconciliation cursor is missing');
  const high=cursor.high_completed_at ? {completed_at:cursor.high_completed_at,interaction_id:cursor.high_interaction_id}
    : await db.prepare(`SELECT interaction_id,completed_at FROM fb_discord_interactions WHERE status='failed' AND error_code='delivery_timeout' AND completed_at IS NOT NULL ORDER BY completed_at DESC,interaction_id DESC LIMIT 1`).first<{interaction_id:string;completed_at:string}>();
  if(!high) return 0;
  const page=await db.prepare(`SELECT interaction_id,completed_at FROM fb_discord_interactions
    WHERE status='failed' AND error_code='delivery_timeout' AND completed_at IS NOT NULL
      AND (completed_at>? OR (completed_at=? AND interaction_id>?))
      AND (completed_at<? OR (completed_at=? AND interaction_id<=?))
    ORDER BY completed_at,interaction_id LIMIT 50`).bind(cursor.completed_at,cursor.completed_at,cursor.interaction_id,high.completed_at,high.completed_at,high.interaction_id)
    .all<{interaction_id:string;completed_at:string}>();
  const rows=page.results??[],last=rows.at(-1);
  const cycleDone=!last || (last.completed_at===high.completed_at && last.interaction_id===high.interaction_id);
  const nextAt=cycleDone?'':last!.completed_at,nextId=cycleDone?'':last!.interaction_id;
  const nextHighAt=cycleDone?'':high.completed_at,nextHighId=cycleDone?'':high.interaction_id;
  try {
    const result=await db.batch([
      db.prepare(`UPDATE fb_discord_timeout_reconcile_cursor SET completed_at=?,interaction_id=?,high_completed_at=?,high_interaction_id=?,generation=generation+1
        WHERE id=1 AND generation=? AND completed_at=? AND interaction_id=? AND high_completed_at=? AND high_interaction_id=?`)
        .bind(nextAt,nextId,nextHighAt,nextHighId,cursor.generation,cursor.completed_at,cursor.interaction_id,cursor.high_completed_at,cursor.high_interaction_id),
      db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('discord_cursor_race') END"),
      db.prepare(`UPDATE fb_discord_interactions SET status='completed',error_code='late_commit_reconciled',completed_at=?
        WHERE status='failed' AND error_code='delivery_timeout' AND interaction_id IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM fb_discord_installations i
            JOIN fb_discord_identities di ON di.tenant_id=i.tenant_id AND di.discord_user_id=fb_discord_interactions.discord_user_id
            JOIN fb_draws d ON d.tenant_id=i.tenant_id AND d.user_id=di.user_id AND d.idempotency_key='discord:' || fb_discord_interactions.interaction_id || ':open'
            WHERE i.application_id=fb_discord_interactions.application_id AND i.guild_id=fb_discord_interactions.guild_id)`)
        .bind(nowIso(),JSON.stringify(rows.map(row=>row.interaction_id))),
    ]);
    const changed=result[2]?.meta.changes??0;
    if(!last && mayWrap && (cursor.completed_at!=='' || cursor.interaction_id!==''))
      return changed+await reconcileTimedOutDraws(db,false);
    return changed;
  } catch(error) {
    if(String(error).includes('malformed JSON')) return 0; // another pass advanced the same cursor
    throw error;
  }
}

/** Expire each attempt once. A late finalizer cannot rewrite its outcome. */
export async function expireStaleDiscordInteractions(db: DiscordEnv["DB"], olderThanMinutes=10): Promise<number> {
  const now=nowIso(), cutoff=new Date(Date.now()-olderThanMinutes*60_000).toISOString(), expiryBatch=crypto.randomUUID();
  const results=await db.batch([
    db.prepare(`UPDATE fb_discord_interaction_attempts SET status='expired',error_code='delivery_timeout',finished_at=?,expiry_batch_id=?
      WHERE attempt_id IN (SELECT attempt_id FROM fb_discord_interaction_attempts WHERE status='processing' AND started_at<? ORDER BY started_at,attempt_id LIMIT 50)`).bind(now,expiryBatch,cutoff),
    db.prepare(`UPDATE fb_discord_interactions SET status=CASE WHEN EXISTS (
      SELECT 1 FROM fb_draws d WHERE d.idempotency_key='discord:' || fb_discord_interactions.interaction_id || ':open'
        AND EXISTS (SELECT 1 FROM fb_discord_installations i WHERE i.tenant_id=d.tenant_id AND i.application_id=fb_discord_interactions.application_id AND i.guild_id=fb_discord_interactions.guild_id)
        AND EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=d.tenant_id AND di.user_id=d.user_id AND di.discord_user_id=fb_discord_interactions.discord_user_id)
      ) THEN 'completed' ELSE 'failed' END,error_code='delivery_timeout',completed_at=?
      WHERE status='processing' AND current_attempt_id IN (SELECT attempt_id FROM fb_discord_interaction_attempts
        WHERE status='expired' AND expiry_batch_id=?)`).bind(now,expiryBatch),
    db.prepare(`UPDATE fb_discord_interactions SET status=CASE WHEN EXISTS (
      SELECT 1 FROM fb_draws d WHERE d.idempotency_key='discord:' || fb_discord_interactions.interaction_id || ':open'
        AND EXISTS (SELECT 1 FROM fb_discord_installations i WHERE i.tenant_id=d.tenant_id AND i.application_id=fb_discord_interactions.application_id AND i.guild_id=fb_discord_interactions.guild_id)
        AND EXISTS (SELECT 1 FROM fb_discord_identities di WHERE di.tenant_id=d.tenant_id AND di.user_id=d.user_id AND di.discord_user_id=fb_discord_interactions.discord_user_id)
      ) THEN 'completed' ELSE 'failed' END,error_code='delivery_timeout',completed_at=?
      WHERE interaction_id IN (SELECT interaction_id FROM fb_discord_interactions WHERE status='processing' AND current_attempt_id IS NULL AND created_at<? ORDER BY created_at,interaction_id LIMIT 50)`).bind(now,cutoff),
  ]);
  return (results[0]?.meta.changes ?? 0)+(results[2]?.meta.changes ?? 0)+await reconcileTimedOutDraws(db);
}
