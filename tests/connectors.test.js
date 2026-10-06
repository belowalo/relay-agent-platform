import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  connectorFor,
  createS3BlobStore,
  synchronizeDocuments,
  createDocumentSource,
} from '../server/connectors/index.js';
import { createSyncState } from '../server/connectors/repository.js';
const context = { workspaceId: 'w1', actor: { kind: 'user', id: 'u1' }, requestId: 'r1' };
const ref = { workspaceId: 'w1', connectionId: 'c1', version: 1 };
const ports = { authorize: async () => {}, secrets: { resolve: async () => 'fixture-secret' } };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const invoke = (c, action, input = {}) => c.invoke(context, { action, input, secretRef: ref });
const ghConfig = { repositories: ['acme/relay'] };
test('vendor results cannot carry resolved credentials into run history or document storage', async () => {
  const c = connectorFor('github', ghConfig, ports, {
    fetchImpl: async () => json({ full_name: 'echo fixture-secret' }),
  });
  await assert.rejects(invoke(c, 'repositories', { repository: 'acme/relay' }), {
    code: 'DEPENDENCY_UNAVAILABLE',
  });
});
test('credential scope, configuration, action discovery and schema boundaries fail before network', async () => {
  let calls = 0;
  const c = connectorFor('github', ghConfig, ports, {
    fetchImpl: async () => {
      calls++;
      return json({});
    },
  });
  assert.equal(c.descriptor.version, '1.0.0');
  await assert.rejects(
    c.invoke(context, {
      action: 'repositories',
      input: { repository: 'acme/relay' },
      secretRef: { ...ref, workspaceId: 'other' },
    }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(invoke(c, 'issues', { repository: 'other/repo' }), { code: 'FORBIDDEN' });
  await assert.rejects(invoke(c, 'document', { repository: 'acme/relay', path: '../secret' }), {
    code: 'VALIDATION_ERROR',
  });
  await assert.rejects(
    invoke(c, 'create_issue', { repository: 'acme/relay', title: 'test', body: 'test' }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(invoke(c, 'unknown'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => connectorFor('github', { repositories: [] }, ports), {
    code: 'VALIDATION_ERROR',
  });
  assert.equal(calls, 0);
});
test('GitHub selected repositories, issue pagination, updated pull requests and file contents', async () => {
  const requests = [];
  const c = connectorFor('github', ghConfig, ports, {
    fetchImpl: async (u, o) => {
      const url = new URL(u);
      requests.push(url);
      assert.equal(o.headers.Authorization, 'Bearer fixture-secret');
      if (url.pathname.endsWith('/issues'))
        return json([{ id: 1, updated_at: '2026-10-01' }], 200, {
          link: '<https://api.github.com/repos/acme/relay/issues?page=2>; rel="next"',
          'x-github-request-id': 'gh-request',
        });
      if (url.pathname.endsWith('/pulls'))
        return json([
          { id: 1, updated_at: '2026-01-01' },
          { id: 2, updated_at: '2026-10-01' },
        ]);
      if (url.pathname.includes('/contents/'))
        return json({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('Relay docs').toString('base64'),
          sha: 'abc',
          html_url: 'https://github.com/acme/relay/blob/main/README.md',
        });
      return json({ full_name: 'acme/relay' });
    },
  });
  const issues = await invoke(c, 'issues', { repository: 'acme/relay', since: '2026-09-01' });
  assert.equal(issues.nextCursor, '2');
  assert.equal(issues.providerRequestId, 'gh-request');
  assert.equal(requests[0].searchParams.get('since'), '2026-09-01');
  assert.deepEqual(
    (await invoke(c, 'pulls', { repository: 'acme/relay', since: '2026-09-01' })).data.map(
      (v) => v.id,
    ),
    [2],
  );
  assert.equal(
    (await invoke(c, 'document', { repository: 'acme/relay', path: 'README.md' })).data.text,
    'Relay docs',
  );
  const health = await c.test(context, ref);
  assert.equal(health.ok, true);
  assert.deepEqual(health.capabilities, ['repositories']);
});
test('write intent binds exact input and ambiguous failure is never retried', async () => {
  let requests = 0,
    intent;
  const c = connectorFor(
    'github',
    ghConfig,
    {
      ...ports,
      actions: {
        execute: async (ctx, i, fn) => {
          intent = i;
          return fn();
        },
      },
    },
    {
      fetchImpl: async () => {
        requests++;
        throw new TypeError('fixture-secret in raw error');
      },
    },
  );
  await assert.rejects(
    invoke(c, 'create_issue', { repository: 'acme/relay', title: 'Title', body: 'Body' }),
    (e) => e.outcome === 'uncertain' && !e.message.includes('fixture-secret'),
  );
  assert.equal(requests, 1);
  assert.equal(intent.requiresApproval, true);
  assert.equal(intent.argumentHash.length, 64);
  assert.equal(intent.input.body, 'Body');
});

test('successful write with malformed response or output schema remains uncertain', async () => {
  const config = {
    endpoint: 'https://api.example.test',
    auth: 'none',
    actions: {
      read: { path: '/items', inputSchema: {}, outputSchema: {} },
      write: {
        path: '/items',
        method: 'POST',
        inputSchema: {},
        outputSchema: { type: 'object', required: ['id'] },
      },
    },
  };
  const p = { authorize: async () => {}, actions: { execute: async (ctx, intent, fn) => fn() } };
  const badJson = connectorFor('rest', config, p, {
    fetchImpl: async () => new Response('malformed'),
  });
  await assert.rejects(badJson.invoke(context, { action: 'write', input: {} }), {
    outcome: 'uncertain',
  });
  const badSchema = connectorFor('rest', config, p, {
    fetchImpl: async () => json({ missing: 'id' }),
  });
  await assert.rejects(badSchema.invoke(context, { action: 'write', input: {} }), {
    outcome: 'uncertain',
  });
});
test('read retries are bounded, respect reset, reauthorize and normalize authentication', async () => {
  let requests = 0,
    checks = 0;
  const c = connectorFor(
    'github',
    ghConfig,
    {
      ...ports,
      authorize: async () => {
        checks++;
      },
    },
    {
      maxAttempts: 3,
      maxRetryDelayMs: 1,
      fetchImpl: async () => (++requests < 3 ? json({}, 503) : json({ id: 1 })),
    },
  );
  await invoke(c, 'repositories', { repository: 'acme/relay' });
  assert.equal(requests, 3);
  assert.ok(checks >= 3);
  const limited = connectorFor('github', ghConfig, ports, {
    fetchImpl: async () => json({ error: 'secret' }, 429, { 'retry-after': '60' }),
  });
  assert.equal((await limited.test(context, ref)).diagnostic.code, 'RATE_LIMITED');
  const auth = connectorFor('github', ghConfig, ports, {
    fetchImpl: async () => json({ secret: 'never display' }, 401),
  });
  const health = await auth.test(context, ref);
  assert.equal(health.diagnostic.code, 'UNAUTHENTICATED');
  assert.ok(!JSON.stringify(health).includes('never display'));
});
test('revocation between attempts prevents another external request', async () => {
  let requests = 0;
  const c = connectorFor(
    'github',
    ghConfig,
    {
      ...ports,
      authorize: async () => {
        if (requests) throw new Error('revoked private detail');
      },
    },
    {
      maxRetryDelayMs: 1,
      fetchImpl: async () => {
        requests++;
        return json({}, 503);
      },
    },
  );
  await assert.rejects(invoke(c, 'repositories', { repository: 'acme/relay' }));
  assert.equal(requests, 1);
});
test('timeout aborts a pending request and does not retry', async () => {
  let calls = 0;
  const c = connectorFor('github', ghConfig, ports, {
    timeoutMs: 10,
    fetchImpl: async (u, { signal }) => {
      calls++;
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(invoke(c, 'repositories', { repository: 'acme/relay' }), {
      retryable: false,
    });
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});
test('Slack history cursors, scoped search, approved message actions and missing scope', async () => {
  const seen = [];
  const c = connectorFor(
    'slack',
    { channels: ['C123'] },
    { ...ports, actions: { execute: async (ctx, intent, fn) => fn() } },
    {
      fetchImpl: async (u, o) => {
        seen.push({ u: new URL(u), o });
        if (u.includes('search.messages'))
          return json({
            ok: true,
            messages: {
              matches: [
                { text: 'selected', channel: { id: 'C123' } },
                { text: 'forbidden', channel: { id: 'C999' } },
              ],
              paging: { page: 1, pages: 2 },
            },
          });
        if (u.includes('conversations.history'))
          return json({
            ok: true,
            messages: [{ ts: '1.1', text: 'history' }],
            response_metadata: { next_cursor: 'cursor-2' },
          });
        return json({ ok: true, ts: '2.1' });
      },
    },
  );
  assert.equal(
    (await invoke(c, 'history', { channel: 'C123', since: '1.0' })).nextCursor,
    'cursor-2',
  );
  const search = await invoke(c, 'search', { channel: 'C123', query: 'status' });
  assert.equal(search.data.length, 1);
  assert.equal(search.nextCursor, '2');
  assert.match(seen[1].u.searchParams.get('query'), /in:C123/);
  await invoke(c, 'post_message', { channel: 'C123', text: 'fixture only' });
  assert.equal(seen[2].o.method, 'POST');
  await assert.rejects(invoke(c, 'history', { channel: 'C999' }), { code: 'FORBIDDEN' });
  const denied = connectorFor('slack', { channels: ['C123'] }, ports, {
    fetchImpl: async () => json({ ok: false, error: 'missing_scope' }),
  });
  assert.equal((await denied.test(context, ref)).diagnostic.code, 'FORBIDDEN');
});
test('Drive selection, exports, change checkpoints, removals and moved files', async () => {
  const requests = [];
  const c = connectorFor('google-drive', { folders: ['folder'], files: ['selected'] }, ports, {
    fetchImpl: async (u) => {
      const v = new URL(u);
      requests.push(v);
      if (v.pathname.endsWith('startPageToken')) return json({ startPageToken: 'start' });
      if (v.pathname.endsWith('/changes'))
        return json({
          newStartPageToken: 'end',
          changes: [
            { fileId: 'selected', file: { id: 'selected', version: '2' } },
            { fileId: 'deleted', removed: true },
            { fileId: 'moved', file: { id: 'moved', parents: ['outside'], name: 'private' } },
          ],
        });
      if (v.pathname.endsWith('/files'))
        return json({
          files: [
            {
              id: 'inside',
              name: 'doc',
              parents: ['folder'],
              mimeType: 'text/plain',
              version: '1',
            },
          ],
          nextPageToken: 'page2',
        });
      if (v.pathname.endsWith('/export')) return new Response('Export text');
      return json({
        id: v.pathname.split('/').at(-1),
        name: 'Doc',
        parents: [v.pathname.endsWith('/outside') ? 'other' : 'folder'],
        mimeType: 'application/vnd.google-apps.document',
        version: '2',
      });
    },
  });
  assert.equal((await invoke(c, 'start_cursor')).nextCursor, 'start');
  assert.equal((await invoke(c, 'files')).nextCursor, 'page2');
  const changes = await invoke(c, 'changes', { cursor: 'start' });
  assert.equal(changes.nextCursor, 'end');
  assert.equal(changes.checkpoint, true);
  assert.deepEqual(changes.data[2], { fileId: 'moved', removed: true });
  const doc = await invoke(c, 'document', { fileId: 'inside' });
  assert.equal(doc.data.bytes.toString(), 'Export text');
  assert.equal(requests.at(-1).searchParams.get('mimeType'), 'text/plain');
  await assert.rejects(invoke(c, 'document', { fileId: 'outside' }), { code: 'FORBIDDEN' });
});
test('REST authentication, input/output schemas, link scope and controlled idempotency header', async () => {
  const config = {
    endpoint: 'https://api.example.test/v1',
    auth: 'api-key',
    actions: {
      list: {
        path: '/items',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', required: ['items'] },
        pagination: { mode: 'cursor', nextPath: 'meta.next' },
      },
      save: {
        path: '/items/{id}',
        method: 'PUT',
        inputSchema: { type: 'object', required: ['id'] },
        outputSchema: { type: 'object' },
        idempotencyHeader: 'Idempotency-Key',
      },
    },
  };
  let header;
  const c = connectorFor(
    'rest',
    config,
    { ...ports, actions: { execute: async (ctx, intent, fn) => fn() } },
    {
      fetchImpl: async (u, o) => {
        header = o.headers;
        return json({ items: [], meta: { next: 'next' } });
      },
    },
  );
  assert.equal((await invoke(c, 'list')).nextCursor, 'next');
  assert.equal(header['X-API-Key'], 'fixture-secret');
  await c.invoke(context, {
    action: 'save',
    input: { id: '123' },
    secretRef: ref,
    idempotencyKey: 'action-123',
  });
  assert.equal(header['Idempotency-Key'], 'action-123');
  const links = connectorFor(
    'rest',
    { ...config, actions: { list: { ...config.actions.list, pagination: { mode: 'link' } } } },
    ports,
    { fetchImpl: async () => json({ items: [] }) },
  );
  await assert.rejects(invoke(links, 'list', { cursor: 'https://evil.test/items' }), {
    code: 'VALIDATION_ERROR',
  });
  const malformed = connectorFor('rest', config, ports, {
    fetchImpl: async () => json({ wrong: true }),
  });
  await assert.rejects(invoke(malformed, 'list'), { code: 'VALIDATION_ERROR' });
});
test('S3 object ingestion, prefix restriction, conditional shared blob writes and workspace isolation', async () => {
  const commands = [];
  const clientFactory = () => ({
    send: async (cmd) => {
      commands.push(cmd);
      if (cmd.constructor.name === 'ListObjectsV2Command')
        return { Contents: [{ Key: 'docs/a', ETag: 'etag' }], NextContinuationToken: 'next' };
      if (cmd.constructor.name === 'GetObjectCommand')
        return { Body: Readable.from(['object text']), ContentType: 'text/plain', ETag: 'etag' };
      return {};
    },
    destroy() {},
  });
  const s3ports = {
    ...ports,
    secrets: {
      resolve: async () => JSON.stringify({ accessKeyId: 'fixture', secretAccessKey: 'fixture' }),
    },
  };
  const c = connectorFor('s3', { bucket: 'relay-fixture', prefix: 'docs/' }, s3ports, {
    clientFactory,
  });
  assert.equal((await invoke(c, 'objects')).nextCursor, 'next');
  assert.equal(
    (await invoke(c, 'document', { key: 'docs/a' })).data.bytes.toString(),
    'object text',
  );
  await assert.rejects(invoke(c, 'document', { key: 'other/a' }), { code: 'FORBIDDEN' });
  const blobs = createS3BlobStore(
    { bucket: 'relay-fixture', prefix: 'blobs/' },
    { ...s3ports, secretRef: ref, clientFactory },
  );
  const b = await blobs.put(context, 'b1', Buffer.from('hello'), 'text/plain');
  assert.equal(b.bytes, 5);
  assert.equal(commands.at(-1).input.IfNoneMatch, '*');
  assert.equal(commands.at(-1).input.Key, 'blobs/w1/b1');
  assert.equal((await blobs.get(context, 'b1')).toString(), 'object text');
  await assert.rejects(blobs.get({ ...context, workspaceId: 'w2' }, 'b1'), { code: 'FORBIDDEN' });
});
test('PostgreSQL uses restricted role, READ ONLY, local limits, parameters and closes on failure', async () => {
  const queries = [];
  let closed = 0;
  const clientFactory = () => ({
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      return sql.includes('pg_roles')
        ? { rows: [{ rolsuper: false, rolbypassrls: false }] }
        : { rows: [{ id: 1 }] };
    },
    end: async () => {
      closed++;
    },
  });
  const p = {
    ...ports,
    secrets: { resolve: async () => JSON.stringify({ user: 'reader', password: 'fixture' }) },
    outbound: { authorizeDatabase: async () => {} },
  };
  const config = {
    host: 'db.example.test',
    database: 'relay',
    queries: { items: 'SELECT id FROM public.items WHERE category=$1' },
  };
  const c = connectorFor('postgresql', config, p, { clientFactory });
  await invoke(c, 'query', { queryId: 'items', parameters: ['docs'] });
  assert.ok(queries.some((q) => q.sql === 'BEGIN READ ONLY'));
  assert.ok(queries.some((q) => q.sql.includes('LIMIT 100') && q.params[0] === 'docs'));
  assert.equal(closed, 1);
  await assert.rejects(invoke(c, 'query', { queryId: 'not-configured' }), {
    code: 'VALIDATION_ERROR',
  });
  const unsafe = connectorFor('postgresql', config, p, {
    clientFactory: () => ({
      connect: async () => {},
      query: async () => ({ rows: [{ rolsuper: true, rolbypassrls: false }] }),
      end: async () => {
        closed++;
      },
    }),
  });
  await assert.rejects(invoke(unsafe, 'health'), { code: 'FORBIDDEN' });
  assert.equal(closed, 2);
});
test('synchronization checkpoints only after ingest, deduplicates revisions, and deletes mapped tombstones', async () => {
  const records = new Map([['deleted', { sourceId: 'old', revision: '1' }]]);
  let cursor,
    upserts = 0,
    deletes = 0;
  const checkpoint = {
    cursor: null,
    assertCurrent: async () => {},
    getItem: async (id) => records.get(id),
    recordItem: async (id, v) => records.set(id, v),
    commitCursor: async (c) => {
      cursor = c;
    },
  };
  const args = {
    connector: {},
    secretRef: ref,
    documents: {
      upsert: async () => {
        upserts++;
        return { sourceId: 'new', version: 1, jobId: 'job' };
      },
      delete: async () => {
        deletes++;
      },
    },
    state: { withLease: async (ctx, id, fn) => fn(checkpoint) },
    sourceId: 'sync1',
    signal: AbortSignal.timeout(10000),
    loadPage: async () => ({
      items: [
        { externalId: 'new', revision: '2' },
        { externalId: 'deleted', removed: true },
        { externalId: 'unselected', removed: true },
      ],
      nextCursor: 'checkpoint',
      checkpoint: true,
    }),
    loadDocument: async () => ({ text: 'doc' }),
  };
  await synchronizeDocuments(context, args);
  assert.equal(upserts, 1);
  assert.equal(deletes, 1);
  assert.equal(cursor, 'checkpoint');
  await synchronizeDocuments(context, args);
  assert.equal(upserts, 1);
  let committed = false;
  await assert.rejects(
    synchronizeDocuments(context, {
      ...args,
      documents: {
        ...args.documents,
        upsert: async () => {
          throw new Error('ingest failed');
        },
      },
      state: {
        withLease: async (ctx, id, fn) =>
          fn({
            ...checkpoint,
            getItem: async () => null,
            commitCursor: async () => {
              committed = true;
            },
          }),
      },
    }),
  );
  assert.equal(committed, false);
});
test('Drive bootstrap captures change token before enumeration and resumes incremental mode', async () => {
  const actions = [];
  const source = createDocumentSource(
    'google-drive',
    {},
    { collectionId: 'coll', access: { mode: 'workspace', principalIds: [] } },
  );
  const connector = {
    invoke: async (ctx, call) => {
      actions.push(call.action);
      return call.action === 'start_cursor'
        ? { nextCursor: 'before' }
        : call.action === 'files'
          ? { data: [{ id: 'f1', version: '1', mimeType: 'text/plain' }] }
          : { data: [], nextCursor: 'after', checkpoint: true };
    },
  };
  const first = await source.loadPage({
    context,
    connector,
    secretRef: ref,
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(actions, ['start_cursor', 'files']);
  assert.equal(JSON.parse(first.nextCursor).token, 'before');
  const next = await source.loadPage({
    context,
    connector,
    secretRef: ref,
    cursor: first.nextCursor,
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(JSON.parse(next.nextCursor).token, 'after');
});
test('expired synchronization lease rejects checkpoints without mutating cursor', async () => {
  let mutations = 0;
  const state = createSyncState(
    {
      transaction: async (ctx, fn) =>
        fn({
          one: async (sql) => (sql.startsWith('UPDATE') ? { cursor: null, generation: 1 } : null),
          query: async () => {
            mutations++;
          },
        }),
    },
    { authorize: async () => {} },
  );
  await assert.rejects(
    state.withLease(context, 'sync', (c) => c.commitCursor('new')),
    { code: 'CONFLICT' },
  );
  assert.equal(mutations, 1); // only final lease release
});
