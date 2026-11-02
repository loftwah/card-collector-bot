-- Editorial copy for the curated starter identities. Structured card identity
-- remains in Foilbury; these are the display bio and quote fields shown on the
-- card detail surface. The update is idempotent and never changes ownership,
-- serials, variants or ledger rows.

UPDATE fb_card_definitions
   SET bio = COALESCE(bio, description)
 WHERE bio IS NULL;

UPDATE fb_card_definitions
   SET quote = COALESCE(quote, CASE slug
     WHEN 'drop-bear' THEN 'If you did not see it land, it was not your turn.'
     WHEN 'gabe' THEN 'The plan was fine until the plan met me.'
     WHEN 'grim-reaper' THEN 'Every ledger balances eventually.'
     WHEN 'humpty' THEN 'The fall is part of the choreography.'
     WHEN 'june' THEN 'Nobody solves anything hungry.'
     WHEN 'knox' THEN 'Let them talk. The board remembers.'
     WHEN 'loftwah' THEN 'Check the signal, then check it again.'
     WHEN 'miku' THEN 'Turn the volume up; the room can take it.'
     WHEN 'moss' THEN 'Leave a light on for the next one.'
     WHEN 'ned-kelly' THEN 'The warning is the courtesy.'
     WHEN 'nora' THEN 'Good dogs know where the door is.'
     WHEN 'pepe' THEN 'I was already in the room.'
     WHEN 'pippa' THEN 'I checked the exits. All of them.'
     WHEN 'pressure-orbit' THEN 'Hold the ring. The rest is noise.'
     WHEN 'rhea' THEN 'Three moves ahead is still behind me.'
     WHEN 'tux' THEN 'Every opening is a permissions bug.'
     ELSE quote
   END)
 WHERE slug IN (
   'drop-bear', 'gabe', 'grim-reaper', 'humpty', 'june', 'knox', 'loftwah', 'miku',
   'moss', 'ned-kelly', 'nora', 'pepe', 'pippa', 'pressure-orbit', 'rhea', 'tux'
 );
