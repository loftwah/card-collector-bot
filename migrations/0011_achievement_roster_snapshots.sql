-- Freeze the release roster for collection-completion achievements that were
-- created before roster snapshots were supported. The definition version stays
-- the same, so existing unlocks and rewards are not duplicated. Later catalogue
-- edits cannot move this version's completion boundary.
UPDATE fb_achievement_definitions
   SET criteria_json = json_set(
         criteria_json,
         '$.roster_card_ids',
         (SELECT json_group_array(cc.card_id)
            FROM fb_collection_cards cc
           WHERE cc.collection_id = json_extract(fb_achievement_definitions.criteria_json, '$.collection_id')),
         '$.target',
         (SELECT COUNT(*)
            FROM fb_collection_cards cc
           WHERE cc.collection_id = json_extract(fb_achievement_definitions.criteria_json, '$.collection_id'))
       )
 WHERE json_extract(criteria_json, '$.type') = 'collection_complete'
   AND json_extract(criteria_json, '$.roster_card_ids') IS NULL
   AND EXISTS (
         SELECT 1 FROM fb_collection_cards cc
          WHERE cc.collection_id = json_extract(fb_achievement_definitions.criteria_json, '$.collection_id')
       );
