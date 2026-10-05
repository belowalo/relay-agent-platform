import Ajv from 'ajv';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { all, one, exec, id, now, decode, encode, decrypt, hash, redact } from './db.js';
import { safeFetch, responseText, checkURL } from './network.js';
import { readable } from './knowledge.js';
export const ajv = new Ajv({ allErrors: true, strict: false });
export function validateSchema(schema, value) {
  if (!schema || !Object.keys(schema).length) return;
  const validator = ajv.compile(schema);
  if (!validator(value))
    throw new Error('Schema validation failed: ' + ajv.errorsText(validator.errors));
}
export function getTool(wid, toolId) {
  const t = one('SELECT * FROM tools WHERE workspace_id=? AND id=?', wid, toolId);
  if (!t) throw new Error('Tool was not found in this workspace');
  return { ...t, config: decode(t.config) };
}
export function credentialHeaders(wid, connectionId) {
  if (!connectionId) return {};
  const c = one('SELECT secret FROM connections WHERE id=? AND workspace_id=?', connectionId, wid);
  if (!c) throw new Error('Credential is outside this workspace');
  const secret = decrypt(c.secret);
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}
export const toolHandlers = {
  async http(ctx, c, input) {
    const method = (c.method || 'GET').toUpperCase();
    let url = String(c.url || input?.url || '');
    url = url.replace(/\{\{([^}]+)\}\}/g, (_, key) =>
      encodeURIComponent(input?.[key.trim()] ?? ''),
    );
    const headers = {
      Accept: 'application/json',
      ...c.headers,
      ...credentialHeaders(ctx.wid, c.connectionId),
    };
    const options = { method, headers, signal: ctx.signal };
    if (!['GET', 'HEAD'].includes(method)) {
      options.body = encode(c.body ?? input);
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = ctx.actionKey;
    }
    const r = await safeFetch(url, options, !!c.allowPrivate);
    if (!r.ok) throw new Error(`HTTP request returned ${r.status}`);
    const text = await responseText(r);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },
  async custom(ctx, c, input) {
    return toolHandlers.http(ctx, c, input);
  },
  async web(ctx, c, input) {
    const r = await safeFetch(c.url || input?.url || String(input), { signal: ctx.signal });
    if (!r.ok) throw new Error(`Webpage returned HTTP ${r.status}`);
    return { url: c.url || input?.url, text: readable(await responseText(r)) };
  },
  async search(ctx, c, input) {
    const url = new URL(c.url);
    url.searchParams.set('q', input?.query || String(input));
    url.searchParams.set('format', 'json');
    const r = await safeFetch(
      url.href,
      { headers: credentialHeaders(ctx.wid, c.connectionId), signal: ctx.signal },
      !!c.allowPrivate,
    );
    if (!r.ok) throw new Error(`Search endpoint returned ${r.status}`);
    const data = JSON.parse(await responseText(r));
    return (data.results || [])
      .slice(0, Number(c.limit) || 5)
      .map((r) => ({ title: r.title, url: r.url, content: r.content }));
  },
  async file(ctx, c, input) {
    const operation = c.operation || 'list';
    if (operation === 'list')
      return all('SELECT id,name,created_at FROM artifacts WHERE workspace_id=?', ctx.wid);
    if (operation === 'read') {
      const f = one(
        'SELECT name,content FROM artifacts WHERE id=? AND workspace_id=?',
        c.artifactId || input?.id,
        ctx.wid,
      );
      if (!f) throw new Error('Workspace file was not found');
      return f;
    }
    if (operation === 'write') {
      const fid = id(),
        name = String(c.name || input?.name || 'result.txt').slice(0, 160),
        content = typeof input === 'string' ? input : encode(input);
      exec(
        'INSERT INTO artifacts VALUES(?,?,?,?,?,?)',
        fid,
        ctx.wid,
        ctx.runId,
        name,
        content,
        now(),
      );
      return { id: fid, name };
    }
    throw new Error('Choose list, read, or write');
  },
  async database(ctx, c, input) {
    const sql = String(c.query || input?.query || 'SELECT * FROM documents LIMIT 10');
    if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql))
      throw new Error('Database tools accept one read-only SELECT statement');
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE documents(id TEXT,name TEXT,content TEXT,collection_id TEXT);');
      const insert = database.prepare('INSERT INTO documents VALUES(?,?,?,?)');
      for (const row of all(
        'SELECT id,name,content,collection_id FROM sources WHERE workspace_id=?',
        ctx.wid,
      ))
        insert.run(row.id, row.name, row.content, row.collection_id);
      database.exec('PRAGMA query_only=ON');
      return database.prepare('SELECT * FROM (' + sql.replace(/;\s*$/, '') + ') LIMIT 1000').all();
    } finally {
      database.close();
    }
  },
  async mcp(ctx, c, input) {
    await checkURL(c.url, !!c.allowPrivate);
    const client = new Client({ name: 'relay', version: '0.1.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(c.url), {
      requestInit: { headers: credentialHeaders(ctx.wid, c.connectionId), signal: ctx.signal },
      fetch: (url, options) =>
        safeFetch(String(url), { ...options, signal: ctx.signal }, !!c.allowPrivate),
    });
    try {
      await client.connect(transport);
      if (c.operation === 'list') return await client.listTools();
      if (!c.toolName) throw new Error('Select an MCP tool name');
      return await client.callTool({ name: c.toolName, arguments: input ?? {} }, undefined, {
        signal: ctx.signal,
        timeout: 30000,
      });
    } finally {
      await client.close().catch(() => {});
    }
  },
};
export function isSideEffect(tool) {
  const c = tool.config;
  return (
    c.sideEffect === true ||
    (tool.kind === 'mcp' && c.operation !== 'list') ||
    (tool.kind === 'file' && c.operation === 'write') ||
    (['http', 'custom'].includes(tool.kind) &&
      !['GET', 'HEAD'].includes((c.method || 'GET').toUpperCase()))
  );
}
export class ToolApprovalRequired extends Error {
  constructor() {
    super('Human approval is required before executing this tool');
  }
}
export async function executeTool(ctx, tool, input, callId = 'main') {
  ctx.assertLease?.();
  validateSchema(tool.config.inputSchema, input);
  const handler = toolHandlers[tool.kind];
  if (!handler) throw new Error(`Unsupported tool: ${tool.kind}`);
  const actionKey = hash(`${ctx.runId}:${ctx.stepId}:${tool.id}:${callId}`);
  const previous = one('SELECT * FROM actions WHERE id=?', actionKey);
  if (previous?.status === 'completed') return decode(previous.result);
  if (tool.config.requireApproval) {
    if (!one('SELECT id FROM steps WHERE id=?', ctx.stepId))
      throw new Error('Test approval-protected tools through a workflow component');
    const approval = one('SELECT * FROM tool_approvals WHERE id=?', actionKey);
    const inputHash = hash(encode(input));
    if (approval && approval.input_hash !== inputHash)
      throw new Error('Approved tool input changed; start a new run to review it');
    if (approval?.status === 'rejected') throw new Error('Tool approval was rejected');
    if (approval?.status !== 'approved') {
      if (!approval)
        exec(
          'INSERT INTO tool_approvals VALUES(?,?,?,?,?,?,?,?)',
          actionKey,
          ctx.stepId,
          tool.id,
          tool.name,
          encode(input),
          inputHash,
          'pending',
          now(),
        );
      ctx.emit?.('approval.tool', { tool: tool.name, input, actionKey });
      throw new ToolApprovalRequired();
    }
  }
  if (previous && isSideEffect(tool))
    throw new Error(
      'External action outcome is uncertain. Reconcile the action before starting a new run; automatic replay is disabled.',
    );
  if (!previous)
    exec(
      'INSERT INTO actions(id,workspace_id,run_id,step_id,tool_id,status,result,error,created_at,side_effect) VALUES(?,?,?,?,?,?,?,?,?,?)',
      actionKey,
      ctx.wid,
      ctx.runId,
      ctx.stepId,
      tool.id,
      'started',
      null,
      null,
      now(),
      isSideEffect(tool) ? 1 : 0,
    );
  else exec("UPDATE actions SET status='started',error=NULL WHERE id=?", actionKey);
  ctx.emit?.('tool.started', { tool: tool.name, input, actionKey });
  try {
    const result = redact(ctx.wid, await handler({ ...ctx, actionKey }, tool.config, input));
    ctx.assertLease?.();
    validateSchema(tool.config.outputSchema, result);
    exec("UPDATE actions SET status='completed',result=? WHERE id=?", encode(result), actionKey);
    ctx.emit?.('tool.completed', { tool: tool.name, output: result, actionKey });
    return result;
  } catch (e) {
    ctx.assertLease?.();
    exec(
      "UPDATE actions SET status='failed',error=? WHERE id=?",
      String(e.message).slice(0, 500),
      actionKey,
    );
    throw e;
  }
}
