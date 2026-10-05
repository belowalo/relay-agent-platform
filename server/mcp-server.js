import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { redact, safeError } from './db.js';

export function registerApplicationMcp(app, access, { invoke, status }) {
  app.post('/api/apps/:aid/mcp', access, async (req, res, next) => {
    const application = req.application;
    const server = new McpServer({ name: 'relay-' + application.id, version: '0.3.0' });
    const wrap = (fn) => async (args) => {
      try {
        const value = redact(application.workspace_id, await fn(args));
        return {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: redact(application.workspace_id, safeError(error)) }],
        };
      }
    };
    server.registerTool(
      'invoke_workflow',
      {
        description: `Start ${application.name}. Returns a durable run id. Poll get_run for completion; waiting runs need a human decision in Relay.`,
        inputSchema: { input: z.unknown(), conversationId: z.string().max(200).optional() },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      wrap(({ input, conversationId }) => invoke(application, input, conversationId)),
    );
    server.registerTool(
      'get_run',
      {
        description: 'Get status, output, usage, and steps for a run created by this application.',
        inputSchema: { runId: z.string().max(100) },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      wrap(({ runId }) => status(application, runId)),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) next(error);
    }
  });
  app.all('/api/apps/:aid/mcp', access, (req, res) =>
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ error: 'Use stateless Streamable HTTP POST requests' }),
  );
}
