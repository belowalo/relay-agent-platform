// Operator-run, read-only rehearsal against a private online SQLite snapshot.
// No source contents, identities or credentials are emitted or uploaded.
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../server/foundation/migrations.js';
import { importToPostgres } from '../server/runtime/import.js';
import { createIntegratedImport } from '../server/production/import.js';
import { createSecretVault } from '../server/foundation/secrets.js';
const source = process.argv[2],
  keyFile = process.argv[3];
if (!source || !keyFile) throw new Error('Provide private SQLite path and legacy key file');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-private-migration-'));
let db, pg;
try {
  db = new DatabaseSync(path.resolve(source), { readOnly: true });
  await backup(db, path.join(directory, 'source.sqlite'));
  db.close();
  db = undefined;
  const legacyKey = await fs.readFile(keyFile);
  pg = new PGlite({ extensions: { vector } });
  const query = async (sql, args) =>
    args?.length ? pg.query(sql, args) : { rows: (await pg.exec(sql)).at(-1)?.rows || [] };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await applyMigrations(pool);
  const vault = createSecretVault(
    { rehearsal: crypto.randomBytes(32).toString('hex') },
    'rehearsal',
  );
  const result = await importToPostgres(pool, path.join(directory, 'source.sqlite'), {
    dryRun: true,
    legacyKey,
    integrate: createIntegratedImport(vault),
  });
  const remaining = (await pg.query('SELECT count(*)::int AS n FROM relay.workspaces')).rows[0].n;
  if (remaining !== 0) throw new Error('Rehearsal rollback failed');
  console.log(
    JSON.stringify({
      passed: true,
      engine: 'Embedded PostgreSQL; actual server rehearsal remains required',
      sourceUnmodified: true,
      rollbackVerified: true,
      counts: result.counts,
      haltedRuns: result.haltedRuns,
      secretCompatibility: result.secretCompatibility,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      passed: false,
      code: error.code || 'IMPORT_SCHEMA_DATA_OR_CRYPTO_REVIEW_REQUIRED',
      sourceUnmodified: true,
      detailsPrinted: false,
    }),
  );
  process.exitCode = 1;
} finally {
  db?.close();
  await pg?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
