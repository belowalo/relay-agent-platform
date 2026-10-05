import fs from 'node:fs/promises';
import pg from 'pg';
import { applyMigrations } from '../server/foundation/migrations.js';
try {
  const pool = new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    database: process.env.PGDATABASE,
    password: (await fs.readFile(process.env.PGPASSWORD_FILE, 'utf8')).trim(),
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', () => {});
  try {
    console.log(JSON.stringify({ applied: await applyMigrations(pool) }));
  } finally {
    await pool.end();
  }
} catch {
  console.error(
    JSON.stringify({
      code: 'MIGRATION_FAILED',
      message: 'Migration failed; inspect version history and restore rehearsal before retry.',
    }),
  );
  process.exitCode = 1;
}
