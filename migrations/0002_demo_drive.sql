-- Tables used ONLY when DRIVE_MODE=demo (explicitly labelled demo mode).
-- They emulate the subset of Google Drive the app uses so the whole flow can be
-- exercised locally without Google credentials. Unused in production.

CREATE TABLE demo_drive_files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  mime_type TEXT NOT NULL,
  size INTEGER,
  trashed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_demo_drive_parent ON demo_drive_files(parent_id, name);

CREATE TABLE demo_drive_sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_id TEXT,
  created_at INTEGER NOT NULL
);
