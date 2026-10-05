CREATE TABLE IF NOT EXISTS model_cache (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  response TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, cache_key)
);
CREATE INDEX IF NOT EXISTS model_cache_expiry ON model_cache(expires_at);
INSERT INTO migrations VALUES(6,datetime('now'));
