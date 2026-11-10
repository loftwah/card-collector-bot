import { ApiError, requireRecentStrongAuth, type Ctx } from "../context";
import { all, nowIso, statement } from "../db";
import { auditStatement } from "../http";
import {
  BRAND_ASSETS,
  BRAND_GROUPS,
  brandAssetByPath,
  brandAssetByStyle,
  brandAssetsForKind,
  type BrandAsset,
  type BrandKind,
  type BrandSelections,
  type BrandSlot,
} from "../../lib/brand-catalogue";
import { CARD_STYLES, DEFAULT_CARD_STYLES, normalizeCardStyleKeys } from "../../lib/card-styles";

export interface BrandCatalogueView {
  groups: Array<{
    kind: BrandKind;
    label: string;
    note: string;
    slot: BrandSlot | null;
    assets: BrandAsset[];
  }>;
  selections: BrandSelections;
  can_select: boolean;
}

const DEFAULT_SELECTIONS: BrandSelections = {
  favicon: "/brand/mark.svg",
  og_image: "/brand/social-preview.jpg",
  banner: "/brand/kit/banners/foil-standard-1920x1080.png",
  card_style: DEFAULT_CARD_STYLES[0] ?? "atelier",
};

const SLOTS: BrandSlot[] = ["favicon", "og_image", "banner", "card_style"];

interface SelectionRow {
  slot: BrandSlot;
  asset_path: string;
}

/**
 * Read the selected brand asset for each real consumer. A missing table (an
 * older local database before migration 0034) falls back to the shipped
 * defaults; it never blocks the site.
 */
export async function readBrandSelections(ctx: Ctx): Promise<BrandSelections> {
  try {
    const rows = await all<SelectionRow>(
      ctx.db,
      "SELECT slot, asset_path FROM fb_brand_selections",
    );
    const selections = { ...DEFAULT_SELECTIONS };
    for (const row of rows) {
      if (!SLOTS.includes(row.slot)) continue;
      if (row.slot === "card_style") {
        const key = normalizeCardStyleKeys([row.asset_path])[0];
        if (key) selections.card_style = key;
        continue;
      }
      const asset = BRAND_ASSETS.find(
        (entry) => entry.path === row.asset_path && entry.slot === row.slot,
      );
      if (asset) selections[row.slot] = asset.path;
    }
    return selections;
  } catch {
    return { ...DEFAULT_SELECTIONS };
  }
}

export function brandSelectionFor(selections: BrandSelections, slot: BrandSlot): BrandAsset | null {
  if (slot === "card_style") {
    const style = CARD_STYLES.find((entry) => entry.key === selections.card_style);
    return style ? (brandAssetByStyle(style.key) ?? null) : null;
  }
  return brandAssetByPath(selections[slot]);
}

export async function getBrandCatalogue(ctx: Ctx): Promise<BrandCatalogueView> {
  if (!ctx.user?.platformAdmin) {
    throw new ApiError(
      403,
      "brand_catalogue_forbidden",
      "Brand art is the provisioned Super Admin surface.",
    );
  }
  const selections = await readBrandSelections(ctx);
  return {
    groups: BRAND_GROUPS.map((group) => ({
      ...group,
      assets: brandAssetsForKind(group.kind),
    })),
    selections,
    can_select: Boolean(ctx.user.platformAdmin && ctx.actor.type === "user"),
  };
}

export async function setBrandSelection(
  ctx: Ctx,
  input: { slot: string; path: string },
): Promise<BrandCatalogueView> {
  if (!ctx.user?.platformAdmin) {
    throw new ApiError(
      403,
      "brand_selection_forbidden",
      "Only the provisioned Super Admin can select brand art.",
    );
  }
  if (ctx.actor.type !== "user") {
    throw new ApiError(
      403,
      "brand_selection_forbidden",
      "Brand selection requires a signed-in Super Admin session.",
    );
  }
  requireRecentStrongAuth(ctx, 30);
  const slot = input.slot as BrandSlot;
  if (!SLOTS.includes(slot)) {
    throw new ApiError(422, "brand_slot_invalid", "Choose a real brand slot.");
  }
  const asset = BRAND_ASSETS.find((entry) => entry.path === input.path && entry.slot === slot);
  if (!asset) {
    throw new ApiError(
      422,
      "brand_asset_invalid",
      "That file is not a selectable asset for this slot.",
    );
  }
  const now = nowIso();
  const storedPath =
    slot === "card_style"
      ? asset.id.startsWith("style-")
        ? asset.id.slice(6)
        : asset.path
      : asset.path;
  await ctx.db.batch([
    statement(
      ctx.db,
      `INSERT INTO fb_brand_selections (slot, asset_path, label, kind, width, height, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         asset_path = excluded.asset_path, label = excluded.label, kind = excluded.kind,
         width = excluded.width, height = excluded.height,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      slot,
      storedPath,
      asset.label,
      asset.kind,
      asset.width,
      asset.height,
      ctx.user.id,
      now,
    ),
    auditStatement(ctx, "brand.selection.updated", "brand_selection", slot, {
      slot,
      path: asset.path,
      stored_value: storedPath,
      label: asset.label,
      kind: asset.kind,
      // The favicon and Open Graph image are public surfaces; record the
      // audience so the audit trail is not ambiguous.
      audience: slot === "favicon" || slot === "og_image" ? "public" : "brand",
    }),
  ]);
  return getBrandCatalogue(ctx);
}

/** The Art Lab default when a brief does not choose a style explicitly. */
export async function defaultCardStyle(ctx: Ctx): Promise<string> {
  const selections = await readBrandSelections(ctx);
  const keys = normalizeCardStyleKeys([selections.card_style]);
  return keys[0] ?? "atelier";
}
