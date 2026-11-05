import type { Ctx } from "../context";

/** Inputs originate in the verified Discord handler or the authenticated web
 * context; this predicate rechecks their revocable bindings in the same read. */
export function npcTradeAuthority(ctx: Ctx, userAlias: string, tenantSql: string) {
  const discord = ctx.discordPrincipal;
  if (discord)
    return {
      sql: `EXISTS (SELECT 1 FROM fb_discord_identities d JOIN fb_discord_installations di ON di.tenant_id=d.tenant_id
    JOIN fb_bots active_bot ON active_bot.tenant_id=di.tenant_id AND active_bot.status='active' AND (di.bot_id IS NULL OR di.bot_id=active_bot.id)
    WHERE d.tenant_id=${tenantSql} AND d.user_id=${userAlias}.id AND d.discord_user_id=? AND d.revoked_at IS NULL
      AND di.application_id=? AND di.guild_id=? AND di.active=1 AND di.revoked_at IS NULL AND di.game_enabled=1
      AND json_type(CASE WHEN json_valid(di.channel_allowlist_json) THEN di.channel_allowlist_json ELSE 'null' END)='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(di.channel_allowlist_json) THEN di.channel_allowlist_json ELSE '[]' END) WHERE type<>'text' OR length(value) NOT BETWEEN 15 AND 22 OR value GLOB '*[^0-9]*')
      AND (json_array_length(CASE WHEN json_valid(di.channel_allowlist_json) THEN di.channel_allowlist_json ELSE '[]' END)=0
        OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(di.channel_allowlist_json) THEN di.channel_allowlist_json ELSE '[]' END) WHERE value=?)))`,
      args: [discord.discordUserId, discord.applicationId, discord.guildId, discord.channelId],
    };
  const access =
    ctx.sessionAssurance === "access" && ctx.accessStatus === "linked" ? ctx.accessIdentity : null;
  return {
    sql: `(EXISTS (SELECT 1 FROM fb_sessions s WHERE s.id=? AND s.user_id=${userAlias}.id AND s.tenant_id=${tenantSql} AND s.revoked_at IS NULL AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    OR (?='access' AND ?>unixepoch('now') AND EXISTS (SELECT 1 FROM fb_access_identities ai WHERE ai.user_id=${userAlias}.id AND ai.team_domain=? AND ai.subject=? AND ai.email=? COLLATE NOCASE AND ai.revoked_at IS NULL) AND ${userAlias}.email=? COLLATE NOCASE))`,
    args: [
      ctx.sessionId,
      ctx.sessionAssurance,
      access?.payload.exp ?? 0,
      ctx.config.access.teamDomain,
      access?.subject ?? "",
      access?.email ?? "",
      access?.email ?? "",
    ],
  };
}

/** The current installation must explicitly allow every collection containing
 * either card, and its current channel audience must be wide enough. */
export function npcDiscordScope(
  ctx: Ctx,
  cards: string[] = ["offered.card_id", "requested.card_id"],
) {
  const p = ctx.discordPrincipal;
  if (!p) return { sql: "1=1", args: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM fb_discord_installations di WHERE di.tenant_id=n.tenant_id AND di.application_id=? AND di.guild_id=? AND di.active=1 AND di.revoked_at IS NULL AND di.game_enabled=1 AND (di.bot_id IS NULL OR di.bot_id=b.id)
    AND (di.collection_allowlist_json IS NULL OR (json_type(CASE WHEN json_valid(di.collection_allowlist_json) THEN di.collection_allowlist_json ELSE 'null' END)='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(di.collection_allowlist_json) THEN di.collection_allowlist_json ELSE '[]' END) WHERE type<>'text' OR value='')))
    AND json_type(CASE WHEN json_valid(COALESCE(di.channel_audience_json,'{}')) THEN COALESCE(di.channel_audience_json,'{}') ELSE 'null' END)='object'
    AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(COALESCE(di.channel_audience_json,'{}')) THEN COALESCE(di.channel_audience_json,'{}') ELSE '{}' END) WHERE type<>'text' OR value NOT IN ('public','members','private') OR length(key) NOT BETWEEN 15 AND 22 OR key GLOB '*[^0-9]*')
    AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(COALESCE(di.channel_audience_json,'{}')) THEN COALESCE(di.channel_audience_json,'{}') ELSE '{}' END) GROUP BY key HAVING COUNT(*)>1)
    AND NOT EXISTS (SELECT 1 FROM fb_collection_cards scoped_cc JOIN fb_collections scoped_c ON scoped_c.id=scoped_cc.collection_id
      WHERE scoped_cc.card_id IN (${cards.join(",")})
      AND ((di.collection_allowlist_json IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(di.collection_allowlist_json) THEN di.collection_allowlist_json ELSE '[]' END) WHERE value=scoped_c.id))
        OR (scoped_c.view_audience='members' AND COALESCE((SELECT value FROM json_each(CASE WHEN json_valid(COALESCE(di.channel_audience_json,'{}')) THEN COALESCE(di.channel_audience_json,'{}') ELSE '{}' END) WHERE key=?),'public')='public'))))`,
    args: [p.applicationId, p.guildId, p.channelId],
  };
}
