import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RelayClient } from '../sdk/javascript/relay.mjs';
import { freeTestPort } from './helpers/port.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-test-'));
const port = await freeTestPort();
const origin = `http://127.0.0.1:${port}`;
const execute = promisify(execFile);
let server,
  fixture,
  fixtureUrl,
  cookie,
  wid,
  logs = '',
  writes = 0;
const calls = new Map();
const node = (id, kind, config = {}) => ({
  id,
  type: 'relay',
  position: { x: 0, y: 0 },
  data: { kind, label: id, config },
});
const graph = (...middle) => {
  const nodes = [node('input', 'input'), ...middle, node('output', 'output')];
  return {
    nodes,
    edges: nodes
      .slice(1)
      .map((n, i) => ({ id: nodes[i].id + '-' + n.id, source: nodes[i].id, target: n.id })),
  };
};
const w = (url) => `/api/w/${wid}${url}`;
async function request(url, body, method, auth = cookie) {
  const response = await fetch(origin + url, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function ok(url, body, method, auth) {
  const r = await request(url, body, method, auth);
  assert.ok(r.status < 300, `${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function start() {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), ALLOW_PRIVATE_NETWORK: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => {
    logs += b;
  });
  server.stderr.on('data', (b) => {
    logs += b;
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/api/health')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Runtime server failed: ' + logs);
}
async function stop() {
  if (server?.exitCode === null && server.signalCode === null) {
    const stopped = new Promise((r) => server.once('exit', r));
    server.kill();
    await stopped;
  }
}
async function wait(id, statuses = ['completed', 'failed', 'cancelled']) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const run = await ok(w('/runs/' + id));
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 70));
  }
  throw new Error('Runtime run timed out');
}
async function workflow(g) {
  return ok(w('/workflows'), { name: 'Runtime coverage', graph: g });
}
async function run(g, input, mode = 'preview') {
  const flow = await workflow(g);
  return wait((await ok(w(`/workflows/${flow.id}/runs`), { input, mode })).id);
}
async function connection(endpoint, config = {}) {
  return ok(w('/connections'), {
    name: 'Fixture',
    provider: 'openai-compatible',
    endpoint: fixtureUrl + endpoint,
    model: endpoint.slice(1) || 'fixture',
    secret: 'runtime-fixture-key',
    config: { allowPrivate: true, ...config },
  });
}
before(async () => {
  fixture = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    calls.set(req.url, (calls.get(req.url) || 0) + 1);
    if (req.url.startsWith('/limited/')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'rate_limit' } }));
      return;
    }
    if (req.url.startsWith('/unauthorized/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/action') {
      writes++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ writes, input: body }));
      return;
    }
    if (req.url === '/embeddings') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: body.input.map((t, i) => ({
            index: i,
            embedding: /physician|doctor/i.test(t) ? [1, 0] : [0, 1],
          })),
        }),
      );
      return;
    }
    if (req.url === '/rerank') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          results: body.documents
            .map((t, index) => ({ index, relevance_score: t.includes('Preferred') ? 0.99 : 0.2 }))
            .reverse(),
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url.startsWith('/tool-broken/')) {
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'partial', function: { name: 'lookup', arguments: '{' } },
                  ],
                },
              },
            ],
          }) +
          '\n\n',
      );
      setTimeout(() => res.destroy(), 25);
      return;
    }
    if (req.url.startsWith('/broken/')) {
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Partial text' } }] }) + '\n\n',
      );
      setTimeout(() => res.destroy(), 25);
      return;
    }
    const tools = body.tools || [];
    if (tools.length && !body.messages.some((m) => m.role === 'tool')) {
      res.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: tools.map((t, index) => ({
                    index,
                    id: 'call-' + index,
                    function: {
                      name: t.function.name,
                      arguments: JSON.stringify({ message: 'Reviewed action' }),
                    },
                  })),
                },
              },
            ],
          }) +
          '\n\n',
      );
    } else {
      const content = tools.length ? 'Action reviewed and completed' : body.messages[0].content;
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    }
    res.write(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  await start();
  const account = await request(
    '/api/auth/register',
    { name: 'Runtime Tester', email: 'runtime@relay.test', password: 'Runtime-password-2026' },
    undefined,
    '',
  );
  assert.equal(account.status, 201);
  cookie = account.headers.get('set-cookie').split(';')[0];
  wid = account.data.workspaceId;
});
after(async () => {
  await stop();
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  if (
    !path
      .resolve(directory)
      .startsWith(path.resolve(os.tmpdir()) + path.sep + 'relay-runtime-test-')
  )
    throw new Error('Unsafe cleanup directory');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('guardrails fail closed before external actions and redact structured data', async () => {
  const blocked = await run(
    graph(
      node('policy', 'guardrail', { blockedTerms: ['Delete-all'] }),
      node('write', 'tool', { kind: 'http', method: 'POST', url: fixtureUrl + '/action' }),
    ),
    'DELETE-ALL',
  );
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.error, /restricted phrase/);
  assert.equal(writes, 0);
  const guarded = await run(
    graph(
      node('policy', 'guardrail', {
        schema: { type: 'object', required: ['email'] },
        redactEmails: true,
        redactTerms: ['account-123'],
      }),
    ),
    { email: 'person@example.test', note: 'account-123', count: 7 },
  );
  assert.deepEqual(guarded.output, { email: '[email redacted]', note: '[redacted]', count: 7 });
  assert.equal(
    (await run(graph(node('policy', 'guardrail', { maxChars: 3 })), 'oversize')).status,
    'failed',
  );
  assert.equal(
    (
      await run(
        graph(node('policy', 'guardrail', { schema: { type: 'object', required: ['email'] } })),
        {},
      )
    ).status,
    'failed',
  );
});

test('fallback routing, actual connection pricing, encrypted cache, and prompt variables', async () => {
  const primary = await connection('/limited');
  const backup = await connection('/backup', { inputPrice: 2, outputPrice: 4 });
  const config = {
    connectionId: primary.id,
    fallbackConnectionIds: [backup.id],
    instructions: 'Answer for {{input.name}} about {{task.topic}}.',
    cacheTtlSeconds: 60,
  };
  const g = graph(node('model', 'model', config));
  const first = await run(g, { name: 'Taylor', topic: 'runtime testing' }, 'live');
  assert.equal(first.status, 'completed');
  assert.match(first.output, /Taylor about runtime testing/);
  assert.ok(first.events.some((e) => e.type === 'model.fallback'));
  assert.equal(first.usage.estimatedCost, 0.00008);
  const before = calls.get('/backup/chat/completions');
  const second = await run(g, { name: 'Taylor', topic: 'runtime testing' }, 'live');
  assert.equal(calls.get('/backup/chat/completions'), before);
  assert.equal(second.usage.inputTokens, 0);
  assert.ok(second.events.some((e) => e.type === 'model.cache'));
  const db = new DatabaseSync(path.join(directory, 'relay.sqlite'));
  try {
    const row = db.prepare('SELECT response FROM model_cache WHERE workspace_id=?').get(wid);
    assert.ok(row);
    assert.ok(!row.response.includes('Taylor'));
  } finally {
    db.close();
  }
  await ok(w('/model-cache'), undefined, 'DELETE');
  await run(g, { name: 'Taylor', topic: 'runtime testing' }, 'live');
  assert.equal(calls.get('/backup/chat/completions'), before + 1);
  const missing = await run(g, { topic: 'missing name' }, 'live');
  assert.match(missing.error, /Prompt variable is missing/);
});

test('no fallback on authentication errors or partial streamed output', async () => {
  const backup = await connection('/unused');
  const auth = await connection('/unauthorized');
  const broken = await connection('/broken');
  const toolBroken = await connection('/tool-broken');
  for (const primary of [auth, broken, toolBroken]) {
    const result = await run(
      graph(
        node('model', 'model', { connectionId: primary.id, fallbackConnectionIds: [backup.id] }),
      ),
      'test',
      'live',
    );
    assert.equal(result.status, 'failed');
  }
  assert.equal(calls.get('/unused/chat/completions') || 0, 0);
});

test('semantic metadata/source filtering, relevance thresholds, diversity and real rerank contract', async () => {
  const embedding = await connection('');
  const collection = await ok(w('/collections'), {
    name: 'Filtered evidence',
    config: {
      retrieval: 'hybrid',
      chunkSize: 200,
      overlap: 0,
      embeddingConnectionId: embedding.id,
      embeddingModel: 'fixture-embedding',
    },
  });
  const sourceIds = [];
  for (const [name, content, team] of [
    ['medical.txt', 'A physician helps a doctor. '.repeat(20), 'medical'],
    ['preferred.txt', 'Preferred physician knowledge.', 'medical'],
    ['mechanic.txt', 'A mechanic fixes an engine.', 'engineering'],
  ]) {
    const form = new FormData();
    form.append('file', new Blob([content]), name);
    const response = await fetch(origin + w(`/collections/${collection.id}/upload`), {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
    const source = await response.json();
    assert.equal(response.status, 201);
    sourceIds.push(source.id);
    await ok(w(`/sources/${source.id}/metadata`), { metadata: { team, public: true } }, 'PUT');
  }
  for (let i = 0; i < 100; i++) {
    const sources = await ok(w(`/collections/${collection.id}/sources`));
    if (sources.every((s) => s.status === 'ready')) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  const search = (options) =>
    ok(w(`/collections/${collection.id}/retrieve`), { query: 'doctor', topK: 10, options });
  const filtered = await search({
    metadata: { team: 'medical', public: true },
    minScore: 0.9,
    maxPerSource: 1,
  });
  assert.equal(filtered.sources.length, 2);
  assert.ok(filtered.sources.every((r) => r.metadata.team === 'medical'));
  assert.equal((await search({ sourceIds: [sourceIds[2]], minScore: 0.9 })).sources.length, 0);
  assert.equal((await search({ nameContains: 'preferred' })).sources[0].source, 'preferred.txt');
  const ranked = await search({
    rerankConnectionId: embedding.id,
    rerankModel: 'rerank-fixture',
    minScore: 0.8,
  });
  assert.equal(ranked.sources.length, 1);
  assert.equal(ranked.sources[0].source, 'preferred.txt');
  assert.equal(ranked.sources[0].reranked, true);
  assert.equal(
    (
      await request(w(`/collections/${collection.id}/retrieve`), {
        query: 'doctor',
        options: { metadata: { 'bad.key': 'x' } },
      })
    ).status,
    400,
  );
});

test('component tests execute an isolated saved component with persistent results', async () => {
  const flow = await workflow(
    graph(
      node('pick', 'transform', { path: 'value' }),
      node('policy', 'guardrail', { blockedTerms: ['restricted'] }),
    ),
  );
  const result = await wait(
    (await ok(w(`/workflows/${flow.id}/nodes/pick/test`), { input: { value: 'restricted' } })).id,
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'restricted');
  assert.equal(result.steps.length, 3);
});
test('evaluations distinguish explicit null expectations and reject incomplete evaluator rules', async () => {
  const flow = await workflow(graph(node('constant', 'transform', { template: 'wrong' })));
  const dataset = await ok(w('/datasets'), {
    name: 'Null expectation',
    cases: [{ input: {}, expected: null }],
  });
  const evaluation = await ok(w('/evaluations'), { workflowId: flow.id, datasetId: dataset.id });
  let result;
  for (let i = 0; i < 100; i++) {
    result = await ok(w('/evaluations/' + evaluation.id));
    if (result.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 80));
  }
  assert.equal(result.cases[0].score, 0);
  for (const type of ['json', 'latency', 'tokens'])
    assert.equal(
      (
        await request(w('/evaluations'), {
          workflowId: flow.id,
          datasetId: dataset.id,
          rules: [{ type }],
        })
      ).status,
      400,
    );
});
test('calendar schedules validate timezones and retention protects active and evaluation runs', async () => {
  const { nextSchedule } = await import('../server/schedules.js');
  assert.equal(
    nextSchedule(
      { cronExpression: '0 9 * * 1-5', timezone: 'America/Toronto' },
      Date.parse('2026-03-06T15:00:00Z'),
    ),
    Date.parse('2026-03-09T13:00:00Z'),
  );
  const flow = await workflow(graph());
  const schedule = await ok(w('/schedules'), {
    name: 'Calendar run',
    workflowId: flow.id,
    cronExpression: '0 9 * * 1-5',
    timezone: 'America/Toronto',
    input: 'Scheduled evidence',
  });
  const current = (await ok(w('/schedules'))).find((s) => s.id === schedule.id);
  assert.equal(current.cron_expression, '0 9 * * 1-5');
  assert.equal(
    (
      await request(w('/schedules'), {
        name: 'Invalid',
        workflowId: flow.id,
        cronExpression: '* * * * * *',
        timezone: 'UTC',
        input: '',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(w('/schedules'), {
        name: 'Invalid zone',
        workflowId: flow.id,
        cronExpression: '* * * * *',
        timezone: 'Invalid/City',
        input: '',
      })
    ).status,
    400,
  );
  const expired = await run(graph(), 'Expired history');
  const body = await workflow({
    nodes: [
      node('input', 'input'),
      node('route', 'condition', { operator: 'equals', value: 'fast' }),
      node('review', 'approval'),
      node('output', 'output'),
    ],
    edges: [
      { id: 'in-route', source: 'input', target: 'route' },
      { id: 'fast', source: 'route', target: 'output', label: 'true' },
      { id: 'review', source: 'route', target: 'review', label: 'false' },
      { id: 'review-out', source: 'review', target: 'output' },
    ],
  });
  const parentFlow = await workflow(
    graph(node('loop', 'loop', { workflowId: body.id, itemsPath: 'items' })),
  );
  const parentId = (
    await ok(w(`/workflows/${parentFlow.id}/runs`), { input: { items: ['fast', 'review'] } })
  ).id;
  let parent = await wait(parentId, ['waiting']);
  for (
    let i = 0;
    i < 100 &&
    !(
      parent.children.some((c) => c.status === 'completed') &&
      parent.children.some((c) => c.status === 'waiting')
    );
    i++
  ) {
    await new Promise((r) => setTimeout(r, 80));
    parent = await ok(w('/runs/' + parentId));
  }
  const protectedChild = parent.children.find((c) => c.status === 'completed').id;
  assert.equal(
    (await request(w(`/runs/${parentId}/approve`), { nodeId: 'loop', approved: true })).status,
    400,
  );
  const db = new DatabaseSync(path.join(directory, 'relay.sqlite'));
  let evidence;
  try {
    db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run(
      '2020-01-01T00:00:00.000Z',
      expired.id,
    );
    evidence = db.prepare('SELECT run_id FROM evaluation_cases LIMIT 1').get().run_id;
    db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run(
      '2020-01-01T00:00:00.000Z',
      protectedChild,
    );
    db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run(
      '2020-01-01T00:00:00.000Z',
      evidence,
    );
  } finally {
    db.close();
  }
  assert.equal((await ok(w('/history/purge'), {})).deleted, 0);
  await ok(
    w('/settings'),
    { name: 'Runtime workspace', settings: { historyRetentionDays: 30 } },
    'PUT',
  );
  assert.ok((await ok(w('/history/purge'), {})).deleted >= 1);
  assert.equal((await request(w('/runs/' + expired.id))).status, 404);
  assert.equal((await ok(w('/runs/' + evidence))).id, evidence);
  assert.equal((await ok(w('/runs/' + protectedChild))).id, protectedChild);
  await ok(w(`/runs/${parentId}/cancel`), {});
  await ok(
    w('/settings'),
    { name: 'Runtime workspace', settings: { historyRetentionDays: 0 } },
    'PUT',
  );
});

test('agent-selected tool approval survives restart and resumes exact arguments once', async () => {
  const model = await connection('/approve');
  const tool = await ok(w('/tools'), {
    name: 'Reviewed write',
    kind: 'http',
    config: {
      method: 'POST',
      url: fixtureUrl + '/action',
      allowPrivate: true,
      requireApproval: true,
    },
  });
  const flow = await workflow(
    graph(
      node('agent', 'agent', {
        connectionId: model.id,
        toolIds: [tool.id],
        instructions: 'Use the reviewed tool',
        maxSteps: 3,
      }),
    ),
  );
  const rid = (
    await ok(w(`/workflows/${flow.id}/runs`), { input: 'Perform reviewed action', mode: 'live' })
  ).id;
  const waiting = await wait(rid, ['waiting']);
  assert.equal(writes, 0);
  assert.equal(waiting.approvals[0].input.message, 'Reviewed action');
  assert.equal(waiting.steps.find((s) => s.node_id === 'agent').checkpoint, undefined);
  const count = calls.get('/approve/chat/completions');
  await stop();
  await start();
  assert.equal((await ok(w('/runs/' + rid))).status, 'waiting');
  await ok(w(`/runs/${rid}/approve`), { nodeId: 'agent', approved: true });
  const done = await wait(rid);
  assert.equal(done.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(calls.get('/approve/chat/completions'), count + 1);
  assert.equal(done.usage.inputTokens, 40);
  assert.equal(done.approvals.length, 0);
  const rejectId = (
    await ok(w(`/workflows/${flow.id}/runs`), { input: 'Do not permit', mode: 'live' })
  ).id;
  await wait(rejectId, ['waiting']);
  await ok(w(`/runs/${rejectId}/approve`), { nodeId: 'agent', approved: false });
  assert.equal((await wait(rejectId)).status, 'failed');
  assert.equal(writes, 1);
});

test('MCP server, JavaScript/Python SDK and CLI use frozen application runs and token isolation', async () => {
  const flow = await workflow(graph(node('pick', 'transform', { path: 'question' })));
  const published = await ok(w('/applications'), {
    name: 'Runtime SDK',
    workflowId: flow.id,
    settings: { public: true, mode: 'preview' },
  });
  const relay = new RelayClient({
    baseUrl: origin,
    applicationId: published.id,
    token: published.token,
  });
  const queued = await relay.invoke({ question: 'JavaScript works' });
  const result = await relay.waitRun(queued.id);
  assert.equal(result.output, 'JavaScript works');
  const observed = [];
  for await (const event of relay.events(queued.id)) observed.push(event);
  assert.ok(observed.some((e) => e.type === 'run.completed'));
  const client = new Client({ name: 'relay-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(origin + `/api/apps/${published.id}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${published.token}` } } },
  );
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      ['invoke_workflow', 'get_run'],
    );
    const call = await client.callTool({
      name: 'invoke_workflow',
      arguments: { input: { question: 'MCP works' } },
    });
    const id = call.structuredContent.id;
    await relay.waitRun(id);
    const status = await client.callTool({ name: 'get_run', arguments: { runId: id } });
    assert.equal(status.structuredContent.output, 'MCP works');
    const wrongApp = await ok(w('/applications'), {
      name: 'Other runtime',
      workflowId: flow.id,
      settings: { mode: 'preview' },
    });
    const other = new RelayClient({
      baseUrl: origin,
      applicationId: wrongApp.id,
      token: wrongApp.token,
    });
    const foreign = await other.invoke({ question: 'private run' });
    const denied = await client.callTool({ name: 'get_run', arguments: { runId: foreign.id } });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
  }
  assert.equal(
    (
      await fetch(origin + `/api/apps/${published.id}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  const env = {
    ...process.env,
    RELAY_BASE_URL: origin,
    RELAY_APP_ID: published.id,
    RELAY_APP_TOKEN: published.token,
  };
  const cli = await execute(
    process.execPath,
    ['bin/relay.mjs', 'invoke', '--input', '{"question":"CLI works"}', '--wait'],
    { env },
  );
  assert.equal(JSON.parse(cli.stdout).output, 'CLI works');
  const script =
    'import os,sys,json;sys.path.insert(0,"sdk/python");from relay import RelayClient;r=RelayClient(os.environ["RELAY_BASE_URL"],os.environ["RELAY_APP_ID"],os.environ["RELAY_APP_TOKEN"]);q=r.invoke({"question":"Python works"});print(json.dumps(r.wait_run(q["id"])))';
  const python = await execute('python', ['-c', script], { env });
  assert.equal(JSON.parse(python.stdout).output, 'Python works');
  await ok(w(`/applications/${published.id}/rotate`), {});
  await assert.rejects(() => relay.getRun(queued.id), /401/);
});
