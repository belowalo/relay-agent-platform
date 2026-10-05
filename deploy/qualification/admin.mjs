import pg from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyMigrations } from '../../server/foundation/migrations.js';
if (process.env.OPERATIONS_QUALIFICATION !== 'true') throw new Error('Qualification only');
const password = (await fs.readFile('/run/secrets/database_password', 'utf8')).trim();
const pool = new pg.Pool({
  host: 'database',
  user: 'relay_owner',
  password,
  database: process.env.PGDATABASE || 'relay',
});
try {
  if (process.argv[2] === 'failed-migration') {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-migration-'));
    try {
      const sql = await fs.readFile(
        new URL('../../server/migrations/postgres/0001-foundation.sql', import.meta.url),
        'utf8',
      );
      await fs.writeFile(path.join(temp, '0001-foundation.sql'), sql);
      await fs.writeFile(
        path.join(temp, '0500-failure-fixture.sql'),
        'CREATE TABLE relay.must_rollback(id int); SELECT nonexistent_column;',
      );
      let rejected = false;
      try {
        await applyMigrations(pool, temp);
      } catch {
        rejected = true;
      }
      const result = await pool.query("SELECT to_regclass('relay.must_rollback') AS fixture");
      if (!rejected || result.rows[0].fixture !== null)
        throw new Error('Migration rollback failed');
      console.log(JSON.stringify({ failedMigrationRolledBack: true }));
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  } else {
    await applyMigrations(pool);
    await pool.query(
      'CREATE TABLE IF NOT EXISTS relay.operations_fixture(id text PRIMARY KEY, workspace_id text NOT NULL, secret text NOT NULL, embedding vector(3), state text, traceparent text); ALTER TABLE relay.operations_fixture ENABLE ROW LEVEL SECURITY; ALTER TABLE relay.operations_fixture FORCE ROW LEVEL SECURITY;',
    );
    await pool.query(
      "CREATE POLICY fixture_workspace ON relay.operations_fixture USING(workspace_id=nullif(current_setting('relay.workspace_id',true),'')) WITH CHECK(workspace_id=nullif(current_setting('relay.workspace_id',true),''))",
    );
    console.log(JSON.stringify({ migrated: true }));
  }
} finally {
  await pool.end();
}
