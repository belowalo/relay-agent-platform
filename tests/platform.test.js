import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as OTPAuth from 'otpauth';
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-platform-tests-'));
const port = 14321,
  origin = `http://127.0.0.1:${port}`;
let server,
  owner,
  viewer,
  outsider,
  wid,
  templates,
  mock,
  mockPort,
  externalActions = 0,
  toolRounds = 0;
let logs = '';
async function start() {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: testDir, ALLOW_PRIVATE_NETWORK: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => (logs += b));
  server.stderr.on('data', (b) => (logs += b));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + '/api/health')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Server startup failed: ' + logs);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await new Promise((r) => server.once('exit', r));
}
async function request(url, body, method, cookie = owner) {
  const r = await fetch(origin + url, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  return { status: r.status, data, headers: r.headers };
}
async function ok(url, body, method, cookie) {
  const r = await request(url, body, method, cookie);
  assert.ok(r.status < 300, `${url}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function account(name) {
  const r = await request(
    '/api/auth/register',
    { name, email: `${name.toLowerCase()}@relay.test`, password: 'Test-password-2026' },
    undefined,
    '',
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { cookie: r.headers.get('set-cookie').split(';')[0], wid: r.data.workspaceId };
}
const w = (url) => `/api/w/${wid}${url}`;
const node = (id, kind, config = {}) => ({
  id,
  type: 'relay',
  position: { x: 0, y: 0 },
  data: { kind, label: id, config },
});
const edge = (source, target, branch) => ({
  id: source + '-' + target,
  source,
  target,
  ...(branch ? { label: branch, data: { branch } } : {}),
});
function graph(middle = []) {
  const nodes = [node('input', 'input'), ...middle, node('output', 'output')];
  return { nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)) };
}
async function workflow(name, g) {
  return await ok(w('/workflows'), { name, graph: g });
}
async function run(f, input = 'A real persisted task', mode = 'preview') {
  return (await ok(w(`/workflows/${f.id}/runs`), { input, mode })).id;
}
async function waitRun(rid, statuses = ['completed', 'failed', 'cancelled'], timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await ok(w(`/runs/${rid}`));
    if (statuses.includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Run timeout: ' + rid);
}
before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/models' || req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'judge-model' }] }));
      return;
    }
    if (req.url === '/embeddings') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: data.input.map((t) => ({
            embedding: /physician|doctor|illness|sick|medical/i.test(t) ? [1, 0, 0] : [0, 1, 0],
          })),
        }),
      );
      return;
    }
    if (req.url === '/crawl' || req.url === '/second') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        req.url === '/crawl'
          ? '<h1>Crawl first</h1><p>Orion briefing</p><a href="/second">Second</a><a href="/blocked">Blocked</a>'
          : '<h1>Crawl second</h1><p>Planning evidence</p>',
      );
      return;
    }
    if (req.url === '/robots.txt') {
      res.end('User-agent: *\nDisallow: /blocked');
      return;
    }
    if (req.url === '/action') {
      externalActions++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ saved: true, count: externalActions }));
      return;
    }
    if (req.url === '/failure') {
      externalActions++;
      res.statusCode = 500;
      res.end('Failed');
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"done":true}');
      }, 2500);
      return;
    }
    if (req.url === '/search?') {
      res.end('{}');
      return;
    }
    if (req.url.startsWith('/search')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          results: [
            {
              title: 'Test evidence',
              url: 'https://example.com',
              content: 'Verified search fixture',
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<html><script>ignore me</script><h1>Relay knowledge</h1><p>Workspace boundaries protect Orion launch plans.</p></html>',
      );
      return;
    }
    if (req.url === '/repo') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          full_name: 'fixture/repo',
          stargazers_count: 17,
          description: 'Fixture API',
        }),
      );
      return;
    }
    if (req.url === '/v1/messages') {
      res.setHeader('Content-Type', 'text/event-stream');
      for (const frame of [
        { type: 'message_start', message: { usage: { input_tokens: 7 } } },
        { type: 'content_block_delta', delta: { text: 'Anthropic fixture answer' } },
        { type: 'message_delta', usage: { output_tokens: 4 } },
      ])
        res.write('data: ' + JSON.stringify(frame) + '\n\n');
      res.end();
      return;
    }
    if (req.url === '/v1/chat/completions') {
      if (['quota-error', 'rate-error', 'auth-error'].includes(data.model)) {
        res.statusCode = data.model === 'auth-error' ? 401 : 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code:
                data.model === 'quota-error' ? 'credit_balance_exhausted' : 'rate_limit_exceeded',
              type: data.model === 'quota-error' ? 'insufficient_quota' : 'invalid_request_error',
              message: 'sensitive provider detail',
            },
          }),
        );
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      let content = 'Recorded provider fixture response';
      const system = data.messages?.[0]?.content || '';
      if (system.includes('You supervise')) {
        const ids = [...system.matchAll(/([a-z]+): .*?\(/g)].map((m) => m[1]);
        content = JSON.stringify({
          plan: 'Delegate fixture tasks',
          assignments: ids.map((nodeId) => ({ nodeId, task: 'Analyze assigned evidence' })),
        });
      }
      if (data.tools?.length && !data.messages.some((m) => m.role === 'tool')) {
        toolRounds++;
        res.write(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'fixture-call',
                        function: { name: data.tools[0].function.name, arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            }) +
            '\n\n',
        );
      } else {
        if (system.includes('Evaluate the answer'))
          content = JSON.stringify({ score: 0.8, explanation: 'Fixture rubric grade' });
        else if (system.includes('Return JSON conforming'))
          content = JSON.stringify({ answer: 'structured fixture' });
        for (const chunk of content.match(/.{1,20}/gs) || [])
          res.write(
            'data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n',
          );
      }
      res.write(
        'data: ' +
          JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } }) +
          '\n\ndata: [DONE]\n\n',
      );
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('Unknown fixture route');
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockPort = mock.address().port;
  await start();
  const a = await account('Owner');
  owner = a.cookie;
  wid = a.wid;
  const b = await account('Viewer');
  viewer = b.cookie;
  outsider = (await account('Outsider')).cookie;
  templates = (await ok(w('/catalog'))).templates;
});
after(async () => {
  await stop();
  await new Promise((r) => mock.close(r));
  if (
    !path.resolve(testDir).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(testDir).startsWith('relay-platform-tests-')
  )
    throw new Error('Unexpected temporary directory');
  fs.rmSync(testDir, { recursive: true, force: true });
});
test('accounts, workflow revisions, optimistic saves, and persisted reload', async () => {
  const f = await workflow(
    'Persist me',
    graph([node('map', 'transform', { template: 'Result {{topic}}' })]),
  );
  const saved = await ok(
    w(`/workflows/${f.id}`),
    { revision: 1, name: 'Persisted name', graph: f.graph },
    'PUT',
  );
  assert.equal(saved.revision, 2);
  assert.equal((await ok(w(`/workflows/${f.id}`))).name, 'Persisted name');
  assert.equal(
    (await request(w(`/workflows/${f.id}`), { revision: 1, graph: f.graph }, 'PUT')).status,
    409,
  );
  assert.equal((await ok(w(`/workflows/${f.id}/versions`))).length, 2);
  const rid = await run(saved, { topic: 'Orion' });
  const result = await waitRun(rid);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'Result Orion');
  assert.equal(result.steps.length, 3);
  assert.ok(result.events.some((e) => e.type === 'node.completed'));
});
test('orchestrator assignments, concurrent workers, and consolidated downstream result', async () => {
  const f = await workflow('Specialist team', templates.find((t) => t.id === 'team').graph);
  const rid = await run(f, 'Compare two launch options');
  const r = await waitRun(rid);
  assert.equal(r.status, 'completed', r.error);
  assert.ok(r.events.some((e) => e.type === 'orchestrator.plan'));
  assert.equal(r.events.filter((e) => e.type === 'agent.assignment').length, 2);
  assert.ok(r.events.some((e) => e.type === 'model.token'));
  assert.match(r.output, /Development preview/);
  const analyst = r.steps.find((s) => s.node_id === 'research'),
    strategy = r.steps.find((s) => s.node_id === 'strategy');
  assert.ok(
    new Date(strategy.started_at) < new Date(analyst.finished_at),
    'Workers overlap in time',
  );
  assert.equal(r.usage.inputTokens || 0, 0);
});
test('conditions route branches; parallel/join and graph validation execute', async () => {
  const g = {
    nodes: [
      node('input', 'input'),
      node('condition', 'condition', { path: 'score', operator: 'gt', value: 5 }),
      node('yes', 'transform', { template: 'YES' }),
      node('no', 'transform', { template: 'NO' }),
      node('join', 'join'),
      node('output', 'output'),
    ],
    edges: [
      edge('input', 'condition'),
      edge('condition', 'yes', 'true'),
      edge('condition', 'no', 'false'),
      edge('yes', 'join'),
      edge('no', 'join'),
      edge('join', 'output'),
    ],
  };
  const f = await workflow('Routing', g);
  const r = await waitRun(await run(f, { score: 8 }));
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.steps.find((s) => s.node_id === 'no').status, 'skipped');
  assert.equal(r.output, 'YES');
  const invalid = { ...g, edges: [...g.edges, edge('join', 'condition')] };
  assert.ok(
    (await ok(w('/validate'), { graph: invalid })).errors.some((e) => e.includes('Cycles')),
  );
});
test('human checkpoints survive restart and require editor approval', async () => {
  const f = await workflow('Review', templates.find((t) => t.id === 'approval').graph);
  const rid = await run(f);
  const waiting = await waitRun(rid, ['waiting']);
  assert.equal(waiting.steps.find((s) => s.node_id === 'approve').status, 'waiting');
  await stop();
  await start();
  const recovered = await ok(w(`/runs/${rid}`));
  assert.equal(recovered.status, 'waiting');
  await ok(w(`/runs/${rid}/approve`), { nodeId: 'approve', approved: true });
  const result = await waitRun(rid);
  assert.equal(result.status, 'completed');
  assert.ok(result.events.some((e) => e.type === 'approval.accepted'));
});
test('invitations, backend role enforcement, and workspace isolation', async () => {
  assert.equal((await request(w('/workflows'), undefined, undefined, outsider)).status, 403);
  const invite = await ok(w('/invitations'), { email: 'viewer@relay.test', role: 'viewer' });
  await ok('/api/invitations/accept', { token: invite.token }, undefined, viewer);
  assert.equal((await request(w('/workflows'), undefined, undefined, viewer)).status, 200);
  assert.equal(
    (await request(w('/workflows'), { name: 'Forbidden', graph: graph() }, undefined, viewer))
      .status,
    403,
  );
  assert.equal(
    (await request(w('/connections'), { name: 'Forbidden' }, undefined, viewer)).status,
    403,
  );
  const f = await workflow('Viewer run guard', graph());
  assert.equal(
    (await request(w(`/workflows/${f.id}/runs`), { input: 'no' }, undefined, viewer)).status,
    403,
  );
  const other = (await ok('/api/me', undefined, undefined, outsider)).workspaces[0].id;
  assert.equal((await request(`/api/w/${other}/runs`, undefined, undefined, owner)).status, 403);
});
test('upload, indexing, cited retrieval, workspace-isolated database, and deletion', async () => {
  const c = await ok(w('/collections'), {
    name: 'Orion knowledge',
    config: { chunkSize: 300, overlap: 40 },
  });
  const body = new FormData();
  body.set(
    'file',
    new Blob([
      'Orion launch is planned for November. The research team must review deployment risk.',
    ]),
    'orion.md',
  );
  const s = await ok(w(`/collections/${c.id}/upload`), body);
  await new Promise((r) => setTimeout(r, 150));
  const result = await ok(w(`/collections/${c.id}/retrieve`), { query: 'Orion launch' });
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0].citation, /orion.md/);
  const dbTool = await ok(w('/tools'), {
    name: 'Knowledge SQL',
    kind: 'database',
    config: { query: 'SELECT name FROM documents' },
  });
  const query = await ok(w(`/tools/${dbTool.id}/test`), { input: {} });
  assert.equal(query.output[0].name, 'orion.md');
  const g = graph([node('knowledge', 'knowledge', { collectionId: c.id })]);
  const f = await workflow('Retrieve', g);
  const r = await waitRun(await run(f, 'Orion'));
  assert.equal(r.output.sources.length, 1);
  const other = (await ok('/api/me', undefined, undefined, outsider)).workspaces[0].id;
  assert.equal(
    (
      await request(
        `/api/w/${other}/collections/${c.id}/retrieve`,
        { query: 'Orion' },
        undefined,
        outsider,
      )
    ).status,
    400,
  );
  await ok(w(`/sources/${s.id}/reindex`), {});
  await new Promise((r) => setTimeout(r, 100));
  await ok(w(`/sources/${s.id}`), undefined, 'DELETE');
  assert.equal(
    (await ok(w(`/collections/${c.id}/retrieve`), { query: 'Orion' })).sources.length,
    0,
  );
});
test('published versions stay immutable; authenticated API, webhook, chat and token rotation', async () => {
  const f = await workflow(
    'Published snapshot',
    graph([node('text', 'transform', { template: 'VERSION ONE' })]),
  );
  const application = await ok(w('/applications'), {
    name: 'Published app',
    workflowId: f.id,
    settings: { public: true, mode: 'preview', welcome: 'Hello', accent: '#b3f576' },
  });
  const altered = structuredClone(f.graph);
  altered.nodes[1].data.config.template = 'VERSION TWO';
  await ok(w(`/workflows/${f.id}`), { revision: 1, graph: altered }, 'PUT');
  const unauth = await request(
    `/api/apps/${application.id}/invoke`,
    { input: 'hi' },
    undefined,
    '',
  );
  assert.equal(unauth.status, 401);
  const invoke = await fetch(origin + `/api/apps/${application.id}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${application.token}`, 'Content-Type': 'application/json' },
    body: '{"input":"hi"}',
  });
  assert.equal(invoke.status, 202);
  const rid = (await invoke.json()).id;
  assert.equal((await waitRun(rid)).output, 'VERSION ONE');
  const chat = await ok(`/apps/${application.id}/invoke`, { input: 'public chat' }, undefined, '');
  assert.equal((await waitRun(chat.id)).output, 'VERSION ONE');
  const webhook = await fetch(origin + `/api/apps/${application.id}/webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${application.token}`, 'Content-Type': 'application/json' },
    body: '{"input":"webhook"}',
  });
  assert.equal(webhook.status, 202);
  await ok(w(`/applications/${application.id}`), { publishLatest: true }, 'PUT');
  const newChat = await ok(
    `/apps/${application.id}/invoke`,
    { input: 'public chat' },
    undefined,
    '',
  );
  assert.equal((await waitRun(newChat.id)).output, 'VERSION TWO');
  const rotated = await ok(w(`/applications/${application.id}/rotate`), {});
  assert.notEqual(rotated.token, application.token);
  const revoked = await fetch(origin + `/api/apps/${application.id}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${application.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(revoked.status, 401);
  assert.match(await (await fetch(origin + '/widget.js')).text(), /createElement\('iframe'\)/);
});
test('local provider adapters stream, record usage, validate structure, and execute assigned tools', async () => {
  const secret = 'test-credential-never-return';
  const connection = await ok(w('/connections'), {
    name: 'Fixture model',
    provider: 'openai-compatible',
    endpoint: `http://127.0.0.1:${mockPort}/v1`,
    model: 'fixture',
    secret,
    config: { allowPrivate: true, inputPrice: 1, outputPrice: 2 },
  });
  assert.ok(!JSON.stringify(connection).includes(secret));
  assert.ok(
    !(await fs.promises.readFile(path.join(testDir, 'relay.sqlite'))).includes(Buffer.from(secret)),
  );
  const testResult = await ok(w(`/connections/${connection.id}/test`), {});
  assert.equal(testResult.usage.inputTokens, 9);
  const file = await ok(w('/tools'), {
    name: 'List workspace files',
    kind: 'file',
    config: { operation: 'list', inputSchema: { type: 'object' } },
  });
  const f = await workflow(
    'Tool-using agent',
    graph([
      node('agent', 'agent', {
        instructions: 'Use your tools to inspect files',
        connectionId: connection.id,
        toolIds: [file.id],
        memory: 'persistent',
      }),
    ]),
  );
  const r = await waitRun(await run(f, 'Inspect files', 'live'));
  assert.equal(r.status, 'completed', r.error);
  assert.ok(r.events.some((e) => e.type === 'tool.completed'));
  assert.equal(r.usage.inputTokens, 18);
  assert.ok(r.usage.estimatedCost > 0);
  assert.ok(toolRounds > 0);
  assert.equal((await ok(w('/memories'))).length, 1);
  const structured = await workflow(
    'Structured model',
    graph([
      node('model', 'model', {
        connectionId: connection.id,
        outputSchema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'string' } },
        },
      }),
    ]),
  );
  assert.equal(
    (await waitRun(await run(structured, 'Answer', 'live'))).output.answer,
    'structured fixture',
  );
  const anthropic = await ok(w('/connections'), {
    name: 'Anthropic fixture',
    provider: 'anthropic',
    endpoint: `http://127.0.0.1:${mockPort}/v1`,
    model: 'fixture',
    secret: 'fixture-only',
    config: { allowPrivate: true },
  });
  const a = await workflow(
    'Anthropic stream',
    graph([node('model', 'model', { connectionId: anthropic.id })]),
  );
  assert.equal((await waitRun(await run(a, 'Hi', 'live'))).output, 'Anthropic fixture answer');
  const exported = await ok(w(`/workflows/${f.id}/versions`));
  assert.ok(!JSON.stringify(exported).includes(secret));
});
test('connection tests distinguish invalid credentials, exhausted quota, and rate limits', async () => {
  for (const [model, message] of [
    ['auth-error', /authentication failed/],
    ['quota-error', /quota is exhausted/],
    ['rate-error', /rate limit reached/],
  ]) {
    const c = await ok(w('/connections'), {
      name: model,
      provider: 'openai-compatible',
      endpoint: `http://127.0.0.1:${mockPort}/v1`,
      model,
      secret: 'fixture-key',
      config: { allowPrivate: true },
    });
    const result = await request(w(`/connections/${c.id}/test`), {});
    assert.equal(result.status, 400);
    assert.match(result.data.error, message);
    assert.ok(!result.data.error.includes('sensitive provider detail'));
  }
  const invalid = await request(w('/connections'), {
    name: 'Pasted env assignment',
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    secret: 'OPENAI_API_KEY=synthetic-key',
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /Paste only the API key value/);
});
test('bounded loops and subworkflows preserve dependency execution', async () => {
  const reusable = await workflow(
    'Reusable mapping',
    graph([node('map', 'transform', { mapping: { value: 'item' } })]),
  );
  const main = await workflow(
    'Loop collection',
    graph([
      node('loop', 'loop', {
        workflowId: reusable.id,
        itemsPath: 'items',
        maxIterations: 3,
        result: 'all',
      }),
    ]),
  );
  const r = await waitRun(await run(main, { items: [{ item: 'A' }, { item: 'B' }] }));
  assert.equal(r.status, 'completed', r.error);
  assert.deepEqual(r.output, [{ value: 'A' }, { value: 'B' }]);
  assert.equal(r.children.length, 2);
  const sub = await workflow(
    'Single reusable',
    graph([node('sub', 'subworkflow', { workflowId: reusable.id })]),
  );
  const s = await waitRun(await run(sub, { item: 'C' }));
  assert.deepEqual(s.output, { value: 'C' });
});
test('HTTP/API, search, webpage and workspace artifact tools have real executors', async () => {
  for (const [kind, config, input, check] of [
    [
      'http',
      { url: `http://127.0.0.1:${mockPort}/repo`, allowPrivate: true },
      {},
      (r) => assert.equal(r.full_name, 'fixture/repo'),
    ],
    ['web', { url: `http://127.0.0.1:${mockPort}/page` }, {}, (r) => assert.match(r.text, /Orion/)],
    [
      'search',
      { url: `http://127.0.0.1:${mockPort}/search`, allowPrivate: true },
      { query: 'Orion' },
      (r) => assert.equal(r[0].title, 'Test evidence'),
    ],
  ]) {
    const tool = await ok(w('/tools'), { name: kind, kind, config });
    check((await ok(w(`/tools/${tool.id}/test`), { input })).output);
  }
  const file = await ok(w('/tools'), {
    name: 'Write report',
    kind: 'file',
    config: { operation: 'write', name: 'report.txt' },
  });
  const result = await ok(w(`/tools/${file.id}/test`), { input: { report: 'Confirmed artifact' } });
  assert.equal(result.output.name, 'report.txt');
  assert.ok((await ok(w('/artifacts'))).some((a) => a.id === result.output.id));
});
test('failure, timeout, immediate cancellation and uncertain-action retry guards', async () => {
  const f = await workflow('Missing live connection', graph([node('model', 'model')]));
  const failed = await waitRun(await run(f, 'test', 'live'));
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Choose a model connection/);
  const preview = await workflow('Cancellation', templates.find((t) => t.id === 'team').graph);
  const rid = await run(preview, 'Long task '.repeat(400));
  await new Promise((r) => setTimeout(r, 160));
  await ok(w(`/runs/${rid}/cancel`), {});
  assert.equal((await waitRun(rid)).status, 'cancelled');
  const t = await ok(w('/tools'), {
    name: 'Uncertain external write',
    kind: 'http',
    config: { url: `http://127.0.0.1:${mockPort}/failure`, method: 'POST', allowPrivate: true },
  });
  const action = await workflow(
    'External action guard',
    graph([node('action', 'tool', { toolId: t.id, retries: 3 })]),
  );
  const count = externalActions;
  const actionRun = await waitRun(await run(action, { action: 'write' }));
  assert.equal(actionRun.status, 'failed');
  assert.equal(externalActions - count, 1);
  const retry = await request(w(`/runs/${actionRun.id}/retry`), {});
  assert.equal(retry.status, 400);
  assert.match(retry.data.error, /uncertain outcomes/);
});
test('run history and audit survive another server restart', async () => {
  const before = await ok(w('/runs'));
  assert.ok(before.length > 10);
  await stop();
  await start();
  const after = await ok(w('/runs'));
  assert.equal(after.length, before.length);
  assert.ok((await ok(w('/audit'))).some((a) => a.action === 'workflow.created'));
  assert.equal((await ok('/api/me')).user.email, 'owner@relay.test');
});

test('timeouts stop read-only calls and safe failed requests can retry', async () => {
  const t = await ok(w('/tools'), {
    name: 'Slow read',
    kind: 'http',
    config: { url: `http://127.0.0.1:${mockPort}/slow`, allowPrivate: true },
  });
  const f = await workflow(
    'Timed request',
    graph([node('read', 'tool', { toolId: t.id, timeoutMs: 1000 })]),
  );
  const r = await waitRun(await run(f));
  assert.equal(r.status, 'failed');
  assert.match(r.error, /timeout|aborted/i);
  await ok(w(`/runs/${r.id}/retry`), {});
  assert.equal((await waitRun(r.id)).status, 'failed');
});
test('nested approvals pause durably without holding an active parent step', async () => {
  const reusable = await workflow(
    'Reusable approval',
    graph([node('approve', 'approval', { prompt: 'Approve nested task' })]),
  );
  const parent = await workflow(
    'Nested approval',
    graph([node('sub', 'subworkflow', { workflowId: reusable.id })]),
  );
  const rid = await run(parent, 'Checkpoint input');
  const waiting = await waitRun(rid, ['waiting']);
  assert.equal(waiting.steps.find((s) => s.node_id === 'sub').status, 'waiting');
  const child = waiting.children[0];
  await waitRun(child.id, ['waiting']);
  await stop();
  await start();
  await ok(w(`/runs/${child.id}/approve`), { nodeId: 'approve', approved: true });
  const done = await waitRun(rid);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.output, 'Checkpoint input');
});
test('publication freezes reusable workflow dependencies and isolates application run access', async () => {
  const reusable = await workflow(
    'Published child',
    graph([node('map', 'transform', { template: 'CHILD ONE' })]),
  );
  const parent = await workflow(
    'Published parent',
    graph([node('sub', 'subworkflow', { workflowId: reusable.id })]),
  );
  const a = await ok(w('/applications'), {
    name: 'Snapshot parent',
    workflowId: parent.id,
    settings: { public: true, mode: 'preview' },
  });
  const other = await ok(w('/applications'), {
    name: 'Other app',
    workflowId: parent.id,
    settings: { public: true, mode: 'preview' },
  });
  const changed = structuredClone(reusable.graph);
  changed.nodes[1].data.config.template = 'CHILD TWO';
  await ok(w(`/workflows/${reusable.id}`), { revision: 1, graph: changed }, 'PUT');
  const invocation = await ok(`/apps/${a.id}/invoke`, { input: 'original' }, undefined, '');
  const result = await waitRun(invocation.id);
  assert.equal(result.output, 'CHILD ONE');
  assert.equal(
    (await request(`/apps/${other.id}/runs/${result.id}`, undefined, undefined, '')).status,
    403,
  );
});
test('private chat is token-gated and cross-origin cookie writes are blocked', async () => {
  const f = await workflow('Private chat', graph());
  const a = await ok(w('/applications'), {
    name: 'Private',
    workflowId: f.id,
    settings: { public: false, mode: 'preview' },
  });
  assert.equal(
    (await request(`/apps/${a.id}/invoke`, { input: 'blocked' }, undefined, '')).status,
    401,
  );
  const r = await fetch(origin + w('/projects'), {
    method: 'POST',
    headers: {
      Cookie: owner,
      Origin: 'https://unrelated.example',
      'Content-Type': 'application/json',
    },
    body: '{"name":"Forbidden"}',
  });
  assert.equal(r.status, 403);
});

test('human waiting time does not consume the workflow execution timeout', async () => {
  const g = graph([node('approve', 'approval', { prompt: 'Wait for a human' })]);
  g.settings = { timeoutMs: 800 };
  const f = await workflow('Pause clock', g);
  const rid = await run(f, 'A human checkpoint');
  await waitRun(rid, ['waiting']);
  await new Promise((r) => setTimeout(r, 1100));
  await ok(w(`/runs/${rid}/approve`), { nodeId: 'approve', approved: true });
  const result = await waitRun(rid);
  assert.equal(result.status, 'completed', result.error);
  assert.ok(result.active_ms < 800);
});

async function waitEvaluation(eid) {
  for (let i = 0; i < 150; i++) {
    const e = await ok(w(`/evaluations/${eid}`));
    if (e.status === 'completed') return e;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Evaluation did not complete');
}
test('frozen evaluation datasets measure regressions between workflow revisions', async () => {
  const f = await workflow(
    'Evaluate transform',
    graph([node('map', 'transform', { template: 'Hello {{name}}' })]),
  );
  const d = await ok(w('/datasets'), {
    name: 'Greeting cases',
    cases: [
      { input: { name: 'Ada' }, expected: 'Hello Ada' },
      { input: { name: 'Lin' }, expected: 'Hello Lin' },
    ],
  });
  const first = await ok(w('/evaluations'), { datasetId: d.id, workflowId: f.id, mode: 'preview' });
  const a = await waitEvaluation(first.id);
  assert.equal(a.summary.passed, 2);
  assert.equal(a.summary.meanScore, 1);
  const saved = await ok(
    w(`/workflows/${f.id}`),
    { revision: 1, graph: graph([node('map', 'transform', { template: 'Goodbye {{name}}' })]) },
    'PUT',
  );
  const second = await ok(w('/evaluations'), { datasetId: d.id, workflowId: f.id });
  const b = await waitEvaluation(second.id);
  assert.equal(b.summary.passed, 0);
  assert.equal(b.workflow_revision, saved.revision);
  const comparison = await ok(w(`/evaluations/${b.id}/compare/${a.id}`));
  assert.equal(comparison.scoreDelta, -1);
  await ok(
    w(`/datasets/${d.id}`),
    { name: 'Edited cases', revision: 1, cases: [{ input: 'New case' }] },
    'PUT',
  );
  assert.equal((await ok(w(`/evaluations/${a.id}`))).dataset_snapshot.cases.length, 2);
  assert.equal(
    (await request(w(`/evaluations/${a.id}`), undefined, undefined, outsider)).status,
    403,
  );
  assert.equal(
    (
      await request(
        w('/datasets'),
        { name: 'Viewer cannot write', cases: [{ input: 'x' }] },
        undefined,
        viewer,
      )
    ).status,
    403,
  );
  const r = await ok(w(`/runs/${a.cases[0].run_id}/feedback`), {
    rating: 1,
    comment: 'Correct answer',
  });
  assert.equal(r.ok, true);
  assert.equal((await ok(w(`/runs/${a.cases[0].run_id}/feedback`)))[0].comment, 'Correct answer');
});
test('LLM judging records actual judge results and includes judge token costs', async () => {
  const c = await ok(w('/connections'), {
    name: 'Evaluation provider',
    provider: 'openai-compatible',
    endpoint: `http://127.0.0.1:${mockPort}/v1`,
    model: 'fixture',
    secret: 'fixture-evaluation-secret',
    config: { allowPrivate: true, inputPrice: 2, outputPrice: 3 },
  });
  assert.deepEqual(await ok(w(`/connections/${c.id}/models`)), ['fixture-model', 'judge-model']);
  const f = await workflow(
    'Live judge case',
    graph([node('model', 'model', { connectionId: c.id })]),
  );
  const d = await ok(w('/datasets'), {
    name: 'Judge cases',
    cases: [{ input: 'Explain the result' }],
  });
  const e = await ok(w('/evaluations'), {
    datasetId: d.id,
    workflowId: f.id,
    mode: 'live',
    judgeConnectionId: c.id,
    threshold: 0.7,
  });
  const detail = await waitEvaluation(e.id);
  assert.equal(detail.summary.inputTokens, 18, JSON.stringify(detail));
  assert.equal(detail.summary.outputTokens, 10);
  assert.equal(detail.summary.meanScore, 0.9);
  assert.equal(detail.cases[0].result.judge.score, 0.8);
  assert.equal(detail.summary.costConfigured, true);
  await ok(
    w(`/connections/${c.id}`),
    {
      name: c.name,
      provider: c.provider,
      endpoint: c.endpoint,
      model: c.model,
      config: { allowPrivate: true },
    },
    'PUT',
  );
  const unknown = await ok(w('/evaluations'), {
    datasetId: d.id,
    workflowId: f.id,
    mode: 'live',
    judgeConnectionId: c.id,
  });
  const unpriced = await waitEvaluation(unknown.id);
  assert.equal(unpriced.summary.estimatedCost, null);
  assert.equal(unpriced.summary.costConfigured, false);
  assert.equal((await ok(w(`/evaluations/${unknown.id}/compare/${e.id}`))).costDelta, null);
});
test('prompts are versioned and concurrent editors cannot overwrite revisions', async () => {
  const p = await ok(w('/prompts'), { name: 'Source policy', content: 'Cite evidence.' });
  await ok(
    w(`/prompts/${p.id}`),
    { name: 'Source policy', content: 'Cite verified evidence.', revision: 1 },
    'PUT',
  );
  assert.equal(
    (
      await request(
        w(`/prompts/${p.id}`),
        { name: 'Source policy', content: 'Overwrite', revision: 1 },
        'PUT',
      )
    ).status,
    409,
  );
  const versions = await ok(w(`/prompts/${p.id}/versions`));
  assert.equal(versions.length, 2);
  assert.equal(versions[1].content, 'Cite evidence.');
  assert.equal(
    (await request(w(`/prompts/${p.id}/versions`), undefined, undefined, outsider)).status,
    403,
  );
});
test('semantic and hybrid retrieval find paraphrases, isolate collections, and delete vectors', async () => {
  const c = await ok(w('/connections'), {
    name: 'Embedding fixture',
    provider: 'openai-compatible',
    endpoint: `http://127.0.0.1:${mockPort}`,
    model: 'fixture',
    secret: 'embedding-fixture',
    config: { allowPrivate: true },
  });
  const coll = await ok(w('/collections'), {
    name: 'Semantic medicine',
    config: { retrieval: 'semantic', embeddingConnectionId: c.id, embeddingModel: 'fixture' },
  });
  for (const [name, text] of [
    ['medical.txt', 'A physician treats patients with illness.'],
    ['mechanical.txt', 'A mechanic repairs engines and wheels.'],
  ]) {
    const f = new FormData();
    f.append('file', new Blob([text]), name);
    await ok(w(`/collections/${coll.id}/upload`), f);
  }
  for (let i = 0; i < 100; i++) {
    if ((await ok(w(`/collections/${coll.id}/sources`))).every((s) => s.status === 'ready')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await ok(w(`/collections/${coll.id}/retrieve`), {
    query: 'A doctor helps sick people',
    topK: 1,
  });
  assert.equal(r.sources[0].source, 'medical.txt');
  assert.equal(r.sources[0].retrieval, 'semantic');
  await ok(
    w(`/collections/${coll.id}`),
    { config: { retrieval: 'hybrid', embeddingConnectionId: c.id, embeddingModel: 'fixture' } },
    'PUT',
  );
  for (let i = 0; i < 100; i++) {
    if ((await ok(w(`/collections/${coll.id}/sources`))).every((s) => s.status === 'ready')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const h = await ok(w(`/collections/${coll.id}/retrieve`), { query: 'physician', topK: 1 });
  assert.equal(h.sources[0].source, 'medical.txt');
  assert.equal(
    (await request(w(`/collections/${coll.id}/retrieve`), { query: 'doctor' }, undefined, outsider))
      .status,
    403,
  );
  const medical = (await ok(w(`/collections/${coll.id}/sources`))).find(
    (s) => s.name === 'medical.txt',
  );
  await ok(w(`/sources/${medical.id}`), undefined, 'DELETE');
  assert.equal(
    (await ok(w(`/collections/${coll.id}/retrieve`), { query: 'doctor', topK: 5 })).sources.length,
    1,
  );
});
test('website crawling indexes linked pages and observes simple robots exclusions', async () => {
  const c = await ok(w('/collections'), { name: 'Crawler collection' }),
    result = await ok(w(`/collections/${c.id}/website`), {
      url: `http://127.0.0.1:${mockPort}/crawl`,
      maxPages: 5,
    });
  assert.equal(result.ids.length, 2);
  const sources = await ok(w(`/collections/${c.id}/sources`));
  assert.equal(sources.length, 2);
  assert.ok(sources.some((s) => s.url.endsWith('/second')));
});
test('MFA gates password login, prevents code replay, and supports one-use recovery', async () => {
  const a = await account('MFATester');
  const setup = await ok(
    '/api/account/mfa/setup',
    { password: 'Test-password-2026' },
    undefined,
    a.cookie,
  );
  const otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) });
  const enabled = await ok(
    '/api/account/mfa/confirm',
    { code: otp.generate() },
    undefined,
    a.cookie,
  );
  assert.equal(enabled.recoveryCodes.length, 8);
  const login = await ok(
    '/api/auth/login',
    { email: 'mfatester@relay.test', password: 'Test-password-2026' },
    undefined,
    '',
  );
  assert.equal(login.mfaRequired, true);
  const invalid = await request(
    '/api/auth/mfa',
    { challenge: login.challenge, code: '000000' },
    undefined,
    '',
  );
  assert.equal(invalid.status, 401);
  const verified = await request(
    '/api/auth/mfa',
    { challenge: login.challenge, code: otp.generate() },
    undefined,
    '',
  );
  assert.equal(verified.status, 200);
  assert.ok(verified.headers.get('set-cookie'));
  const another = await ok(
    '/api/auth/login',
    { email: 'mfatester@relay.test', password: 'Test-password-2026' },
    undefined,
    '',
  );
  assert.equal(
    (
      await request(
        '/api/auth/mfa',
        { challenge: another.challenge, code: otp.generate() },
        undefined,
        '',
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        '/api/auth/mfa',
        { challenge: another.challenge, code: enabled.recoveryCodes[0] },
        undefined,
        '',
      )
    ).status,
    200,
  );
  const third = await ok(
    '/api/auth/login',
    { email: 'mfatester@relay.test', password: 'Test-password-2026' },
    undefined,
    '',
  );
  assert.equal(
    (
      await request(
        '/api/auth/mfa',
        { challenge: third.challenge, code: enabled.recoveryCodes[0] },
        undefined,
        '',
      )
    ).status,
    401,
  );
  await ok(
    '/api/account/mfa/disable',
    { password: 'Test-password-2026', code: enabled.recoveryCodes[1] },
    undefined,
    a.cookie,
  );
  await ok(
    '/api/account/password',
    { current: 'Test-password-2026', password: 'New-password-2026' },
    undefined,
    a.cookie,
  );
  assert.equal((await request('/api/me', undefined, undefined, a.cookie)).status, 401);
  assert.equal(
    (
      await request(
        '/api/auth/login',
        { email: 'mfatester@relay.test', password: 'Test-password-2026' },
        undefined,
        '',
      )
    ).status,
    401,
  );
});
