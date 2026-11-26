-- Drive layout v2: <root>/<capture profile>/<YYYY-MM-DD>/<set>. Each profile has its own folder.
ALTER TABLE workflows ADD COLUMN drive_folder_id TEXT;
ALTER TABLE workflows ADD COLUMN drive_folder_root TEXT;
ALTER TABLE workflows ADD COLUMN folder_lock_until INTEGER;
-- 1 = <root>/<date>/<set> (before profiles had folders), 2 = <root>/<profile>/<date>/<set>.
ALTER TABLE rounds ADD COLUMN drive_layout INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_rounds_layout ON rounds(drive_layout);
