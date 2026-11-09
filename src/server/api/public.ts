import type { CardView } from "../modules/catalogue";

/** The public surface never exposes private asset IDs or source-checkout metadata. */
export function publicCard(card: CardView) {
  return {
    id: card.id,
    slug: card.slug,
    name: card.name,
    subtitle: card.subtitle,
    description: card.description,
    bio: card.bio,
    bio_safe: card.bio_safe,
    quote: card.quote,
    spoiler_level: card.spoiler_level,
    attributes: (() => {
      try {
        return JSON.parse(card.attributes_json ?? "[]") as Array<Record<string, unknown>>;
      } catch {
        return [];
      }
    })(),
    source_work: card.source_work,
    review_status: card.review_status,
    class: card.class ? { key: card.class.key, name: card.class.name } : null,
    category: card.category ? { slug: card.category.slug, name: card.category.name } : null,
    rarity: card.rarity
      ? { key: card.rarity.key, name: card.rarity.name, tone: card.rarity.tone }
      : null,
    tags: card.tags.map((tag) => ({ slug: tag.slug, name: tag.name })),
    collections: card.collections.map(({ slug, name, scope, logo_url, accent, view_audience }) => ({
      slug,
      name,
      scope,
      logo_url,
      accent,
      view_audience,
    })),
    card_back_url: card.card_back_url,
    editions: card.editions
      .filter((edition) => edition.status === "published")
      .map((edition) => ({
        id: edition.id,
        name: edition.name,
        variants: edition.variants
          .filter((variant) => variant.status === "published")
          .map((variant) => ({
            id: variant.id,
            name: variant.name,
            material_key: variant.material_key,
            effect_key: variant.effect_key,
            render_url: variant.render_url,
            back_render_url: variant.back_render_url,
            thumbnail_url: variant.thumbnail_url,
            preview_url: variant.preview_url,
          })),
      }))
      .filter((edition) => edition.variants.length > 0),
    sets: card.sets.map((set) => ({ slug: set.slug, name: set.name, version: set.version })),
  };
}

export function publicSet(set: {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  published_at: string | null;
  reward_amount: number;
  cards: Array<{ id: string; slug: string; name: string; sort: number }>;
  progress?: { owned: number; total: number; complete: boolean | null; claimed: boolean | null };
}) {
  return {
    id: set.id,
    slug: set.slug,
    name: set.name,
    description: set.description,
    version: set.version,
    published_at: set.published_at,
    reward_amount: set.reward_amount,
    cards: set.cards.map(({ slug, name }) => ({ slug, name })),
    progress: set.progress,
    progress_scope: set.progress ? "visible" : undefined,
  };
}
