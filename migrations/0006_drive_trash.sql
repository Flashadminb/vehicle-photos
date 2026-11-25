-- "Free up Drive space": a set's Drive folder can be moved to the Drive trash by a
-- Super Admin (recoverable for 30 days). The set's metadata stays searchable.
ALTER TABLE rounds ADD COLUMN drive_trashed_at INTEGER;
ALTER TABLE rounds ADD COLUMN drive_trashed_by TEXT;
CREATE INDEX idx_rounds_trash_candidates ON rounds(status, drive_trashed_at, op_date);
