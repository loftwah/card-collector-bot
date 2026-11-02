import type { Ctx } from "./context";
import { buildContext } from "./context";
import { first } from "./db";
import type { CardView } from "./modules/catalogue";

export async function pageContext(request: Request): Promise<Ctx> {
  return buildContext(request);
}

export async function publicStats(ctx: Ctx) {
  const [cards, variants, instances, sources, sets, release] = await Promise.all([
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_card_definitions WHERE tenant_id = ? AND status = 'published'", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_variants WHERE tenant_id = ? AND status = 'published'", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_card_instances WHERE tenant_id = ?", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(DISTINCT source_repo) AS count FROM fb_assets WHERE tenant_id = ? AND source_repo IS NOT NULL", ctx.tenant.id),
    first<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM fb_sets WHERE tenant_id = ? AND status = 'published'", ctx.tenant.id),
    first<{ version: number; checksum: string; published_at: string }>(
      ctx.db,
      "SELECT version, checksum, published_at FROM fb_catalogue_releases WHERE tenant_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
      ctx.tenant.id,
    ),
  ]);
  return {
    cards: cards?.count ?? 0,
    variants: variants?.count ?? 0,
    instances: instances?.count ?? 0,
    sources: sources?.count ?? 0,
    sets: sets?.count ?? 0,
    release: release ?? null,
  };
}

export function pickVariant(card: CardView, material: string, effect?: string) {
  const variants = card.editions.flatMap((edition) => edition.variants);
  return (
    variants.find((variant) => variant.material_key === material && (effect ? variant.effect_key === effect : variant.effect_key === "none" || !variant.effect_key)) ??
    variants.find((variant) => variant.render_url) ??
    variants[0] ??
    null
  );
}
