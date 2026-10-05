import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { createKnowledgeRepository } from '../server/knowledge/repository.js';
import { ctx, input } from './knowledge/helpers.js';

test(
  'embedded actual PostgreSQL/pgvector: migrations, RLS, outbox, ACL/metadata filters and version fencing',
  { timeout: 60000 },
  async () => {
    const pg = new PGlite({ extensions: { vector } });
    try {
      await pg.exec('CREATE SCHEMA relay;');
      await pg.exec(
        await fs.readFile(
          new URL('../server/migrations/postgres/0001-foundation.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        'CREATE TABLE relay.workspaces(id text PRIMARY KEY); CREATE TABLE relay.collections(id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES relay.workspaces(id));',
      );
      await pg.exec(
        await fs.readFile(
          new URL('../server/migrations/postgres/0300-knowledge.sql', import.meta.url),
          'utf8',
        ),
      );
      await pg.exec(
        "INSERT INTO relay.workspaces VALUES('alpha'),('beta'); INSERT INTO relay.collections VALUES('manual','alpha'),('other','beta'); CREATE ROLE knowledge_app; GRANT USAGE ON SCHEMA relay TO knowledge_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO knowledge_app;",
      );
      const database = {
        transaction(c, fn) {
          return pg.transaction(async (t) => {
            await t.exec('SET LOCAL ROLE knowledge_app');
            await t.query("SELECT set_config('relay.workspace_id',$1,true)", [c.workspaceId]);
            const session = {
              context: c,
              query: async (text, values = []) => {
                const r = await t.query(text, values);
                return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
              },
              one: async (text, values = []) => (await t.query(text, values)).rows[0] || null,
              all: async (text, values = []) => (await t.query(text, values)).rows,
            };
            return fn(session);
          });
        },
      };
      const repo = createKnowledgeRepository(database),
        v = Array(384).fill(0);
      v[0] = 1;
      const add = async (d) => {
        const r = await repo.upsert(ctx(), d);
        const lease = await repo.claim(ctx(), r.jobId, 'worker');
        assert.ok(lease);
        await repo.finish(
          ctx(),
          lease,
          [
            {
              id: 'chunk_' + r.sourceId,
              ordinal: 0,
              content: d.text,
              location: { start: 0, end: d.text.length },
              vector: v,
            },
          ],
          'test-model',
        );
        return r;
      };
      const pub = await add(
        input('public', 'Orion approval requires two reviewers.', {
          metadata: { state: 'current', approved: true, revision: 3 },
        }),
      );
      const privateDoc = await add(
        input('private', 'Orion compensation requires approval.', {
          access: { mode: 'restricted', principalIds: ['user:alice'] },
        }),
      );
      const options = { mode: 'hybrid', topK: 5, metadata: {}, exact: false };
      let found = await repo.candidates(
        ctx(),
        'manual',
        'Orion',
        v,
        options,
        ['user:bob'],
        'test-model',
      );
      assert.equal(found.lexical.length, 1);
      assert.equal(found.semantic.length, 1);
      assert.ok(found.semantic[0].score > 0.99);
      found = await repo.candidates(
        ctx(),
        'manual',
        'Orion',
        v,
        { ...options, metadata: { state: 'current', approved: true, revision: 3 } },
        ['user:alice'],
        'test-model',
      );
      assert.equal(found.lexical.length, 1);
      assert.equal(found.semantic.length, 1);
      found = await repo.candidates(
        ctx(),
        'manual',
        'Orion',
        v,
        { ...options, sourceIds: [privateDoc.sourceId], exact: true },
        ['user:alice'],
        'test-model',
      );
      assert.equal(found.lexical.length, 1);
      assert.equal(found.semantic.length, 1);
      found = await repo.candidates(
        ctx(),
        'manual',
        'Orion',
        v,
        options,
        ['user:alice'],
        'test-model',
        [pub.sourceId],
      );
      assert.equal(found.lexical.length, 1);
      assert.equal(found.semantic.length, 1);
      assert.equal(await repo.getSource(ctx('beta'), pub.sourceId), null);
      assert.equal(
        (
          await database.transaction(ctx('beta'), (s) =>
            s.all('SELECT * FROM relay.knowledge_chunks'),
          )
        ).length,
        0,
      );
      await assert.rejects(
        repo.upsert(ctx('beta'), input('cross', 'bad collection ownership')),
        /foreign key/,
      );
      await assert.rejects(
        database.transaction(ctx(), (s) =>
          s.query("INSERT INTO relay.knowledge_blob_gc(workspace_id,key) VALUES('beta','cross')"),
        ),
        /row-level security/,
      );
      const outbox = await database.transaction(ctx(), (s) =>
        s.all('SELECT * FROM relay.job_outbox'),
      );
      assert.equal(outbox.length, 2);
      assert.ok(!JSON.stringify(outbox).includes('two reviewers'));
      await assert.rejects(
        database.transaction(ctx(), async (s) => {
          await s.query("UPDATE relay.knowledge_sources SET name='bad' WHERE id=$1", [
            pub.sourceId,
          ]);
          throw Error('rollback');
        }),
      );
      assert.notEqual((await repo.getSource(ctx(), pub.sourceId)).name, 'bad');
      const reindex = await repo.reindex(ctx(), pub.sourceId),
        stale = await repo.claim(ctx(), reindex.jobId, 'stale');
      await repo.cancel(ctx(), reindex.jobId);
      assert.equal(await repo.finish(ctx(), stale, [], 'test-model'), false);
      const refresh = await add(input('public', 'Orion approval now requires three reviewers.'));
      assert.equal(refresh.version, 2);
      assert.equal(refresh.sourceId, pub.sourceId);
      await assert.rejects(
        repo.delete(ctx(), pub.sourceId, 'stale-policy'),
        /changed during authorization/,
      );
      await assert.rejects(
        repo.reindex(ctx(), pub.sourceId, 'stale-policy'),
        /changed during authorization/,
      );
      assert.equal((await repo.getSource(ctx(), pub.sourceId)).deleted, false);
      await repo.delete(ctx(), pub.sourceId);
      found = await repo.candidates(
        ctx(),
        'manual',
        'Orion',
        v,
        options,
        ['user:bob'],
        'test-model',
      );
      assert.equal(found.lexical.length, 0);
      assert.equal(found.semantic.length, 0);
      const vectors = await database.transaction(ctx(), (s) =>
        s.all('SELECT * FROM relay.knowledge_vectors'),
      );
      assert.equal(vectors.length, 1);
      const indexes = (
        await pg.query("SELECT indexname FROM pg_indexes WHERE schemaname='relay'")
      ).rows.map((r) => r.indexname);
      assert.ok(indexes.includes('knowledge_vectors_ann'));
      assert.ok(indexes.includes('knowledge_chunks_keyword'));
      const ext = await pg.query("SELECT extversion FROM pg_extension WHERE extname='vector'");
      console.log(
        'Embedded PostgreSQL pgvector version:',
        ext.rows[0].extversion,
        '(WASM SQL correctness only; not network/concurrency qualification)',
      );
    } finally {
      await pg.close();
    }
  },
);
