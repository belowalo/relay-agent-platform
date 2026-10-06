import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../server/foundation/migrations.js';
import { createConnectionRepository } from '../server/connectors/repository.js';
import { validateConnectorConfig } from '../server/connectors/index.js';
import { createKnowledgeRepository } from '../server/knowledge/repository.js';
import { createProductionDocumentSync } from '../server/production/document-sync.js';
test('durable document sync reloads its actor/configuration, resumes without duplicate versions and rejects changed destinations/credentials', async () => {
  const pg = new PGlite({ extensions: { vector } });
  const query = async (sql, args) =>
    args?.length ? pg.query(sql, args) : { rows: (await pg.exec(sql)).at(-1)?.rows || [] };
  try {
    await applyMigrations({ connect: async () => ({ query, release() {} }) });
    const ctx = {
      workspaceId: 'workspace',
      actor: { kind: 'user', id: 'alice' },
      requestId: 'sync-test',
    };
    await pg.query(
      "INSERT INTO relay.workspaces(id,name,created_at) VALUES('workspace','Workspace','now')",
    );
    await pg.query(
      "INSERT INTO relay.collections(id,workspace_id,name,created_at) VALUES('collection','workspace','Documents','now')",
    );
    const database = {
      transaction: (ctx, fn) =>
        pg.transaction((t) =>
          fn({
            context: ctx,
            query: (s, a) => t.query(s, a),
            one: async (s, a) => (await t.query(s, a)).rows[0] || null,
            all: async (s, a) => (await t.query(s, a)).rows,
          }),
        ),
    };
    let revoked = false;
    const security = {
      authorize: async (c) => {
        assert.equal(c.actor.id, 'alice');
        if (revoked) throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' });
      },
    };
    const connections = createConnectionRepository(database, {
      authorize: security.authorize,
      validateConfig: validateConnectorConfig,
    });
    await connections.save(ctx, 'github', {
      kind: 'github',
      config: { repositories: ['acme/relay'] },
      secretRef: { workspaceId: 'workspace', connectionId: 'github', version: 1 },
    });
    const repo = createKnowledgeRepository(database);
    const service = createProductionDocumentSync({
      database,
      security,
      connections,
      connectorPorts: () => ({
        authorize: security.authorize,
        secrets: { resolve: async () => 'test-credential' },
      }),
      outbound: {
        fetch: async () =>
          new Response(
            JSON.stringify({
              type: 'file',
              encoding: 'base64',
              content: Buffer.from('Current policy is 100 CAD.').toString('base64'),
              sha: 'fixed-document-revision',
              html_url: 'https://github.com/acme/relay/blob/main/policy.md',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      },
      pipeline: { upsert: (c, i) => repo.upsert(c, i), delete: (c, id) => repo.remove(c, id) },
      knowledgeRepository: repo,
      blobs: {},
    });
    const input = {
      collectionId: 'collection',
      access: { mode: 'workspace', principalIds: [] },
      repository: 'acme/relay',
      paths: ['policy.md'],
    };
    const a = await service.enqueue(ctx, 'github', input),
      job = (v) => ({
        version: 1,
        id: v.id,
        workspaceId: ctx.workspaceId,
        kind: 'connector.sync',
        resourceId: v.id,
        requestId: ctx.requestId,
      });
    await service.handle(job(a));
    assert.equal(
      (await pg.query('SELECT state FROM relay.document_sync_jobs')).rows[0].state,
      'completed',
    );
    const first = (await pg.query('SELECT id,version FROM relay.knowledge_sources')).rows[0];
    await service.handle(job(a));
    const b = await service.enqueue(ctx, 'github', input, a.syncId);
    await service.handle(job(b));
    assert.deepEqual((await pg.query('SELECT id,version FROM relay.knowledge_sources')).rows, [
      first,
    ]);
    await assert.rejects(
      service.enqueue(
        ctx,
        'github',
        { ...input, access: { mode: 'restricted', principalIds: ['user:alice'] } },
        a.syncId,
      ),
      { code: 'CONFLICT' },
    );
    const c = await service.enqueue(ctx, 'github', input, a.syncId);
    await connections.save(ctx, 'github', {
      kind: 'github',
      config: { repositories: ['acme/relay'] },
      secretRef: { workspaceId: 'workspace', connectionId: 'github', version: 2 },
    });
    await assert.rejects(service.handle(job(c)), { code: 'FORBIDDEN' });
    const d = await service.enqueue(ctx, 'github', input, a.syncId);
    revoked = true;
    await assert.rejects(service.handle(job(d)), { code: 'FORBIDDEN' });
    assert.equal(
      (await pg.query('SELECT error_code FROM relay.document_sync_jobs WHERE id=$1', [d.id]))
        .rows[0].error_code,
      'FORBIDDEN',
    );
    assert.equal(
      (await pg.query('SELECT count(*)::int n FROM relay.knowledge_sources')).rows[0].n,
      1,
    );
  } finally {
    await pg.close();
  }
});
