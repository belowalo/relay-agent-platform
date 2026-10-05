import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
test('MCP Streamable HTTP discovers and invokes a real SDK server tool', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-test-'));
  process.env.DATA_DIR = temp;
  const transports = new Map();
  const servers = [];
  const fixture = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = body ? JSON.parse(body) : undefined;
      let transport = transports.get(req.headers['mcp-session-id']);
      if (!transport && message?.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => transports.set(sid, transport),
        });
        const server = new McpServer({ name: 'relay-fixture', version: '1.0.0' });
        server.registerTool(
          'greet',
          { description: 'Greet by name', inputSchema: { name: z.string() } },
          async ({ name }) => ({ content: [{ type: 'text', text: `Hello ${name}` }] }),
        );
        servers.push(server);
        await server.connect(transport);
      }
      if (!transport) {
        res.statusCode = 400;
        res.end('Session required');
        return;
      }
      await transport.handleRequest(req, res, message);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  try {
    const { toolHandlers } = await import('../server/tools.js');
    const url = `http://127.0.0.1:${fixture.address().port}/mcp`;
    const ctx = { wid: 'test-workspace', signal: AbortSignal.timeout(10000) };
    const discovery = await toolHandlers.mcp(
      ctx,
      { url, operation: 'list', allowPrivate: true },
      {},
    );
    assert.equal(discovery.tools[0].name, 'greet');
    const result = await toolHandlers.mcp(
      ctx,
      { url, operation: 'call', toolName: 'greet', allowPrivate: true },
      { name: 'Orion' },
    );
    assert.equal(result.content[0].text, 'Hello Orion');
  } finally {
    for (const server of servers) await server.close();
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
    const { db } = await import('../server/db.js');
    db.close();
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error('Unexpected test directory');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
