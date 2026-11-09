import type { APIRoute } from "astro";
import { z } from "zod";
import { buildContext, ApiError, type Ctx } from "../../../../server/context";
import { isTrustedLocalRequest } from "../../../../server/config";
import { first } from "../../../../server/db";
import { apiErrorResponse, readJson, json } from "../../../../server/http";
import { newId, sha256Hex, requestReference } from "../../../../server/ids";
import { findUserByEmail } from "../../../../server/modules/identity";
import { evaluateAchievements, listAchievements } from "../../../../server/modules/achievements";
import { sendAdminGift } from "../../../../server/modules/admin-gifts";

export const prerender = false;

const schema = z.object({
  email: z.string().email().default("player@foilbury.local"),
  collectionSlug: z.string().min(2).max(80).default("danganronpa-three-games"),
  mode: z.enum(["seven", "complete", "reset"]).default("seven"),
  dryRun: z.boolean().default(true),
});

/**
 * Local-only demonstration fixture preparation.
 *
 * This is not available in production: it requires the local environment,
 * the loopback host and the explicit development-login flag. It uses the real
 * administrator gift, inventory, achievement and ledger services. It never
 * changes odds, fabricates a draw, or deletes legitimate history.
 */
async function prepareAlbum(ctx: Ctx, body: z.infer<typeof schema>) {
  if (!ctx.config.devLogin || ctx.config.environment !== "local") {
    throw new ApiError(404, "not_found", "Not found.");
  }
  if (!ctx.user?.platformAdmin) {
    throw new ApiError(
      403,
      "super_admin_required",
      "Use the local platform owner account for the demo fixture.",
    );
  }
  const collection = await first<{ id: string; slug: string; name: string; view_audience: string }>(
    ctx.db,
    "SELECT id, slug, name, view_audience FROM fb_collections WHERE slug = ? AND archived_at IS NULL",
    body.collectionSlug,
  );
  if (!collection)
    throw new ApiError(404, "collection_not_found", "That demo collection does not exist.");
  const target = await findUserByEmail(ctx.db, body.email);
  if (!target)
    throw new ApiError(
      404,
      "demo_user_missing",
      "That local demonstration account does not exist.",
    );
  const membership = await first<{ status: string }>(
    ctx.db,
    "SELECT status FROM fb_memberships WHERE tenant_id = ? AND user_id = ?",
    ctx.tenant.id,
    target.id,
  );
  if (membership?.status !== "active") {
    throw new ApiError(
      422,
      "demo_member_inactive",
      "The demonstration account is not an active member of this Bot.",
    );
  }

  if (body.mode === "reset") {
    const campaigns = await first<{ ids: string | null }>(
      ctx.db,
      `SELECT GROUP_CONCAT(id) AS ids FROM fb_gift_campaigns
        WHERE tenant_id = ? AND reason LIKE 'Foilbury demo album:%'`,
      ctx.tenant.id,
    );
    const ids = (campaigns?.ids ?? "").split(",").filter(Boolean);
    const instances = await first<{ ids: string | null }>(
      ctx.db,
      ids.length
        ? `SELECT GROUP_CONCAT(id) AS ids FROM fb_card_instances
            WHERE tenant_id = ? AND user_id = ? AND acquired_via IN (${ids.map(() => "?").join(",")})`
        : "SELECT NULL AS ids",
      ...(ids.length ? [ctx.tenant.id, target.id, ...ids.map((id) => `gift:${id}`)] : []),
    );
    const instanceIds = (instances?.ids ?? "").split(",").filter(Boolean);
    if (!body.dryRun) {
      if (instanceIds.length) {
        const now = new Date().toISOString();
        await ctx.db.batch(
          instanceIds.flatMap((instanceId) => [
            ctx.db
              .prepare(
                "UPDATE fb_card_instances SET status = 'surrendered', updated_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?",
              )
              .bind(now, instanceId, ctx.tenant.id, target.id),
            ctx.db
              .prepare(
                `INSERT INTO fb_instance_history
                  (id, tenant_id, instance_id, event, from_user_id, to_user_id, reference_type, reference_id, metadata_json, created_at)
                 VALUES (?, ?, ?, 'demo_retired', ?, NULL, 'demo_fixture', NULL, '{"scope":"local demo"}', ?)`,
              )
              .bind(newId("ih"), ctx.tenant.id, instanceId, target.id, now),
          ]),
        );
      }
    }
    return {
      action: "reset",
      dry_run: body.dryRun,
      campaigns: ids.length,
      instances: instanceIds.length,
      note: "Only instances acquired by a Foilbury demo album campaign are retired. Ledger, serials, unlocks and historical rows are preserved.",
    };
  }

  const cards = await ctx.db
    .prepare(
      `SELECT cd.id, cd.name FROM fb_collection_cards cc
         JOIN fb_card_definitions cd ON cd.id = cc.card_id AND cd.status = 'published' AND cd.archived_at IS NULL
        WHERE cc.collection_id = ? ORDER BY cc.sort, cd.name`,
    )
    .bind(collection.id)
    .all<{ id: string; name: string }>();
  const owned = await ctx.db
    .prepare(
      `SELECT DISTINCT ci.card_id FROM fb_card_instances ci
         JOIN fb_collection_cards cc ON cc.card_id = ci.card_id AND cc.collection_id = ?
        WHERE ci.tenant_id = ? AND ci.user_id = ? AND ci.status IN ('owned','reserved')`,
    )
    .bind(collection.id, ctx.tenant.id, target.id)
    .all<{ card_id: string }>();
  const ownedIds = new Set(owned.results.map((row) => row.card_id));
  const wanted = body.mode === "seven" ? 7 : cards.results.length;
  const missing = cards.results.filter((card) => !ownedIds.has(card.id));
  const grants = missing.slice(0, Math.max(0, wanted - ownedIds.size));
  const after = new Set([...ownedIds, ...grants.map((card) => card.id)]);

  if (body.dryRun) {
    return {
      action: "album",
      dry_run: true,
      account: target.email,
      collection: {
        slug: collection.slug,
        name: collection.name,
        audience: collection.view_audience,
      },
      roster: cards.results.map((card) => card.name),
      owned_before: ownedIds.size,
      planned_grants: grants.map((card) => card.name),
      owned_after: after.size,
      target: wanted,
      note: "Dry run only. No card, ledger, achievement or wallet row was written.",
    };
  }

  const demoCtx: Ctx = {
    ...ctx,
    sessionAssurance: "passkey",
    sessionAuthTime: new Date().toISOString(),
  };
  const delivered: Array<{ card: string; status: string; replayed?: boolean }> = [];
  for (const card of grants) {
    const key = `demo-album:${collection.id}:${target.id}:${card.id}`;
    const gift = await sendAdminGift(demoCtx, {
      kind: "card",
      scope: "single",
      userIds: [target.id],
      botId: null,
      cardId: card.id,
      message: "Local Foilbury album demonstration. Clearly labelled fixture grant.",
      reason: `Foilbury demo album: ${collection.slug}`,
      idempotency: { key, digest: await sha256Hex(key) },
    });
    const giftStatus = "status" in gift ? gift.status : "replayed";
    delivered.push({ card: card.name, status: giftStatus, replayed: Boolean(gift.replayed) });
  }

  const targetCtx: Ctx = {
    ...ctx,
    user: {
      id: target.id,
      email: target.email,
      displayName: "Demo collector",
      role: "player",
      platformAdmin: false,
      emailVerified: true,
      capabilities: [],
    },
    actor: { type: "user", id: target.id, representedUserId: target.id, label: "Demo collector" },
    sessionId: null,
    sessionAssurance: null,
    sessionAuthTime: null,
    accessIdentity: null,
    accessStatus: null,
  };
  await evaluateAchievements(targetCtx, { userId: target.id });
  const achievements = (await listAchievements(targetCtx, target.id))
    .filter((item) => item.criteria.collection_id === collection.id)
    .map((item) => ({
      key: item.key,
      name: item.name,
      state: item.state,
      progress: item.progress,
      target: item.target,
      reward_amount: item.reward_amount,
      reward_state: item.reward_state,
    }));
  return {
    action: "album",
    dry_run: false,
    account: target.email,
    collection: {
      slug: collection.slug,
      name: collection.name,
      audience: collection.view_audience,
    },
    owned_before: ownedIds.size,
    owned_after: after.size,
    delivered,
    achievements,
    note: "Grants used the administrator gift service. Ledger and achievement rewards remain authoritative.",
  };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const ctx = await buildContext(request);
    if (!isTrustedLocalRequest(request, ctx.config))
      throw new ApiError(404, "not_found", "Not found.");
    const body = await readJson(request, schema);
    return json(await prepareAlbum(ctx, body));
  } catch (error) {
    return apiErrorResponse(error, requestReference(request));
  }
};
