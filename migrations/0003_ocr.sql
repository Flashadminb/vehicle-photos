-- Local OCR agents (computers that pull plate-recognition jobs) and Vision usage counter.

CREATE TABLE ocr_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_seen_at INTEGER,
  last_ip TEXT,
  version TEXT,
  jobs_done INTEGER NOT NULL DEFAULT 0
);

-- Calls made per provider per period (e.g. 'vision:2026-11'), used to stop at the free-tier cap.
CREATE TABLE ocr_usage (
  period TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Jobs taken by a local agent remember who holds them.
ALTER TABLE jobs ADD COLUMN agent_id TEXT;
CREATE INDEX idx_jobs_kind_status ON jobs(kind, status, next_run_at);
