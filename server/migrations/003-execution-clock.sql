ALTER TABLE runs ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN active_since TEXT;
INSERT INTO migrations VALUES(3,datetime('now'));
