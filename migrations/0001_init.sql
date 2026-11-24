-- Vehicle photo sets: core schema.
-- All timestamps are INTEGER milliseconds since the Unix epoch (UTC).
-- Operational dates (op_date) are YYYY-MM-DD in Asia/Bangkok (UTC+7, no DST).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin','admin','reviewer','operator')),
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  language TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_users_display ON users(display_name);

-- Session tokens are stored hashed (SHA-256); the raw token only lives in an HttpOnly cookie.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('field','admin')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);

-- Key/value settings. key 'app' holds the JSON application settings,
-- key 'drive_token' holds the encrypted Google refresh token.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Immutable workflow versions. A round freezes the version it started with.
CREATE TABLE workflow_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steps TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE languages (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Admin-edited translation overrides. Built-in defaults live in code (src/shared/i18n.ts).
CREATE TABLE translations (
  lang TEXT NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (lang, key)
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- One Drive date folder per (root, Bangkok date). lock_* coordinate concurrent creation.
CREATE TABLE drive_date_folders (
  root_folder_id TEXT NOT NULL,
  op_date TEXT NOT NULL,
  folder_id TEXT,
  lock_until INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (root_folder_id, op_date)
);

-- One row = one photo set (capture round).
CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  public_id TEXT NOT NULL UNIQUE,
  client_round_id TEXT NOT NULL UNIQUE,
  operator_id TEXT NOT NULL REFERENCES users(id),
  workflow_version_id INTEGER NOT NULL REFERENCES workflow_versions(id),
  started_at INTEGER NOT NULL,
  started_at_source TEXT NOT NULL CHECK (started_at_source IN ('device','server')),
  created_at INTEGER NOT NULL,
  op_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','finalized','abandoned')),
  finalized_at INTEGER,
  finalize_key TEXT,
  required_count INTEGER NOT NULL,
  active_count INTEGER NOT NULL DEFAULT 0,
  uploaded_count INTEGER NOT NULL DEFAULT 0,
  plate_text TEXT,
  plate_norm TEXT,
  plate_digits TEXT,
  plate_raw TEXT,
  plate_confidence REAL,
  plate_source TEXT NOT NULL DEFAULT 'none' CHECK (plate_source IN ('none','ocr','manual')),
  plate_updated_at INTEGER,
  plate_updated_by TEXT,
  ocr_status TEXT NOT NULL DEFAULT 'none',
  unknown_label TEXT NOT NULL,
  drive_root_folder_id TEXT,
  drive_date_folder_id TEXT,
  drive_folder_id TEXT,
  drive_folder_name TEXT,
  folder_status TEXT NOT NULL DEFAULT 'pending',
  folder_lock_until INTEGER,
  hidden_at INTEGER,
  hidden_by TEXT,
  removed_at INTEGER,
  removed_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_rounds_started ON rounds(started_at DESC, id DESC);
CREATE INDEX idx_rounds_status_started ON rounds(status, started_at DESC, id DESC);
CREATE INDEX idx_rounds_visible ON rounds(started_at DESC, id DESC)
  WHERE status = 'finalized' AND removed_at IS NULL AND hidden_at IS NULL;
CREATE INDEX idx_rounds_plate_norm ON rounds(plate_norm);
CREATE INDEX idx_rounds_plate_digits ON rounds(plate_digits);
CREATE INDEX idx_rounds_operator ON rounds(operator_id, started_at DESC);
CREATE INDEX idx_rounds_open ON rounds(status, updated_at);

-- Every accepted image attempt. Only one active image per (round, step).
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  client_image_id TEXT NOT NULL UNIQUE,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  step_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending','uploaded','superseded')),
  source TEXT NOT NULL CHECK (source IN ('camera','upload')),
  operator_id TEXT NOT NULL,
  server_received_at INTEGER NOT NULL,
  accepted_at_device INTEGER,
  capture_time_device INTEGER,
  exif_time TEXT,
  uploaded_at INTEGER,
  file_name TEXT NOT NULL,
  drive_file_id TEXT,
  drive_display_file_id TEXT,
  original_bytes INTEGER,
  display_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  superseded_at INTEGER,
  superseded_by TEXT,
  replaced_moved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_images_active ON images(round_id, step_id) WHERE active = 1;
CREATE INDEX idx_images_round ON images(round_id, step_index, version);

-- Auditable plate history (OCR results and manual corrections).
CREATE TABLE plate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  at INTEGER NOT NULL,
  actor_id TEXT,
  source TEXT NOT NULL,
  old_text TEXT,
  new_text TEXT,
  raw TEXT,
  confidence REAL
);
CREATE INDEX idx_plate_history_round ON plate_history(round_id, at);

-- R2 cache index: lets us know total cache usage without listing the bucket.
CREATE TABLE cache_objects (
  key TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cache_created ON cache_objects(created_at);
CREATE INDEX idx_cache_image ON cache_objects(image_id);

-- Durable background jobs (Drive renames/moves, OCR). Processed by the cron trigger.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, next_run_at);

-- Explicit Excel export grants (allow image fetches for old sets, audited).
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  round_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  ip TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);

-- Seed data
INSERT INTO counters (name, value) VALUES ('round', 0);
INSERT INTO languages (code, name, enabled, sort) VALUES ('th', 'ไทย', 1, 0), ('en', 'English', 1, 1);
INSERT INTO workflow_versions (steps, note, created_at, created_by) VALUES (
  '[{"id":"step_bar","required":true,"allowUpload":true,"ocr":false,"labels":{"th":"บาร์รถ","en":"Vehicle bar"}},{"id":"step_rear","required":true,"allowUpload":true,"ocr":false,"labels":{"th":"ด้านหลังรถ","en":"Rear of vehicle"}},{"id":"step_plate","required":true,"allowUpload":true,"ocr":true,"labels":{"th":"ป้ายทะเบียน","en":"License plate"}}]',
  'Default workflow', 0, NULL
);
