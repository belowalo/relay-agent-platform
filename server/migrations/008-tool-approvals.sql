ALTER TABLE steps ADD COLUMN checkpoint TEXT;
CREATE TABLE tool_approvals (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL
);
CREATE INDEX tool_approval_step ON tool_approvals(step_id,status);
INSERT INTO migrations VALUES(8,datetime('now'));
