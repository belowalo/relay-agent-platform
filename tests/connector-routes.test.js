import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerConnectorRoutes } from '../server/connectors/routes.js';
test('connector routes load authoritative configuration and reject caller secret/config/action-key injection', async () => {
  const app = express();
  app.use(express.json());
  let lookedUp = 0;
  const context = { workspaceId: 'w1', actor: { kind: 'user', id: 'u1' }, requestId: 'r1' };
  registerConnectorRoutes(app, {
    contextFor: async () => context,
    connections: {
      get: async (ctx, id) => {
        assert.equal(ctx.workspaceId, 'w1');
        assert.equal(id, 'c1');
        lookedUp++;
        return {
          kind: 'github',
          config: { repositories: ['acme/relay'] },
          secretRef: { workspaceId: 'w1', connectionId: 'c1', version: 1 },
        };
      },
    },
    portsFor: async () => ({
      authorize: async () => {},
      secrets: { resolve: async () => 'fixture' },
    }),
    options: {
      fetchImpl: async () =>
        new Response('{"full_name":"acme/relay"}', {
          headers: { 'Content-Type': 'application/json' },
        }),
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const root = `http://127.0.0.1:${server.address().port}/connectors/c1`;
  try {
    assert.equal((await (await fetch(root + '/capabilities')).json()).id, 'github');
    const post = (suffix, body) =>
      fetch(root + suffix, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const r = await post('/invoke', {
      action: 'repositories',
      input: { repository: 'acme/relay' },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.full_name, 'acme/relay');
    for (const field of ['secretRef', 'config', 'workspaceId', 'idempotencyKey']) {
      const response = await post('/invoke', {
        action: 'repositories',
        input: { repository: 'acme/relay' },
        [field]: 'injected',
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }
    const write = await post('/invoke', {
      action: 'create_issue',
      input: { repository: 'acme/relay', title: 'fixture', body: 'fixture' },
    });
    assert.equal(write.status, 403);
    assert.equal((await (await post('/test', {})).json()).ok, true);
    assert.ok(lookedUp > 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
