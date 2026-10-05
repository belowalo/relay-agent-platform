import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { safeFetch } from '../network.js';
import { descriptor, invalid, ConnectorError, schemaCheck } from './core.js';

export function createMcpAdapter({ fetchImpl = safeFetch } = {}) {
  return {
    validate: (c) =>
      z
        .object({
          transport: z.enum(['streamable-http', 'sse', 'stdio']),
          url: z
            .url()
            .refine((v) => {
              const u = new URL(v);
              return u.protocol === 'https:' && !u.username && !u.password;
            })
            .optional(),
          command: z.string().optional(),
          args: z.array(z.string()).default([]),
          cwd: z.string().optional(),
          auth: z.enum(['none', 'bearer']).default('bearer'),
          readTools: z.array(z.string()).default([]),
          writeTools: z.array(z.string()).default([]),
          resources: z.array(z.string()).default([]),
        })
        .strict()
        .refine((c) => (c.transport === 'stdio' ? !!c.command : !!c.url))
        .refine((c) => !c.readTools.some((t) => c.writeTools.includes(t)))
        .parse(c),
    descriptor: (c) =>
      descriptor(
        'mcp',
        c.auth === 'none' ? 'none' : 'api-key',
        ['discover', 'resources', 'read_resource', ...(c.readTools.length ? ['read_tool'] : [])],
        c.writeTools.length ? ['write_tool'] : [],
      ),
    testAction: 'discover',
    testCapabilities: () => ['discover'],
    validateInput(c, action, i) {
      if (
        (action === 'read_tool' && !c.readTools.includes(i.name)) ||
        (action === 'write_tool' && !c.writeTools.includes(i.name)) ||
        (action === 'read_resource' && !c.resources.includes(i.uri))
      )
        throw new ConnectorError(
          'FORBIDDEN',
          'MCP capability is outside the configured selection.',
        );
    },
    async invoke(a) {
      const client = new Client({ name: 'relay', version: '1.0.0' }, { capabilities: {} });
      let transport;
      if (a.config.transport === 'stdio') {
        if (!a.ports.outbound?.authorizeProcess)
          throw new ConnectorError(
            'FORBIDDEN',
            'Administrator process authorization is required for stdio MCP.',
          );
        await a.ports.outbound.authorizeProcess(a.context, {
          command: a.config.command,
          args: a.config.args,
          cwd: a.config.cwd,
        });
        // No shell, secret command arguments or unrestricted parent environment. Credential goes through one explicit variable.
        const secret = await a.secret();
        transport = new StdioClientTransport({
          command: a.config.command,
          args: a.config.args,
          cwd: a.config.cwd,
          env: secret ? { MCP_ACCESS_TOKEN: secret } : {},
          stderr: 'ignore',
          maxBufferSize: 2_000_000,
        });
      } else {
        const origin = new URL(a.config.url).origin;
        const fetch = async (u, o = {}) => {
          if (new URL(u).origin !== origin)
            throw new ConnectorError('FORBIDDEN', 'MCP transport endpoint changed origin.');
          const secret = await a.secret();
          await a.ports.outbound?.authorize?.(a.context, String(u));
          const headers = new Headers(o.headers);
          if (secret) headers.set('Authorization', 'Bearer ' + secret);
          return fetchImpl(String(u), {
            ...o,
            headers,
            signal: AbortSignal.any([a.signal, o.signal || a.signal]),
            noRedirect: true,
            redirect: 'error',
          });
        };
        transport =
          a.config.transport === 'sse'
            ? new SSEClientTransport(new URL(a.config.url), {
                fetch,
                eventSourceInit: { fetch },
                requestInit: { signal: a.signal },
              })
            : new StreamableHTTPClientTransport(new URL(a.config.url), {
                fetch,
                requestInit: { signal: a.signal },
                reconnectionOptions: {
                  maxRetries: 0,
                  maxReconnectionDelay: 1000,
                  initialReconnectionDelay: 1000,
                  reconnectionDelayGrowFactor: 1,
                },
              });
      }
      const abort = () => {
        void client.close().catch(() => {});
      };
      a.signal.addEventListener('abort', abort, { once: true });
      const opts = { signal: a.signal, timeout: 30000 };
      try {
        a.signal.throwIfAborted();
        await client.connect(transport, { ...opts });
        a.signal.throwIfAborted();
        const caps = client.getServerCapabilities() || {};
        if (a.action === 'discover') {
          const r = caps.tools
            ? await client.listTools({ cursor: a.input.cursor }, opts)
            : { tools: [] };
          return {
            data: {
              capabilities: caps,
              server: client.getServerVersion(),
              tools: r.tools.filter((t) =>
                [...a.config.readTools, ...a.config.writeTools].includes(t.name),
              ),
            },
            nextCursor: r.nextCursor,
          };
        }
        if (['resources', 'read_resource'].includes(a.action)) {
          if (!caps.resources) throw invalid('MCP server does not advertise resources.');
          if (a.action === 'resources') {
            const r = await client.listResources({ cursor: a.input.cursor }, opts);
            return {
              data: r.resources.filter((r) => a.config.resources.includes(r.uri)),
              nextCursor: r.nextCursor,
            };
          }
          return { data: await client.readResource({ uri: a.input.uri }, opts) };
        }
        if (!caps.tools) throw invalid('MCP server does not advertise tools.');
        let cursor, tool;
        const seen = new Set();
        for (let n = 0; n < 100; n++) {
          const page = await client.listTools({ cursor }, opts);
          tool = page.tools.find((t) => t.name === a.input.name);
          if (tool || !page.nextCursor) break;
          if (seen.has(page.nextCursor)) throw invalid('MCP pagination repeated a cursor.');
          seen.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        if (!tool) throw invalid('Selected MCP tool was not discovered.');
        schemaCheck(tool.inputSchema, a.input.arguments || {});
        // Server annotations are descriptive; only administrator configuration can grant read classification.
        await a.secret();
        const r = await client.callTool(
          { name: a.input.name, arguments: a.input.arguments || {} },
          undefined,
          opts,
        );
        if (r.isError)
          throw new ConnectorError('DEPENDENCY_UNAVAILABLE', 'MCP tool returned an error.', {
            outcome: a.action === 'write_tool' ? 'uncertain' : 'failed',
          });
        return { data: r };
      } finally {
        a.signal.removeEventListener('abort', abort);
        if (transport instanceof StreamableHTTPClientTransport && !a.signal.aborted)
          await transport.terminateSession().catch(() => {});
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      }
    },
  };
}
