// Exact 0033 trigger definitions. Regenerate alongside any deliberate epoch schema migration.
export const DRAW_EPOCH_TRIGGER_DEFINITIONS: ReadonlyArray<readonly [string, string]> = [
  [
    "draw_epoch_fb_collections_insert",
    "CREATE TRIGGER draw_epoch_fb_collections_insert AFTER INSERT ON fb_collections BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_collections_update",
    "CREATE TRIGGER draw_epoch_fb_collections_update AFTER UPDATE ON fb_collections BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_collections_delete",
    "CREATE TRIGGER draw_epoch_fb_collections_delete AFTER DELETE ON fb_collections BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_collection_cards_insert",
    "CREATE TRIGGER draw_epoch_fb_collection_cards_insert AFTER INSERT ON fb_collection_cards BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_collection_cards_update",
    "CREATE TRIGGER draw_epoch_fb_collection_cards_update AFTER UPDATE ON fb_collection_cards BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_collection_cards_delete",
    "CREATE TRIGGER draw_epoch_fb_collection_cards_delete AFTER DELETE ON fb_collection_cards BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_bot_collections_insert",
    "CREATE TRIGGER draw_epoch_fb_bot_collections_insert AFTER INSERT ON fb_bot_collections BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_bot_collections_update",
    "CREATE TRIGGER draw_epoch_fb_bot_collections_update AFTER UPDATE ON fb_bot_collections BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_bot_collections_delete",
    "CREATE TRIGGER draw_epoch_fb_bot_collections_delete AFTER DELETE ON fb_bot_collections BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_card_definitions_insert",
    "CREATE TRIGGER draw_epoch_fb_card_definitions_insert AFTER INSERT ON fb_card_definitions BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_card_definitions_update",
    "CREATE TRIGGER draw_epoch_fb_card_definitions_update AFTER UPDATE ON fb_card_definitions BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_card_definitions_delete",
    "CREATE TRIGGER draw_epoch_fb_card_definitions_delete AFTER DELETE ON fb_card_definitions BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_variants_insert",
    "CREATE TRIGGER draw_epoch_fb_variants_insert AFTER INSERT ON fb_variants BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_variants_update",
    "CREATE TRIGGER draw_epoch_fb_variants_update AFTER UPDATE ON fb_variants BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_variants_delete",
    "CREATE TRIGGER draw_epoch_fb_variants_delete AFTER DELETE ON fb_variants BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_artwork_editions_insert",
    "CREATE TRIGGER draw_epoch_fb_artwork_editions_insert AFTER INSERT ON fb_artwork_editions BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_artwork_editions_update",
    "CREATE TRIGGER draw_epoch_fb_artwork_editions_update AFTER UPDATE ON fb_artwork_editions BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_artwork_editions_delete",
    "CREATE TRIGGER draw_epoch_fb_artwork_editions_delete AFTER DELETE ON fb_artwork_editions BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_assets_insert",
    "CREATE TRIGGER draw_epoch_fb_assets_insert AFTER INSERT ON fb_assets BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_assets_update",
    "CREATE TRIGGER draw_epoch_fb_assets_update AFTER UPDATE ON fb_assets BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_assets_delete",
    "CREATE TRIGGER draw_epoch_fb_assets_delete AFTER DELETE ON fb_assets BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_materials_insert",
    "CREATE TRIGGER draw_epoch_fb_materials_insert AFTER INSERT ON fb_materials BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_materials_update",
    "CREATE TRIGGER draw_epoch_fb_materials_update AFTER UPDATE ON fb_materials BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_materials_delete",
    "CREATE TRIGGER draw_epoch_fb_materials_delete AFTER DELETE ON fb_materials BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_effects_insert",
    "CREATE TRIGGER draw_epoch_fb_effects_insert AFTER INSERT ON fb_effects BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_effects_update",
    "CREATE TRIGGER draw_epoch_fb_effects_update AFTER UPDATE ON fb_effects BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_effects_delete",
    "CREATE TRIGGER draw_epoch_fb_effects_delete AFTER DELETE ON fb_effects BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_variant_renders_insert",
    "CREATE TRIGGER draw_epoch_fb_variant_renders_insert AFTER INSERT ON fb_variant_renders BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_variant_renders_update",
    "CREATE TRIGGER draw_epoch_fb_variant_renders_update AFTER UPDATE ON fb_variant_renders BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_variant_renders_delete",
    "CREATE TRIGGER draw_epoch_fb_variant_renders_delete AFTER DELETE ON fb_variant_renders BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_card_tags_insert",
    "CREATE TRIGGER draw_epoch_fb_card_tags_insert AFTER INSERT ON fb_card_tags BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_card_tags_update",
    "CREATE TRIGGER draw_epoch_fb_card_tags_update AFTER UPDATE ON fb_card_tags BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_card_tags_delete",
    "CREATE TRIGGER draw_epoch_fb_card_tags_delete AFTER DELETE ON fb_card_tags BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_tags_insert",
    "CREATE TRIGGER draw_epoch_fb_tags_insert AFTER INSERT ON fb_tags BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_tags_update",
    "CREATE TRIGGER draw_epoch_fb_tags_update AFTER UPDATE ON fb_tags BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_tags_delete",
    "CREATE TRIGGER draw_epoch_fb_tags_delete AFTER DELETE ON fb_tags BEGIN UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_memberships_insert",
    "CREATE TRIGGER draw_epoch_fb_memberships_insert AFTER INSERT ON fb_memberships BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_memberships_update",
    "CREATE TRIGGER draw_epoch_fb_memberships_update AFTER UPDATE ON fb_memberships\nWHEN OLD.tenant_id IS NOT NEW.tenant_id OR OLD.user_id IS NOT NEW.user_id OR OLD.role IS NOT NEW.role\n  OR OLD.status IS NOT NEW.status OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.capabilities_json IS NOT NEW.capabilities_json\nBEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_memberships_delete",
    "CREATE TRIGGER draw_epoch_fb_memberships_delete AFTER DELETE ON fb_memberships BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_collection_viewers_insert",
    "CREATE TRIGGER draw_epoch_fb_collection_viewers_insert AFTER INSERT ON fb_collection_viewers BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_collection_viewers_update",
    "CREATE TRIGGER draw_epoch_fb_collection_viewers_update AFTER UPDATE ON fb_collection_viewers\nWHEN OLD.collection_id IS NOT NEW.collection_id OR OLD.user_id IS NOT NEW.user_id OR OLD.revoked_at IS NOT NEW.revoked_at\nBEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_collection_viewers_delete",
    "CREATE TRIGGER draw_epoch_fb_collection_viewers_delete AFTER DELETE ON fb_collection_viewers BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_bot_admins_insert",
    "CREATE TRIGGER draw_epoch_fb_bot_admins_insert AFTER INSERT ON fb_bot_admins BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_bot_admins_update",
    "CREATE TRIGGER draw_epoch_fb_bot_admins_update AFTER UPDATE ON fb_bot_admins\nWHEN OLD.bot_id IS NOT NEW.bot_id OR OLD.user_id IS NOT NEW.user_id OR OLD.status IS NOT NEW.status\n  OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.capabilities_json IS NOT NEW.capabilities_json\nBEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_bot_admins_delete",
    "CREATE TRIGGER draw_epoch_fb_bot_admins_delete AFTER DELETE ON fb_bot_admins BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_users_insert",
    "CREATE TRIGGER draw_epoch_fb_users_insert AFTER INSERT ON fb_users BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_users_update",
    "CREATE TRIGGER draw_epoch_fb_users_update AFTER UPDATE ON fb_users\nWHEN OLD.id IS NOT NEW.id OR OLD.email IS NOT NEW.email OR OLD.display_name IS NOT NEW.display_name\n  OR OLD.platform_admin IS NOT NEW.platform_admin OR OLD.disabled_at IS NOT NEW.disabled_at\nBEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_users_delete",
    "CREATE TRIGGER draw_epoch_fb_users_delete AFTER DELETE ON fb_users BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_platform_admins_insert",
    "CREATE TRIGGER draw_epoch_fb_platform_admins_insert AFTER INSERT ON fb_platform_admins BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_platform_admins_update",
    "CREATE TRIGGER draw_epoch_fb_platform_admins_update AFTER UPDATE ON fb_platform_admins\nWHEN OLD.user_id IS NOT NEW.user_id OR OLD.status IS NOT NEW.status OR OLD.revoked_at IS NOT NEW.revoked_at\nBEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_platform_admins_delete",
    "CREATE TRIGGER draw_epoch_fb_platform_admins_delete AFTER DELETE ON fb_platform_admins BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_platform_role_assignments_insert",
    "CREATE TRIGGER draw_epoch_fb_platform_role_assignments_insert AFTER INSERT ON fb_platform_role_assignments BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_platform_role_assignments_update",
    "CREATE TRIGGER draw_epoch_fb_platform_role_assignments_update AFTER UPDATE ON fb_platform_role_assignments\nWHEN OLD.user_id IS NOT NEW.user_id OR OLD.role IS NOT NEW.role OR OLD.scopes_json IS NOT NEW.scopes_json\n  OR OLD.status IS NOT NEW.status OR OLD.revoked_at IS NOT NEW.revoked_at\nBEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_platform_role_assignments_delete",
    "CREATE TRIGGER draw_epoch_fb_platform_role_assignments_delete AFTER DELETE ON fb_platform_role_assignments BEGIN INSERT INTO fb_draw_scope_user_epochs (user_id,revision) VALUES (OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_pools_insert",
    "CREATE TRIGGER draw_epoch_fb_pools_insert AFTER INSERT ON fb_pools BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_pools_update",
    "CREATE TRIGGER draw_epoch_fb_pools_update AFTER UPDATE ON fb_pools BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_pools_delete",
    "CREATE TRIGGER draw_epoch_fb_pools_delete AFTER DELETE ON fb_pools BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_pool_entries_insert",
    "CREATE TRIGGER draw_epoch_fb_pool_entries_insert AFTER INSERT ON fb_pool_entries BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_pool_entries_update",
    "CREATE TRIGGER draw_epoch_fb_pool_entries_update AFTER UPDATE ON fb_pool_entries BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_pool_entries_delete",
    "CREATE TRIGGER draw_epoch_fb_pool_entries_delete AFTER DELETE ON fb_pool_entries BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_topic_policies_insert",
    "CREATE TRIGGER draw_epoch_fb_topic_policies_insert AFTER INSERT ON fb_topic_policies BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_topic_policies_update",
    "CREATE TRIGGER draw_epoch_fb_topic_policies_update AFTER UPDATE ON fb_topic_policies BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_topic_policies_delete",
    "CREATE TRIGGER draw_epoch_fb_topic_policies_delete AFTER DELETE ON fb_topic_policies BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_player_preferences_insert",
    "CREATE TRIGGER draw_epoch_fb_player_preferences_insert AFTER INSERT ON fb_player_preferences BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_player_preferences_update",
    "CREATE TRIGGER draw_epoch_fb_player_preferences_update AFTER UPDATE ON fb_player_preferences BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_player_preferences_delete",
    "CREATE TRIGGER draw_epoch_fb_player_preferences_delete AFTER DELETE ON fb_player_preferences BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_economy_settings_insert",
    "CREATE TRIGGER draw_epoch_fb_economy_settings_insert AFTER INSERT ON fb_economy_settings BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_economy_settings_update",
    "CREATE TRIGGER draw_epoch_fb_economy_settings_update AFTER UPDATE ON fb_economy_settings BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_economy_settings_delete",
    "CREATE TRIGGER draw_epoch_fb_economy_settings_delete AFTER DELETE ON fb_economy_settings BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_discord_installations_insert",
    "CREATE TRIGGER draw_epoch_fb_discord_installations_insert AFTER INSERT ON fb_discord_installations BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_discord_installations_update",
    "CREATE TRIGGER draw_epoch_fb_discord_installations_update AFTER UPDATE ON fb_discord_installations BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_discord_installations_delete",
    "CREATE TRIGGER draw_epoch_fb_discord_installations_delete AFTER DELETE ON fb_discord_installations BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_bots_insert",
    "CREATE TRIGGER draw_epoch_fb_bots_insert AFTER INSERT ON fb_bots BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_bots_update",
    "CREATE TRIGGER draw_epoch_fb_bots_update AFTER UPDATE ON fb_bots\nWHEN OLD.id IS NOT NEW.id OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.owner_user_id IS NOT NEW.owner_user_id\n  OR OLD.status IS NOT NEW.status OR OLD.ai_art_enabled IS NOT NEW.ai_art_enabled\nBEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1 AND (OLD.id IS NOT NEW.id OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.owner_user_id IS NOT NEW.owner_user_id OR OLD.status IS NOT NEW.status); END"
  ],
  [
    "draw_epoch_fb_bots_delete",
    "CREATE TRIGGER draw_epoch_fb_bots_delete AFTER DELETE ON fb_bots BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.tenant_id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; UPDATE fb_draw_scope_global_epoch SET revision=revision+1 WHERE id=1; END"
  ],
  [
    "draw_epoch_fb_tenants_insert",
    "CREATE TRIGGER draw_epoch_fb_tenants_insert AFTER INSERT ON fb_tenants BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_tenants_update",
    "CREATE TRIGGER draw_epoch_fb_tenants_update AFTER UPDATE ON fb_tenants BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (NEW.id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ],
  [
    "draw_epoch_fb_tenants_delete",
    "CREATE TRIGGER draw_epoch_fb_tenants_delete AFTER DELETE ON fb_tenants BEGIN INSERT INTO fb_draw_scope_tenant_epochs (tenant_id,revision) VALUES (OLD.id,1) ON CONFLICT(tenant_id) DO UPDATE SET revision=revision+1; END"
  ]
];
