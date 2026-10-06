import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../server/foundation/migrations.js';
import { createSecretVault } from '../server/foundation/secrets.js';
import { createIntegratedImport } from '../server/production/import.js';
import { importToPostgres } from '../server/runtime/import.js';
import { sqliteFixture } from './helpers/runtime-fixtures.js';
const url = process.env.FOUNDATION_TEST_DATABASE_URL;
test(
  'actual PostgreSQL integrated import: rehearsal rollback, source preservation, tenant ACLs and credential AAD rewrapping',
  { skip: !url, timeout: 60000 },
  async () => {
    assert.match(new URL(url).pathname, /^\/relay_foundation_test(?:_[a-zA-Z0-9]+)?$/);
    const name = 'relay_import_test_' + crypto.randomBytes(6).toString('hex'),
      root = new pg.Pool({ connectionString: url }),
      target = new URL(url);
    target.pathname = '/' + name;
    const admin = new pg.Pool({ connectionString: target.href }),
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-import-services-'));
    try {
      await root.query(`CREATE DATABASE "${name}"`);
      await applyMigrations(admin);
      const file = path.join(dir, 'legacy.sqlite'),
        { key } = sqliteFixture(file),
        source = new DatabaseSync(file);
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
      const before = crypto
          .createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex'),
        vault = createSecretVault({ primary: '42'.repeat(32) }, 'primary'),
        integrate = createIntegratedImport(vault);
      const rehearsal = await importToPostgres(admin, file, {
        legacyKey: key,
        integrate,
        dryRun: true,
      });
      assert.equal(rehearsal.dryRun, true);
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM relay.workspaces')).rows[0].n,
        0,
      );
      const committed = await importToPostgres(admin, file, {
        legacyKey: key,
        integrate,
        dryRun: false,
      });
      assert.match(committed.secretCompatibility, /rewrapped/);
      assert.equal(
        crypto
          .createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex'),
        before,
      );
      assert.deepEqual(
        (await admin.query('SELECT access FROM relay.knowledge_sources')).rows[0].access,
        { mode: 'restricted', principalIds: ['user:fixture_user'] },
      );
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM relay.security_sessions')).rows[0].n,
        0,
      );
      const r = (await admin.query('SELECT * FROM relay.security_credentials')).rows[0],
        ctx = {
          workspaceId: r.workspace_id,
          actor: { kind: 'user', id: 'fixture_user' },
          requestId: 'pg-import',
        },
        ref = { workspaceId: r.workspace_id, connectionId: r.connection_id, version: 1 };
      assert.ok(vault.open(ctx, ref, r.envelope));
      assert.throws(() =>
        vault.open(
          { ...ctx, workspaceId: 'foreign' },
          { ...ref, workspaceId: 'foreign' },
          r.envelope,
        ),
      );
      await assert.rejects(
        importToPostgres(admin, file, { legacyKey: key, integrate, dryRun: false }),
      );
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM relay.security_accounts')).rows[0].n,
        1,
      );
    } finally {
      await admin.end();
      await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await root.end();
      assert.equal(path.dirname(dir), os.tmpdir());
      assert.ok(path.basename(dir).startsWith('relay-import-services-'));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
