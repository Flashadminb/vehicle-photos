-- Dispatch-slip bar number ("เลขบาร์รถ", e.g. SAM1VFKD36), mainly for searching back.
-- bar_code_rev (reversed) lets "ends with" searches such as "VFKD36" use an index too.
ALTER TABLE rounds ADD COLUMN bar_code TEXT;
ALTER TABLE rounds ADD COLUMN bar_code_rev TEXT;
ALTER TABLE rounds ADD COLUMN bar_code_source TEXT NOT NULL DEFAULT 'none';
CREATE INDEX idx_rounds_bar_code ON rounds(bar_code);
CREATE INDEX idx_rounds_bar_code_rev ON rounds(bar_code_rev);
