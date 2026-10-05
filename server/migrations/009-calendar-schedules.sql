ALTER TABLE schedules ADD COLUMN cron_expression TEXT;
ALTER TABLE schedules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
INSERT INTO migrations VALUES(9,datetime('now'));
