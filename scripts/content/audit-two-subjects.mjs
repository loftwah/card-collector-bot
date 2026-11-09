#!/usr/bin/env node
/** Read-only structural audit. Counts do not prove entitlement or visual review. */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { subjects, normalizeName } from "./two-subject-plan.mjs";

export function auditTwoSubjects(db, tenantId) {
  if (!tenantId) throw new Error("An explicit Bot tenant is required.");
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const results = subjects.map((spec) => {
    const cards = all("SELECT id,slug,logical_id,name,status,review_status FROM fb_card_definitions WHERE tenant_id = ? AND (slug = ? OR logical_id = ?)", tenantId, spec.slug, spec.logicalId);
    if (cards.length !== 1 || cards[0].slug !== spec.slug || cards[0].logical_id !== spec.logicalId) return { subject: spec.slug, status: "identity_missing_or_ambiguous" };
    const card = cards[0];
    const aliases = all("SELECT alias,normalized FROM fb_card_name_aliases WHERE tenant_id = ? AND card_id = ?", tenantId, card.id);
    const normalized = new Set([normalizeName(card.name), ...aliases.filter(a => a.normalized === normalizeName(a.alias)).map(a => a.normalized)]);
    const missingAliases = spec.names.filter(name => !normalized.has(normalizeName(name)));
    const expectedNames = new Set(spec.names.map(normalizeName));
    const otherCards = all("SELECT id,name FROM fb_card_definitions WHERE tenant_id = ? AND id <> ?", tenantId, card.id);
    const otherAliases = all("SELECT card_id,alias,normalized FROM fb_card_name_aliases WHERE tenant_id = ? AND card_id <> ?", tenantId, card.id);
    const identityConflict = otherCards.some(c => expectedNames.has(normalizeName(c.name))) || otherAliases.some(a => expectedNames.has(normalizeName(a.alias)) || expectedNames.has(a.normalized));
    const collections = all(`SELECT c.id,c.slug,c.status,c.view_audience,bc.enabled FROM fb_collection_cards cc JOIN fb_collections c ON c.id = cc.collection_id
      LEFT JOIN fb_bots b ON b.tenant_id = ? AND b.status <> 'archived' LEFT JOIN fb_bot_collections bc ON bc.bot_id = b.id AND bc.collection_id = c.id
      WHERE cc.card_id = ? AND c.slug = ? AND c.scope = 'global' AND c.owner_tenant_id = ? AND c.archived_at IS NULL`, tenantId, card.id, spec.collection, tenantId);
    const variants = all(`SELECT v.id,m.key AS material,fx.key AS effect,v.status,
      (SELECT COUNT(*) FROM fb_variant_renders r WHERE r.variant_id = v.id AND r.status = 'published') AS fronts,
      (SELECT COUNT(*) FROM fb_variant_back_renders r WHERE r.variant_id = v.id AND r.status = 'published') AS backs,
      (SELECT COUNT(*) FROM fb_pool_entries pe JOIN fb_pools p ON p.id = pe.pool_id AND p.revision = pe.pool_revision WHERE pe.variant_id = v.id AND p.tenant_id = ? AND p.status = 'active' AND p.slug = ?) AS pool_entries
      FROM fb_variants v JOIN fb_artwork_editions e ON e.id = v.edition_id AND e.tenant_id = v.tenant_id AND e.status = 'published' AND e.archived_at IS NULL
      JOIN fb_materials m ON m.id = v.material_id LEFT JOIN fb_effects fx ON fx.id = v.effect_id
      WHERE v.tenant_id = ? AND v.card_id = ? AND v.archived_at IS NULL`, tenantId, `${spec.collection}-capsule`, tenantId, card.id);
    const finishes = [["plain", "none"], ["silver", "none"], ["gold", "none"], ["gold", "holographic"]].map(([material, effect]) => {
      const matches = variants.filter(v => v.material === material && (v.effect ?? "none") === effect && v.status === "published");
      return { material, effect, published_variants: matches.length, fronts: matches.reduce((n, v) => n + Number(v.fronts), 0), backs: matches.reduce((n, v) => n + Number(v.backs), 0), pool_entries: matches.reduce((n, v) => n + Number(v.pool_entries), 0), structurally_complete_variants: matches.filter(v => Number(v.fronts) > 0 && Number(v.backs) > 0 && Number(v.pool_entries) > 0).length };
    });
    return { subject: spec.slug, status: card.status, identity_conflict: identityConflict, editorial_status: card.review_status, missing_aliases: missingAliases, collections, finishes };
  });
  return { mode: "read-only-structural-audit", tenant_id: tenantId, results, visual_review_verified: false, draw_eligibility_verified: false, note: "Presence is not proof of reviewed artwork, rights, live entitlement or a committed draw." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--database" || args[2] !== "--tenant" || !args[1] || !args[3]) {
    console.error("Usage: node scripts/content/audit-two-subjects.mjs --database LOCAL_SQLITE --tenant BOT_TENANT_ID");
    process.exitCode = 1;
  } else {
    let db;
    try { db = new DatabaseSync(path.resolve(args[1]), { readOnly: true }); console.log(JSON.stringify(auditTwoSubjects(db, args[3]), null, 2)); }
    catch { console.error("Could not inspect the specified local database and required tables."); process.exitCode = 1; }
    finally { db?.close(); }
  }
}
