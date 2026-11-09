// Must match migration 0035 exactly; a missing or changed trigger fails closed.
export const BOUND_LINEAGE_TRIGGER_DEFINITIONS: ReadonlyArray<readonly [string,string]> = [
  [
    "bound_lineage_fb_print_proposals_insert",
    "CREATE TRIGGER bound_lineage_fb_print_proposals_insert AFTER INSERT ON fb_print_proposals BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_print_proposals_update",
    "CREATE TRIGGER bound_lineage_fb_print_proposals_update AFTER UPDATE ON fb_print_proposals BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_print_proposals_delete",
    "CREATE TRIGGER bound_lineage_fb_print_proposals_delete AFTER DELETE ON fb_print_proposals BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_variant_back_renders_insert",
    "CREATE TRIGGER bound_lineage_fb_variant_back_renders_insert AFTER INSERT ON fb_variant_back_renders BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_variant_back_renders_update",
    "CREATE TRIGGER bound_lineage_fb_variant_back_renders_update AFTER UPDATE ON fb_variant_back_renders BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_variant_back_renders_delete",
    "CREATE TRIGGER bound_lineage_fb_variant_back_renders_delete AFTER DELETE ON fb_variant_back_renders BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_asset_derivatives_insert",
    "CREATE TRIGGER bound_lineage_fb_asset_derivatives_insert AFTER INSERT ON fb_asset_derivatives BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_asset_derivatives_update",
    "CREATE TRIGGER bound_lineage_fb_asset_derivatives_update AFTER UPDATE ON fb_asset_derivatives BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_asset_derivatives_delete",
    "CREATE TRIGGER bound_lineage_fb_asset_derivatives_delete AFTER DELETE ON fb_asset_derivatives BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_url_refs_insert",
    "CREATE TRIGGER bound_lineage_fb_brand_url_refs_insert AFTER INSERT ON fb_brand_url_refs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_url_refs_update",
    "CREATE TRIGGER bound_lineage_fb_brand_url_refs_update AFTER UPDATE ON fb_brand_url_refs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_url_refs_delete",
    "CREATE TRIGGER bound_lineage_fb_brand_url_refs_delete AFTER DELETE ON fb_brand_url_refs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_url_dirty_insert",
    "CREATE TRIGGER bound_lineage_fb_brand_url_dirty_insert AFTER INSERT ON fb_brand_url_dirty BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_url_dirty_update",
    "CREATE TRIGGER bound_lineage_fb_brand_url_dirty_update AFTER UPDATE ON fb_brand_url_dirty BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_url_dirty_delete",
    "CREATE TRIGGER bound_lineage_fb_brand_url_dirty_delete AFTER DELETE ON fb_brand_url_dirty BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_index_rebuilds_insert",
    "CREATE TRIGGER bound_lineage_fb_brand_index_rebuilds_insert AFTER INSERT ON fb_brand_index_rebuilds BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_index_rebuilds_update",
    "CREATE TRIGGER bound_lineage_fb_brand_index_rebuilds_update AFTER UPDATE ON fb_brand_index_rebuilds BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_brand_index_rebuilds_delete",
    "CREATE TRIGGER bound_lineage_fb_brand_index_rebuilds_delete AFTER DELETE ON fb_brand_index_rebuilds BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_bound_render_outputs_insert",
    "CREATE TRIGGER bound_lineage_fb_bound_render_outputs_insert AFTER INSERT ON fb_bound_render_outputs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_bound_render_outputs_update",
    "CREATE TRIGGER bound_lineage_fb_bound_render_outputs_update AFTER UPDATE ON fb_bound_render_outputs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "bound_lineage_fb_bound_render_outputs_delete",
    "CREATE TRIGGER bound_lineage_fb_bound_render_outputs_delete AFTER DELETE ON fb_bound_render_outputs BEGIN UPDATE fb_bound_lineage_epoch SET revision=revision+1 WHERE id=1; END"
  ]
];
