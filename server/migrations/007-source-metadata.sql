ALTER TABLE sources ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
INSERT INTO migrations VALUES(7,datetime('now'));
