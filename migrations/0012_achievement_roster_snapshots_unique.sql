-- Collection-unique milestones also need a release roster boundary. The target
-- stays at the milestone size (4, 8, etc.); only the eligible card set is frozen.
-- Existing unlocks are untouched because the definition version does not change.
UPDATE fb_achievement_definitions
   SET criteria_json = json_set(
         criteria_json,
         '$.roster_card_ids',
         (SELECT json_group_array(cc.card_id)
            FROM fb_collection_cards cc
           WHERE cc.collection_id = json_extract(fb_achievement_definitions.criteria_json, '$.collection_id'))
       )
 WHERE json_extract(criteria_json, '$.type') = 'collection_unique'
   AND json_extract(criteria_json, '$.roster_card_ids') IS NULL
   AND EXISTS (
         SELECT 1 FROM fb_collection_cards cc
          WHERE cc.collection_id = json_extract(fb_achievement_definitions.criteria_json, '$.collection_id')
       );
