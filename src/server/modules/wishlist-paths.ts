import { ApiError, type Ctx } from "../context";
import { liveViewerContext } from "./live-viewer";
import { getPoolPreview, listPools, type PoolPreview } from "./pools";

export interface WishTarget {
  card_id: string;
  target_variant_id: string | null;
  target_material_key: string | null;
  target_effect_key: string | null;
}

/** Limit concurrent preview work while retaining input order and failures. */
export async function mapPoolPreviews<T, R>(items: T[], preview: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    results.push(...await Promise.all(items.slice(offset, offset + 4).map(preview)));
  }
  return results;
}

/** Use the same player eligibility and odds inputs as the draw room. */
export async function wishlistAcquisitionPaths(ctx: Ctx, wishes: WishTarget[]) {
  if (!wishes.length) return new Map<string, Array<{ slug: string; name: string; price: number }>>();
  const viewer = ctx.user && await liveViewerContext(ctx, ctx.user.id);
  if (!viewer) throw new ApiError(403, "membership_required", "Your access to this Bot has changed.");
  // Fail the lookup rather than equating a failed preview with no eligible
  // capsule; bound concurrent work without changing visible ordering.
  const previews = await mapPoolPreviews(await listPools(viewer), (pool) => getPoolPreview(viewer, pool.slug));
  const pools: PoolPreview[] = previews.filter((preview) => preview.eligible_count > 0);
  return new Map(wishes.map((wish) => [wish.card_id, pools
    .filter((preview) => preview.entries.some((entry) => entry.card_id === wish.card_id &&
      (!wish.target_variant_id || entry.variant_id === wish.target_variant_id) &&
      (!wish.target_material_key || entry.material_key === wish.target_material_key) &&
      (!wish.target_effect_key || entry.effect_key === wish.target_effect_key)))
    .map(({ pool }) => ({ slug: pool.slug, name: pool.name, price: pool.price }))]));
}
