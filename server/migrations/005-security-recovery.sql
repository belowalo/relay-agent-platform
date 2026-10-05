ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;
ALTER TABLE sources ADD COLUMN index_lease_until INTEGER;
ALTER TABLE sources ADD COLUMN index_lease_owner TEXT;
CREATE TABLE mfa_recovery(user_id TEXT NOT NULL REFERENCES users(id),code_hash TEXT NOT NULL,PRIMARY KEY(user_id,code_hash));
INSERT INTO migrations VALUES(5,datetime('now'));
