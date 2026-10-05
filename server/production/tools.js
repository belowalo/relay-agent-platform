import { connectorFor } from '../connectors/index.js';
import { stableHash } from '../connectors/core.js';
import { PlatformError } from '../foundation/errors.js';
import { assertCredentialDestination, responseText } from '../network.js';
const decode = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const deny = () => {
  throw new PlatformError(
    'FORBIDDEN',
    'Tool authorization or frozen connection binding is no longer valid.',
  );
};
export function createProductionTools({ database, security, connections, outbound }) {
  async function binding(s, tool) {
    const id = tool.config.connectionId;
    if (!id) return { toolHash: stableHash({ kind: tool.kind, config: tool.config }) };
    const row = await s.one(
      tool.kind === 'connector'
        ? "SELECT id,kind,config,secret_ref,generation FROM relay.connector_connections WHERE workspace_id=$1 AND id=$2 AND status='active'"
        : 'SELECT id,provider,endpoint,config FROM relay.connections WHERE workspace_id=$1 AND id=$2',
      [s.context.workspaceId, id],
    );
    if (!row) deny();
    return {
      connectionId: id,
      hash: stableHash(row),
      toolHash: stableHash({ kind: tool.kind, config: tool.config }),
    };
  }
  async function check(ctx, tool) {
    await security.authorize(ctx, 'connector.invoke', { kind: 'tool', id: tool.id });
    const current = await database.transaction(ctx, (s) => binding(s, tool));
    if (!tool.binding || stableHash(current) !== stableHash(tool.binding)) deny();
  }
  async function assertAction(ctx, tool, actionId, input, intent) {
    if (!actionId) deny();
    await check(ctx, tool);
    const row = await database.transaction(ctx, (s) =>
      s.one(
        `SELECT a.*,r.actor,r.lease_generation AS current_generation,r.lease_until,r.status AS run_status,
      p.status AS approval_status,p.reviewer FROM relay.actions a JOIN relay.runs r ON r.id=a.run_id AND r.workspace_id=a.workspace_id
      JOIN relay.runtime_approvals p ON p.action_id=a.id AND p.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 AND a.id=$2 AND a.status='started' AND a.tool_id=$3
      AND r.status='running' AND r.lease_generation=a.lease_generation AND r.lease_until>(extract(epoch from clock_timestamp())*1000)::bigint`,
        [ctx.workspaceId, actionId, tool.id],
      ),
    );
    if (
      !row ||
      row.argument_hash !== stableHash(input) ||
      row.approval_status !== 'approved' ||
      stableHash(decode(row.actor)) !== stableHash(ctx.actor)
    )
      deny();
    if (
      intent &&
      (intent.argumentHash !== row.argument_hash ||
        intent.connectionId !== tool.config.connectionId ||
        intent.action !== tool.config.action)
    )
      deny();
    await security.authorize({ ...ctx, actor: decode(row.reviewer) }, 'run.approve', {
      kind: 'run',
      id: row.run_id,
    });
  }
  function connectorPorts(ctx, connection, execution) {
    return {
      secrets: security.secrets,
      outbound,
      async authorize(c, request) {
        await security.authorize(c, 'connector.invoke', { kind: 'connection', id: connection.id });
        const live = await connections.get(c, connection.id);
        if (
          stableHash(live.config) !== stableHash(connection.config) ||
          stableHash(live.secretRef) !== stableHash(connection.secretRef) ||
          live.generation !== connection.generation
        )
          deny();
        if (request.secretRef && stableHash(request.secretRef) !== stableHash(live.secretRef))
          deny();
      },
      actions: {
        async execute(c, intent, perform) {
          if (!execution) deny();
          await assertAction(c, execution.tool, execution.actionId, intent.input, intent);
          return perform();
        },
      },
    };
  }
  async function describe(ctx, tool) {
    await check(ctx, tool);
    let effect = 'read',
      inputSchema = tool.config.inputSchema,
      idempotency = 'read-only';
    if (tool.kind === 'connector') {
      const connection = await connections.get(ctx, tool.config.connectionId);
      const d = connectorFor(connection.kind, connection.config, connectorPorts(ctx, connection), {
        fetchImpl: outbound.fetch,
      }).descriptor.actions.find((a) => a.id === tool.config.action);
      if (!d) deny();
      ({ effect, idempotency } = d);
    } else if (['http', 'custom'].includes(tool.kind))
      effect = ['GET', 'HEAD'].includes((tool.config.method || 'GET').toUpperCase())
        ? 'read'
        : 'write';
    else if (tool.kind === 'file') effect = 'write';
    else if (!['web', 'search'].includes(tool.kind))
      throw new PlatformError(
        'VALIDATION_ERROR',
        'Use a configured native connector for this tool type.',
      );
    return {
      effect,
      inputSchema,
      idempotency,
      requiresApproval: effect === 'write',
      metered: false,
    };
  }
  return {
    snapshotTool: async (s, tool) => ({ ...tool, binding: await binding(s, tool) }),
    connectorPorts,
    tools: {
      describe,
      async invoke(ctx, { tool, input, signal, actionId, idempotencyKey }) {
        const descriptor = await describe(ctx, tool);
        if (descriptor.effect === 'write') await assertAction(ctx, tool, actionId, input);
        if (tool.kind === 'connector') {
          const connection = await connections.get(ctx, tool.config.connectionId);
          const connector = connectorFor(
            connection.kind,
            connection.config,
            connectorPorts(ctx, connection, { tool, actionId }),
            { fetchImpl: outbound.fetch },
          );
          return connector.invoke(ctx, {
            action: tool.config.action,
            input,
            secretRef: connection.secretRef,
            signal,
            idempotencyKey,
          });
        }
        const c = tool.config;
        if (tool.kind === 'file') {
          const data = JSON.stringify(input),
            name = String(c.name || 'Workflow output').slice(0, 100);
          if (Buffer.byteLength(data) > 1_000_000)
            throw new PlatformError('BUDGET_EXCEEDED', 'Artifact is too large.');
          await database.transaction(ctx, (s) =>
            s.query(
              'INSERT INTO relay.artifacts(id,workspace_id,name,content,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
              [actionId, ctx.workspaceId, name, data, new Date().toISOString()],
            ),
          );
          return { data: { id: actionId, name } };
        }
        let url = String(c.url || '');
        if (!url) throw new PlatformError('VALIDATION_ERROR', 'Configure an exact tool URL.');
        url = url.replace(/\{\{([^}]+)\}\}/g, (_, key) =>
          encodeURIComponent(input?.[key.trim()] ?? ''),
        );
        if (tool.kind === 'search') {
          const u = new URL(url);
          u.searchParams.set('q', input?.query || String(input));
          url = u.href;
        }
        const headers = { Accept: 'application/json' },
          method =
            tool.kind === 'web' || tool.kind === 'search'
              ? 'GET'
              : (c.method || 'GET').toUpperCase();
        let credential = '';
        if (c.connectionId) {
          const r = await database.transaction(ctx, (s) =>
            s.one('SELECT endpoint,config FROM relay.connections WHERE workspace_id=$1 AND id=$2', [
              ctx.workspaceId,
              c.connectionId,
            ]),
          );
          if (!r) deny();
          assertCredentialDestination(r.endpoint, url);
          credential = await security.secrets.resolve(ctx, decode(r.config).secretRef);
          headers.Authorization = `Bearer ${credential}`;
        }
        const options = { method, headers, signal, noRedirect: true };
        if (!['GET', 'HEAD'].includes(method)) {
          headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(c.body ?? input);
        }
        const response = await outbound.fetch(url, options);
        if (!response.ok)
          throw new PlatformError('DEPENDENCY_UNAVAILABLE', 'Tool provider rejected the request.');
        let text = await responseText(response, 2_000_000);
        if (credential) text = text.replaceAll(credential, '[REDACTED]');
        if (tool.kind === 'web')
          text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
        try {
          return { data: JSON.parse(text) };
        } catch {
          return { data: text };
        }
      },
    },
  };
}
