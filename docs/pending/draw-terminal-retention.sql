-- Test-only sketch. These triggers make failed draw keys immutable; they are
-- not an approved retention policy or an ordered production migration.
CREATE TRIGGER draw_terminal_no_delete BEFORE DELETE ON fb_idempotency_keys WHEN OLD.operation='draw.execute' AND OLD.status='failed' BEGIN SELECT RAISE(ABORT,'draw_terminal_immutable'); END;
CREATE TRIGGER draw_terminal_no_update BEFORE UPDATE ON fb_idempotency_keys WHEN OLD.operation='draw.execute' AND OLD.status='failed' BEGIN SELECT RAISE(ABORT,'draw_terminal_immutable'); END;
