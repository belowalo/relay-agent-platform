import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createConnectionRepository, createSyncState } from '../server/connectors/repository.js';
import { validateConnectorConfig, connectorFor } from '../server/connectors/index.js';
const context = { workspaceId: 'w1', actor: { kind: 'user', id: 'u1' }, requestId: 'r1' };
test('embedded PostgreSQL engine: connector migration, RLS, rotation, disconnection and durable fenced checkpoints', async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE SCHEMA relay;');
    await pg.exec(
      await fs.readFile(
        new URL('../server/migrations/postgres/0400-connectors.sql', import.meta.url),
        'utf8',
      ),
    );
    await pg.exec(
      'CREATE ROLE relay_connector_fixture; GRANT USAGE ON SCHEMA relay TO relay_connector_fixture; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO relay_connector_fixture; SET ROLE relay_connector_fixture;',
    );
    const database = {
      transaction: async (ctx, fn) => {
        await pg.exec('BEGIN');
        try {
          await pg.query("SELECT set_config('relay.workspace_id',$1,true)", [ctx.workspaceId]);
          const result = await fn({
            one: async (sql, params) => (await pg.query(sql, params)).rows[0] || null,
            query: (sql, params) => pg.query(sql, params),
          });
          await pg.exec('COMMIT');
          return result;
        } catch (e) {
          await pg.exec('ROLLBACK');
          throw e;
        }
      },
    };
    const repository = createConnectionRepository(database, {
      authorize: async () => {},
      validateConfig: validateConnectorConfig,
    });
    const connection = {
      kind: 'github',
      config: { repositories: ['acme/relay'] },
      secretRef: { workspaceId: 'w1', connectionId: 'c1', version: 1 },
    };
    await repository.save(context, 'c1', connection);
    await repository.initializeSync(context, 's1', 'c1');
    assert.equal((await repository.get(context, 'c1')).secretRef.version, 1);
    await assert.rejects(repository.get({ ...context, workspaceId: 'w2' }, 'c1'), {
      code: 'FORBIDDEN',
    });
    const state = createSyncState(database, { authorize: async () => {} });
    await state.withLease(context, 's1', async (checkpoint) => {
      await checkpoint.recordItem('external-doc', {
        sourceId: 'doc1',
        revision: 'rev1',
        removed: false,
      });
      await checkpoint.commitCursor('page2');
      await assert.rejects(
        state.withLease(context, 's1', () => {}),
        { code: 'CONFLICT' },
      );
    });
    await state.withLease(context, 's1', async (checkpoint) => {
      assert.equal(checkpoint.cursor, 'page2');
      assert.equal((await checkpoint.getItem('external-doc')).sourceId, 'doc1');
    });
    await repository.save(context, 'c1', {
      ...connection,
      secretRef: { ...connection.secretRef, version: 2 },
    });
    assert.equal((await repository.get(context, 'c1')).secretRef.version, 2);
    await state.withLease(context, 's1', async (checkpoint) => {
      await repository.disconnect(context, 'c1');
      await assert.rejects(checkpoint.commitCursor('stale'), { code: 'CONFLICT' });
    });
    await assert.rejects(repository.get(context, 'c1'), { code: 'FORBIDDEN' });
    await assert.rejects(
      state.withLease(context, 's1', () => {}),
      { code: 'CONFLICT' },
    );
    assert.equal(
      (
        await database.transaction(context, (s) =>
          s.one('SELECT cursor FROM relay.connector_sync WHERE id=$1', ['s1']),
        )
      ).cursor,
      'page2',
    );
    assert.equal(
      (
        await database.transaction({ ...context, workspaceId: 'w2' }, (s) =>
          s.query('SELECT id FROM relay.connector_connections', []),
        )
      ).rows.length,
      0,
    );
  } finally {
    await pg.close();
  }
});
test('embedded PostgreSQL engine: actual read-only query execution and restricted role checks', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "CREATE TABLE public.docs(id integer, category text); INSERT INTO public.docs VALUES(1,'docs'),(2,'other'); CREATE ROLE relay_reader; GRANT SELECT ON public.docs TO relay_reader; SET ROLE relay_reader;",
    );
    const connector = connectorFor(
      'postgresql',
      {
        host: 'fixture.test',
        database: 'fixture',
        queries: {
          selected: 'SELECT id FROM public.docs WHERE category=$1',
          forbidden:
            "WITH inserted AS (INSERT INTO public.docs VALUES(3,'docs') RETURNING id) SELECT * FROM inserted",
        },
      },
      {
        authorize: async () => {},
        secrets: {
          resolve: async () => JSON.stringify({ user: 'relay_reader', password: 'fixture' }),
        },
        outbound: { authorizeDatabase: async () => {} },
      },
      {
        clientFactory: () => ({
          connect: async () => {},
          query: (sql, params) => db.query(sql, params),
          end: async () => {
            await db.exec('ROLLBACK');
          },
        }),
      },
    );
    const call = (queryId) =>
      connector.invoke(context, {
        action: 'query',
        input: { queryId, parameters: ['docs'] },
        secretRef: { workspaceId: 'w1', connectionId: 'c1', version: 1 },
      });
    assert.deepEqual((await call('selected')).data, [{ id: 1 }]);
    await assert.rejects(call('forbidden'));
    assert.equal((await db.query('SELECT count(*) FROM public.docs')).rows[0].count, 2);
  } finally {
    await db.close();
  }
});
