-- Capture profiles ("รูปแบบการถ่าย"): e.g. one for the field team, another for the gate guards.
-- Each profile has its own versioned steps; each user is assigned one profile.
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
INSERT INTO workflows (id, name, sort, created_at) VALUES ('default', 'ทั่วไป', 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
ALTER TABLE workflow_versions ADD COLUMN workflow_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_wfv_workflow ON workflow_versions(workflow_id, id);
ALTER TABLE users ADD COLUMN workflow_id TEXT;
ALTER TABLE rounds ADD COLUMN workflow_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_rounds_workflow_started ON rounds(workflow_id, started_at);
CREATE INDEX idx_rounds_operator_started ON rounds(operator_id, started_at);
