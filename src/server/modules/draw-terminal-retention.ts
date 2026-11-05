/** Test-only v2 terminal-outcome retention proposal; production writer held. */
export const DRAW_TERMINAL_TRIGGER_DEFINITIONS = [
  ['draw_terminal_no_delete', "CREATE TRIGGER draw_terminal_no_delete BEFORE DELETE ON fb_idempotency_keys WHEN OLD.operation='draw.execute' AND OLD.status='failed' BEGIN SELECT RAISE(ABORT,'draw_terminal_immutable'); END"],
  ['draw_terminal_no_update', "CREATE TRIGGER draw_terminal_no_update BEFORE UPDATE ON fb_idempotency_keys WHEN OLD.operation='draw.execute' AND OLD.status='failed' BEGIN SELECT RAISE(ABORT,'draw_terminal_immutable'); END"],
] as const;
export const DRAW_TERMINAL_TRIGGER_DATA=JSON.stringify(DRAW_TERMINAL_TRIGGER_DEFINITIONS);
export const DRAW_TERMINAL_TRIGGER_CHECK=`NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE NOT EXISTS (SELECT 1 FROM sqlite_master s WHERE s.type='trigger' AND s.name=json_extract(e.value,'$[0]') AND s.sql=json_extract(e.value,'$[1]')))`;
