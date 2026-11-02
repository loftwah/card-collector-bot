-- Existing approved Loftwah showcase cards predate the structured review field.
-- Their source credit and public approval were reviewed in the earlier pass;
-- record that review status without touching identity, renders, ownership or
-- any member-only content.

UPDATE fb_card_definitions
   SET review_status = 'reviewed'
 WHERE review_status = 'unreviewed'
   AND EXISTS (
     SELECT 1
       FROM fb_collection_cards cc
       JOIN fb_collections c ON c.id = cc.collection_id
      WHERE cc.card_id = fb_card_definitions.id
        AND c.scope = 'global'
        AND c.view_audience = 'public'
        AND c.public_approved_at IS NOT NULL
        AND c.archived_at IS NULL
   );

UPDATE fb_collections
   SET source_work = COALESCE(source_work, 'Original Foilbury project')
 WHERE scope = 'global'
   AND view_audience = 'public'
   AND public_approved_at IS NOT NULL
   AND source_work IS NULL;
