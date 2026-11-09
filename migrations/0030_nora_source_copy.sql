-- Nora is a cat in Protocol 11's current rival story and canonical table-night
-- portrait. Correct only the known starter copy; retain any operator edits.
-- Issued card renders are not modified by this metadata migration.
-- Rollback, after reviewing intervening edits: restore each old field only
-- where it still equals the corresponding replacement below.
UPDATE fb_card_definitions
   SET subtitle = CASE WHEN subtitle = 'Dog table boss' THEN 'Retired chaos manager' ELSE subtitle END,
       quote = CASE WHEN quote = 'Good dogs know where the door is.' THEN 'There. Something sensible on the table.' ELSE quote END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       version = version + 1
 WHERE logical_id = 'character:nora' AND slug = 'nora' AND archived_at IS NULL
   AND (subtitle = 'Dog table boss' OR quote = 'Good dogs know where the door is.');
