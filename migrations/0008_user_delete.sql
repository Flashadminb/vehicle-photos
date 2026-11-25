-- Permanently deleted members: users with photo sets keep a name-only record so the history
-- still shows who took each set; their login is destroyed and the username is freed.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
