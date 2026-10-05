import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { connectorFor } from '../server/connectors/index.js';
import { s3Client } from '../server/connectors/storage.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
const ctx = { workspaceId: 'w1', actor: { kind: 'user', id: 'u1' }, requestId: 'r1' };
test('MCP SDK Streamable HTTP and legacy SSE perform initialize, discovery, calls, resource reads and cleanup', async () => {
  for (const mode of ['streamable-http', 'sse']) {
    const transports = new Map(),
      servers = [];
    let initialized = 0,
      deleted = 0;
    const fixture = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://fixture');
        if (mode === 'sse' && req.method === 'POST') {
          const t = transports.get(u.searchParams.get('sessionId'));
          await t.handlePostMessage(req, res);
          return;
        }
        let body = '';
        if (mode !== 'sse') for await (const c of req) body += c;
        const message = body ? JSON.parse(body) : undefined;
        let transport = transports.get(req.headers['mcp-session-id']);
        if (mode === 'sse' || (!transport && message?.method === 'initialize')) {
          initialized++;
          transport =
            mode === 'sse'
              ? new SSEServerTransport('/messages', res)
              : new StreamableHTTPServerTransport({
                  sessionIdGenerator: () => crypto.randomUUID(),
                  onsessioninitialized: (id) => transports.set(id, transport),
                });
          const server = new McpServer({ name: 'relay-native-mcp-fixture', version: '1.0.0' });
          server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
            content: [{ type: 'text', text }],
          }));
          server.registerTool('secret-tool', { inputSchema: {} }, async () => ({ content: [] }));
          server.registerResource(
            'doc',
            'fixture://doc',
            { mimeType: 'text/plain' },
            async (uri) => ({ contents: [{ uri: uri.href, text: 'resource fixture' }] }),
          );
          servers.push(server);
          await server.connect(transport);
          if (mode === 'sse') {
            transports.set(transport.sessionId, transport);
            return;
          }
        }
        if (req.method === 'DELETE') deleted++;
        if (!transport) {
          res.writeHead(400).end();
          return;
        }
        await transport.handleRequest(req, res, message);
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${fixture.address().port}`;
    try {
      const c = connectorFor(
        'mcp',
        {
          transport: mode,
          url: 'https://fixture.test/mcp',
          auth: 'none',
          readTools: ['echo'],
          resources: ['fixture://doc'],
        },
        { authorize: async () => {} },
        { fetchImpl: (u, o) => fetch(u.replace('https://fixture.test', endpoint), o) },
      );
      const discovery = await c.invoke(ctx, { action: 'discover', input: {} });
      assert.equal(discovery.data.server.name, 'relay-native-mcp-fixture');
      assert.deepEqual(
        discovery.data.tools.map((t) => t.name),
        ['echo'],
      );
      const result = await c.invoke(ctx, {
        action: 'read_tool',
        input: { name: 'echo', arguments: { text: 'MCP protocol fixture' } },
      });
      assert.equal(result.data.content[0].text, 'MCP protocol fixture');
      const resource = await c.invoke(ctx, {
        action: 'read_resource',
        input: { uri: 'fixture://doc' },
      });
      assert.equal(resource.data.contents[0].text, 'resource fixture');
      await assert.rejects(
        c.invoke(ctx, { action: 'read_tool', input: { name: 'secret-tool', arguments: {} } }),
        { code: 'FORBIDDEN' },
      );
      assert.equal(initialized, 3);
      if (mode === 'streamable-http') assert.equal(deleted, 3);
    } finally {
      for (const server of servers) await server.close();
      fixture.closeAllConnections();
      await new Promise((r) => fixture.close(r));
    }
  }
});
test('MCP stdio requires explicit process authorization and uses real SDK subprocess framing', async () => {
  const config = {
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/connector-mcp-stdio.mjs', import.meta.url))],
    auth: 'none',
    readTools: ['echo'],
  };
  const denied = connectorFor('mcp', config, { authorize: async () => {} });
  await assert.rejects(denied.invoke(ctx, { action: 'discover', input: {} }), {
    code: 'FORBIDDEN',
  });
  let granted = 0;
  const c = connectorFor('mcp', config, {
    authorize: async () => {},
    outbound: {
      authorizeProcess: async () => {
        granted++;
      },
    },
  });
  const r = await c.invoke(ctx, {
    action: 'read_tool',
    input: { name: 'echo', arguments: { text: 'stdio fixture' } },
  });
  assert.equal(r.data.content[0].text, 'stdio fixture');
  assert.equal(granted, 1);
});
test('S3 uses real SDK SigV4 signing and XML pagination without external service calls', async () => {
  let request;
  const client = s3Client(
    {
      endpoint: 'https://s3.fixture.test',
      region: 'us-east-1',
      bucket: 'relay-fixture',
      forcePathStyle: true,
    },
    { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
    {
      signal: AbortSignal.timeout(1000),
      authorize: async () => {},
      fetchImpl: async (u, o) => {
        request = { u, o };
        return new Response(
          '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>relay-fixture</Name><Prefix>docs/</Prefix><IsTruncated>true</IsTruncated><Contents><Key>docs/a.txt</Key><ETag>etag</ETag><Size>5</Size></Contents><NextContinuationToken>next-token</NextContinuationToken></ListBucketResult>',
          { headers: { 'Content-Type': 'application/xml' } },
        );
      },
    },
  );
  try {
    const result = await client.send(
      new ListObjectsV2Command({ Bucket: 'relay-fixture', Prefix: 'docs/' }),
    );
    assert.equal(result.NextContinuationToken, 'next-token');
    assert.equal(result.Contents[0].Key, 'docs/a.txt');
    assert.match(request.o.headers.authorization, /AWS4-HMAC-SHA256/);
    assert.equal(new URL(request.u).searchParams.get('prefix'), 'docs/');
  } finally {
    client.destroy();
  }
});
