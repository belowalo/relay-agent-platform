import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { createPostgresDatabase } from '../server/foundation/database.js';
import { applyMigrations } from '../server/foundation/migrations.js';
import { loadConfig } from '../server/foundation/config.js';
import { createKnowledgeRepository } from '../server/knowledge/repository.js';
import { ctx, input } from './knowledge/helpers.js';

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
test(
  'actual PostgreSQL/pgvector: tenant RLS, full-text, ANN ACL filtering, rollback, delete and stale fencing',
  { skip: !url, timeout: 120000 },
  async () => {
    const parsed = new URL(url);
    assert.match(parsed.pathname, /^\/relay_knowledge_test(?:_[a-zA-Z0-9]+)?$/);
    const admin = new pg.Pool({ connectionString: url });
    admin.on('error', () => {});
    const role = 'relay_knowledge_' + crypto.randomBytes(6).toString('hex'),
      password = crypto.randomBytes(24).toString('hex');
    const migrationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-knowledge-migrations-'));
    let app,
      created = false;
    try {
      // This independent branch supplies only minimum runtime-owned fixture tables for service tests.
      await fs.copyFile(
        new URL('../server/migrations/postgres/0001-foundation.sql', import.meta.url),
        path.join(migrationDir, '0001-foundation.sql'),
      );
      await fs.writeFile(
        path.join(migrationDir, '0100-runtime-fixture.sql'),
        'CREATE TABLE relay.workspaces(id text PRIMARY KEY); CREATE TABLE relay.collections(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES relay.workspaces(id));',
      );
      await fs.copyFile(
        new URL('../server/migrations/postgres/0300-knowledge.sql', import.meta.url),
        path.join(migrationDir, '0300-knowledge.sql'),
      );
      await applyMigrations(admin, migrationDir);
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      created = true;
      await admin.query(`GRANT USAGE ON SCHEMA relay TO "${role}"`);
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO "${role}"`,
      );
      await admin.query(
        "INSERT INTO relay.workspaces(id) VALUES('alpha'),('beta') ON CONFLICT DO NOTHING",
      );
      await admin.query(
        "INSERT INTO relay.collections(id,workspace_id) VALUES('manual','alpha'),('other','beta') ON CONFLICT DO NOTHING",
      );
      parsed.username = role;
      parsed.password = password;
      app = createPostgresDatabase(loadConfig({ DATABASE_URL: parsed.toString() }));
      await app.assertApplicationRole();
      const r = createKnowledgeRepository(app),
        vector = Array(384).fill(0);
      vector[0] = 1;
      const a = await r.upsert(ctx(), input('pg_' + role, 'Actual postgres Orion policy.'));
      const lease = await r.claim(ctx(), a.jobId, 'worker');
      assert.ok(
        await r.finish(
          ctx(),
          lease,
          [
            {
              id: 'chunk_' + role,
              ordinal: 0,
              content: 'Actual postgres Orion policy.',
              location: { start: 0, end: 29 },
              vector,
            },
          ],
          'test-model',
        ),
      );
      const options = { mode: 'hybrid', topK: 5, maxPerSource: 2, metadata: {}, exact: false };
      let candidates = await r.candidates(
        ctx(),
        'manual',
        'Orion',
        vector,
        options,
        ['user:alice'],
        'test-model',
      );
      assert.equal(candidates.lexical.length, 1);
      assert.equal(candidates.semantic.length, 1);
      assert.equal(await r.getSource(ctx('beta'), a.sourceId), null);
      assert.equal(
        (await app.transaction(ctx('beta'), (s) => s.all('SELECT * FROM relay.knowledge_chunks')))
          .length,
        0,
      );
      await assert.rejects(
        app.transaction(ctx(), (s) =>
          s.query("INSERT INTO relay.knowledge_blob_gc(workspace_id,key) VALUES('beta','cross')"),
        ),
        /row-level security/,
      );
      const privateDoc = await r.upsert(
        ctx(),
        input('private_' + role, 'Orion compensation', {
          access: { mode: 'restricted', principalIds: ['user:alice'] },
        }),
      );
      const privateLease = await r.claim(ctx(), privateDoc.jobId, 'worker');
      await r.finish(
        ctx(),
        privateLease,
        [
          {
            id: 'private_chunk_' + role,
            ordinal: 0,
            content: 'Orion private compensation.',
            location: { start: 0, end: 26 },
            vector,
          },
        ],
        'test-model',
      );
      candidates = await r.candidates(
        ctx(),
        'manual',
        'Orion',
        vector,
        options,
        ['user:bob'],
        'test-model',
      );
      assert.equal(candidates.lexical.length, 1);
      assert.equal(candidates.semantic.length, 1);
      await assert.rejects(
        app.transaction(ctx(), async (s) => {
          await s.query("UPDATE relay.knowledge_sources SET name='rollback' WHERE id=$1", [
            a.sourceId,
          ]);
          throw Error('abort');
        }),
      );
      assert.notEqual((await r.getSource(ctx(), a.sourceId)).name, 'rollback');
      const stale = await r.reindex(ctx(), a.sourceId),
        staleLease = await r.claim(ctx(), stale.jobId, 'stale');
      await r.delete(ctx(), a.sourceId);
      assert.equal(await r.finish(ctx(), staleLease, [], 'test-model'), false);
      candidates = await r.candidates(
        ctx(),
        'manual',
        'Orion',
        vector,
        options,
        ['user:bob'],
        'test-model',
      );
      assert.equal(candidates.lexical.length, 0);
      assert.equal(candidates.semantic.length, 0);
      assert.equal(
        (
          await app.transaction(ctx(), (s) =>
            s.all('SELECT * FROM relay.knowledge_vectors WHERE chunk_id=$1', ['chunk_' + role]),
          )
        ).length,
        0,
      );
      await r.delete(ctx(), privateDoc.sourceId);
    } finally {
      await app?.close();
      if (created) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
      await admin.end();
      await fs.rm(migrationDir, { recursive: true, force: true });
    }
  },
);
