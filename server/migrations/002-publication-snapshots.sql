ALTER TABLE applications ADD COLUMN graph_snapshot TEXT;
ALTER TABLE runs ADD COLUMN application_id TEXT;
ALTER TABLE actions ADD COLUMN side_effect INTEGER NOT NULL DEFAULT 0;
INSERT INTO migrations VALUES(2,datetime('now'));
