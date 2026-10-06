import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../server/foundation/migrations.js';
import { grantProductionRoles } from '../server/production/roles.js';
import { createSecretVault } from '../server/foundation/secrets.js';
import { createIntegratedImport } from '../server/production/import.js';
import { importToPostgres } from '../server/runtime/import.js';
import { sqliteFixture } from './helpers/runtime-fixtures.js';
import { runtimePermission } from '../server/production/index.js';
import { assertNoInlineSecrets } from '../server/production/routes.js';
import { DatabaseSync } from 'node:sqlite';

test('query POSTs require document read while source mutations retain write permission', () => {
  for (const path of ['/collections/collection/search', '/collections/collection/retrieve'])
    assert.equal(runtimePermission({ operation: 'api', method: 'POST', path }), 'document.read');
  for (const path of [
    '/collections/collection/upload',
    '/collections/collection/website',
    '/sources/source/reindex',
  ])
    assert.equal(runtimePermission({ operation: 'api', method: 'POST', path }), 'workflow.write');
  assert.equal(
    runtimePermission({
      operation: 'api',
      method: 'DELETE',
      path: '/collections/collection/search',
    }),
    'workflow.write',
  );
});
test('combined migration and import: dry-run rolls back, IDs/credentials survive, and actual SQL roles deny identity secrets', async () => {
  const pg = new PGlite({ extensions: { vector } });
  const query = async (sql, args) => {
    if (args?.length) return pg.query(sql, args);
    const r = (await pg.exec(sql)).at(-1);
    return { rows: r?.rows || [], rowCount: r?.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-integration-import-'));
  try {
    await applyMigrations(pool);
    assert.deepEqual(await applyMigrations(pool), []);
    await pg.exec(
      'CREATE ROLE relay_app;CREATE ROLE relay_identity;CREATE ROLE relay_rate;CREATE ROLE relay_dispatch;',
    );
    await grantProductionRoles(pool);
    const file = path.join(dir, 'source.sqlite'),
      { key } = sqliteFixture(file);
    const vault = createSecretVault({ primary: '42'.repeat(32) }, 'primary'),
      integrate = createIntegratedImport(vault);
    await assert.rejects(
      () => importToPostgres(pool, file, { legacyKey: key, integrate, dryRun: true }),
      /VECTOR_DIMENSION/,
    );
    const source = new DatabaseSync(file);
    source
      .prepare('UPDATE embeddings SET vector=?')
      .run(JSON.stringify(Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))));
    source.exec(
      'CREATE TABLE security_source_access(source_id TEXT PRIMARY KEY,workspace_id TEXT,principals TEXT)',
    );
    source
      .prepare('INSERT INTO security_source_access VALUES(?,?,?)')
      .run('fixture_source', 'fixture_workspace', JSON.stringify(['user:fixture_user']));
    source.close();
    const before = await fs.readFile(file);
    const dry = await importToPostgres(pool, file, { legacyKey: key, integrate, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(
      (await pg.query('SELECT count(*)::int AS n FROM relay.security_accounts')).rows[0].n,
      0,
    );
    const report = await importToPostgres(pool, file, { legacyKey: key, integrate, dryRun: false });
    assert.match(report.secretCompatibility, /rewrapped/);
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(
      (await pg.query('SELECT access FROM relay.knowledge_sources')).rows[0].access,
      { mode: 'restricted', principalIds: ['user:fixture_user'] },
    );
    const r = (await pg.query('SELECT * FROM relay.security_credentials')).rows[0];
    const ctx = {
      workspaceId: r.workspace_id,
      actor: { kind: 'user', id: 'fixture_user' },
      requestId: 'import-test',
    };
    assert.ok(
      vault.open(
        ctx,
        { workspaceId: r.workspace_id, connectionId: r.connection_id, version: 1 },
        r.envelope,
      ),
    );
    assert.throws(() =>
      vault.open(
        { ...ctx, workspaceId: 'other' },
        { workspaceId: 'other', connectionId: r.connection_id, version: 1 },
        r.envelope,
      ),
    );
    await pg.exec('SET ROLE relay_app;');
    await assert.rejects(() => pg.query('SELECT password_hash FROM relay.security_accounts'));
    await assert.rejects(() => pg.query('SELECT mfa_secret FROM relay.security_accounts'));
    await assert.rejects(() => pg.query('SELECT * FROM relay.security_sessions'));
    await assert.rejects(() => pg.query("UPDATE relay.security_audit SET action='changed'"));
    await assert.rejects(() => pg.query('SELECT * FROM relay.runtime_workspaces()'));
    await assert.rejects(() => pg.query("SELECT * FROM relay.identity_workspaces('fixture_user')"));
    await pg.exec('RESET ROLE;SET ROLE relay_dispatch;');
    await pg.query('SELECT * FROM relay.runtime_workspaces()');
    await assert.rejects(() => pg.query('SELECT * FROM relay.runs'));
  } finally {
    await pg.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test('runtime permission translation denies unrecognized operations and separates viewer, execution, approval and recovery', () => {
  assert.equal(runtimePermission({ operation: 'api', method: 'GET', path: '/runs' }), 'run.read');
  assert.equal(
    runtimePermission({ operation: 'api', method: 'POST', path: '/runs' }),
    'run.execute',
  );
  assert.equal(runtimePermission({ operation: 'approve' }), 'run.approve');
  assert.equal(runtimePermission({ operation: 'recover' }), 'workspace.manage');
  assert.throws(() => runtimePermission({ operation: 'arbitrary' }));
  assert.throws(() => assertNoInlineSecrets({ nested: { authorization: 'Bearer never-persist' } }));
});
