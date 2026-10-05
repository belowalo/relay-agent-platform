import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  acceptanceTarget,
  account,
  client,
  graph,
  node,
  providerFixture,
  until,
  waitRun,
} from './support.mjs';
import { businessExamples } from '../../examples/business/workflows.mjs';

let target, fixture, owner, viewer, outsider, base;
const errorMessage = (data) => (typeof data.error === 'string' ? data.error : data.error.message);
const flow = (name, g) => owner.ok(base + '/workflows', { name, graph: g });
const launch = async (workflow, input = 'Synthetic task', mode = 'preview') =>
  (await owner.ok(`${base}/workflows/${workflow.id}/runs`, { input, mode })).id;
const connection = (model) =>
  owner.ok(base + '/connections', {
    name: `Fixture ${model}`,
    provider: 'openai-compatible',
    endpoint: (process.env.ACCEPTANCE_FIXTURE_URL || fixture.url) + '/v1',
    model,
    secret: 'synthetic-fixture-key',
    config: { allowPrivate: true, inputPrice: 1, outputPrice: 2 },
  });

before(async () => {
  target = await acceptanceTarget();
  fixture = await providerFixture();
  if (target.external)
    assert.ok(
      process.env.ACCEPTANCE_FIXTURE_URL,
      'External API/workers need a reachable synthetic fixture endpoint',
    );
  owner = await account(target.origin, 'AcceptanceOwner');
  viewer = await account(target.origin, 'AcceptanceViewer');
  outsider = await account(target.origin, 'AcceptanceOutsider');
  base = `/api/w/${owner.wid}`;
  const invite = await owner.ok(base + '/invitations', { email: viewer.email, role: 'viewer' });
  await viewer.ok('/api/invitations/accept', { token: invite.token });
});
after(async () => {
  await fixture?.close();
  await target?.close();
});

test('S01 registration/login, role denial, membership revocation and workspace isolation', async () => {
  const invalid = await client(target.origin).request('/api/auth/login', {
    email: owner.email,
    password: 'incorrect-password',
  });
  assert.equal(invalid.status, 401);
  const login = await client(target.origin).request('/api/auth/login', {
    email: owner.email,
    password: owner.password,
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  for (const route of [
    '/workflows',
    '/collections',
    '/runs',
    '/connections',
    '/tools',
    '/applications',
    '/datasets',
    '/schedules',
  ]) {
    assert.equal((await outsider.request(base + route)).status, 403, route);
  }
  for (const [route, body] of [
    ['/workflows', { name: 'Denied', graph: graph() }],
    ['/collections', { name: 'Denied' }],
    ['/connections', { name: 'Denied' }],
    ['/tools', { name: 'Denied' }],
    ['/datasets', { name: 'Denied', cases: [{ input: 'x' }] }],
    ['/schedules', {}],
  ])
    assert.equal((await viewer.request(base + route, body)).status, 403, route);
  const me = await viewer.ok('/api/me');
  await owner.ok(`${base}/members/${me.user.id}`, undefined, 'DELETE');
  assert.equal((await viewer.request(base + '/workflows')).status, 403);
});

test('C01 J02 fixture provider auth/quota/rate failures, streaming and actual adapter accounting', async () => {
  for (const [model, expected] of [
    ['auth-error', /authentication/i],
    ['quota-error', /quota/i],
    ['rate-error', /rate limit/i],
  ]) {
    const c = await connection(model);
    const result = await owner.request(`${base}/connections/${c.id}/test`, {});
    assert.ok(result.status >= 400);
    assert.match(errorMessage(result.data), expected);
    assert.doesNotMatch(
      JSON.stringify(result.data),
      /synthetic-sensitive-provider-detail|synthetic-fixture-key/,
    );
  }
  const c = await connection('normal');
  assert.doesNotMatch(
    JSON.stringify(await owner.ok(base + '/connections')),
    /synthetic-fixture-key/,
  );
  const workflow = await flow(
    'Streaming model fixture',
    graph(node('model', 'model', { connectionId: c.id })),
  );
  const rid = await launch(workflow, 'Synthetic question', 'live');
  const stream = await fetch(`${target.origin}${base}/runs/${rid}/events`, {
    headers: { Cookie: owner.cookie },
    signal: AbortSignal.timeout(20000),
  });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const events = await stream.text();
  assert.match(events, /model.token/);
  const done = await waitRun(owner, base, rid);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.output, 'Synthetic fixture answer');
  assert.equal(done.usage.inputTokens, 20);
  assert.equal(done.usage.outputTokens, 8);
  assert.ok(done.usage.estimatedCost > 0);
  const reopened = await fetch(`${target.origin}${base}/runs/${rid}/events`, {
    headers: { Cookie: owner.cookie },
    signal: AbortSignal.timeout(20000),
  });
  assert.match(await reopened.text(), /model.token/, 'Persistent stream replay survives reconnect');
});

test('K02 K04 internal knowledge: ingestion, scoped cited evidence, untrusted text and deletion', async () => {
  const collection = await owner.ok(base + '/collections', {
    name: 'Synthetic internal policies',
    config: { chunkSize: 500, overlap: 40, retrieval: 'lexical' },
  });
  const form = new FormData();
  form.set(
    'file',
    new Blob([
      await fs.readFile(new URL('../fixtures/business/travel-policy.md', import.meta.url), 'utf8'),
    ]),
    'travel-policy.md',
  );
  const source = await owner.ok(`${base}/collections/${collection.id}/upload`, form);
  await until(async () =>
    (await owner.ok(`${base}/collections/${collection.id}/sources`)).some(
      (s) => s.id === source.id && s.status === 'ready',
    ),
  );
  const retrieved = await owner.ok(`${base}/collections/${collection.id}/retrieve`, {
    query: 'travel reimbursement',
    topK: 5,
  });
  assert.ok(retrieved.sources.length);
  assert.ok(retrieved.sources.every((s) => s.sourceId === source.id && s.chunkId && s.citation));
  assert.match(retrieved.sources[0].content, /reimbursement/i);
  const otherBase = `/api/w/${outsider.wid}`;
  assert.ok(
    (
      await outsider.request(`${otherBase}/collections/${collection.id}/retrieve`, {
        query: 'travel',
      })
    ).status >= 400,
  );
  const workflow = await flow(
    'Internal knowledge evidence',
    graph(node('evidence', 'knowledge', { collectionId: collection.id })),
  );
  const done = await waitRun(owner, base, await launch(workflow, 'travel reimbursement'));
  assert.equal(done.status, 'completed');
  assert.ok(done.output.sources.every((s) => s.sourceId === source.id));
  assert.equal(fixture.actions.length, 0, 'Retrieval text cannot grant action permissions');
  await owner.ok(`${base}/sources/${source.id}/reindex`, {});
  await until(async () =>
    (await owner.ok(`${base}/collections/${collection.id}/sources`)).some(
      (s) => s.id === source.id && s.status === 'ready',
    ),
  );
  await owner.ok(`${base}/sources/${source.id}`, undefined, 'DELETE');
  assert.equal(
    (await owner.ok(`${base}/collections/${collection.id}/retrieve`, { query: 'travel' })).sources
      .length,
    0,
  );
});

test('R01 J01 revisions, validation, frozen publication, scoped API credentials and revocation', async () => {
  const workflow = await flow(
    'Published business greeting',
    graph(node('greet', 'transform', { template: 'Hello {{name}}' })),
  );
  const invalid = structuredClone(workflow.graph);
  invalid.edges.push({ id: 'cycle', source: 'output', target: 'input' });
  assert.ok((await owner.ok(base + '/validate', { graph: invalid })).errors.length);
  const app = await owner.ok(base + '/applications', {
    name: 'Synthetic private API',
    workflowId: workflow.id,
    settings: { public: false, mode: 'preview' },
  });
  const bearer = client(target.origin, '', app.token);
  assert.equal(
    (await client(target.origin).request(`/api/apps/${app.id}/invoke`, { input: { name: 'Ada' } }))
      .status,
    401,
  );
  await owner.ok(
    `${base}/workflows/${workflow.id}`,
    { revision: 1, graph: graph(node('greet', 'transform', { template: 'Goodbye {{name}}' })) },
    'PUT',
  );
  assert.equal(
    (
      await owner.request(
        `${base}/workflows/${workflow.id}`,
        { revision: 1, graph: workflow.graph },
        'PUT',
      )
    ).status,
    409,
  );
  const invoked = await bearer.request(`/api/apps/${app.id}/invoke`, { input: { name: 'Ada' } });
  assert.equal(invoked.status, 202);
  assert.equal((await waitRun(owner, base, invoked.data.id)).output, 'Hello Ada');
  const otherApp = await owner.ok(base + '/applications', {
    name: 'Other scope',
    workflowId: workflow.id,
    settings: { public: false, mode: 'preview' },
  });
  assert.ok(
    (
      await client(target.origin, '', otherApp.token).request(
        `/api/apps/${app.id}/runs/${invoked.data.id}`,
      )
    ).status >= 400,
  );
  await owner.ok(`${base}/applications/${app.id}`, { publishLatest: true }, 'PUT');
  assert.equal(
    (
      await waitRun(
        owner,
        base,
        (await bearer.ok(`/api/apps/${app.id}/invoke`, { input: { name: 'Ada' } })).id,
      )
    ).output,
    'Goodbye Ada',
  );
  await owner.ok(`${base}/applications/${app.id}/rotate`, {});
  assert.equal(
    (await bearer.request(`/api/apps/${app.id}/invoke`, { input: 'revoked' })).status,
    401,
  );
});

test('R03 agent-selected exact action is reviewed, survives restart, executes once and rejects stale decisions', async () => {
  const reviewer = await account(target.origin, 'ApprovalViewer');
  const invite = await owner.ok(base + '/invitations', { email: reviewer.email, role: 'viewer' });
  await reviewer.ok('/api/invitations/accept', { token: invite.token });
  const c = await connection('normal');
  const tool = await owner.ok(base + '/tools', {
    name: 'Synthetic approved write',
    kind: 'http',
    config: {
      method: 'POST',
      url: (process.env.ACCEPTANCE_FIXTURE_URL || fixture.url) + '/action',
      requireApproval: true,
      allowPrivate: true,
    },
  });
  const workflow = await flow(
    'Approval-controlled external action',
    graph(
      node('agent', 'agent', {
        connectionId: c.id,
        toolIds: [tool.id],
        instructions: 'Use the reviewed tool',
        maxSteps: 3,
      }),
    ),
  );
  const rid = await launch(workflow, 'Submit the synthetic purchase', 'live');
  const waiting = await waitRun(owner, base, rid, ['waiting']);
  assert.deepEqual(waiting.approvals[0].input, {
    message: 'Reviewed synthetic purchase',
    amount: 42,
  });
  assert.equal(fixture.actions.length, 0);
  assert.equal(
    (await reviewer.request(`${base}/runs/${rid}/approve`, { nodeId: 'agent', approved: true }))
      .status,
    403,
  );
  if (!target.external) {
    await target.stop('SIGKILL');
    await target.start();
  }
  assert.equal((await owner.ok(`${base}/runs/${rid}`)).status, 'waiting');
  await owner.ok(`${base}/runs/${rid}/approve`, { nodeId: 'agent', approved: true });
  assert.equal((await waitRun(owner, base, rid)).status, 'completed');
  if (!target.external) {
    assert.equal(fixture.actions.length, 1);
    assert.deepEqual(fixture.actions[0].body, waiting.approvals[0].input);
  }
  assert.ok(
    (await owner.request(`${base}/runs/${rid}/approve`, { nodeId: 'agent', approved: true }))
      .status >= 400,
  );
  const rejected = await launch(workflow, 'Reject synthetic purchase', 'live');
  await waitRun(owner, base, rejected, ['waiting']);
  await owner.ok(`${base}/runs/${rejected}/approve`, { nodeId: 'agent', approved: false });
  assert.equal((await waitRun(owner, base, rejected)).status, 'failed');
  if (!target.external) assert.equal(fixture.actions.length, 1);
});

test('R02 cancellation and safe interrupted model recovery; evaluation, schedules and usage visibility', async () => {
  const c = await connection('slow');
  const workflow = await flow(
    'Cancellable safe model',
    graph(node('model', 'model', { connectionId: c.id })),
  );
  const rid = await launch(workflow, 'Cancel this model', 'live');
  await waitRun(owner, base, rid, ['running']);
  await owner.ok(`${base}/runs/${rid}/cancel`, {});
  assert.equal((await waitRun(owner, base, rid)).status, 'cancelled');
  if (!target.external) {
    const recovery = await launch(workflow, 'Recover interrupted read', 'live');
    await until(() =>
      fixture.calls.some((call) => call.model === 'slow' && call.durationMs === null),
    );
    const started = Date.now();
    await target.stop('SIGKILL');
    await target.start();
    assert.equal((await waitRun(owner, base, recovery)).status, 'completed');
    assert.ok(Date.now() - started < 15000, 'Local recovery threshold set before the run');
  }
  const greeting = await flow(
    'Evaluation and scheduled workflow',
    graph(node('greet', 'transform', { template: 'Hello {{name}}' })),
  );
  const dataset = await owner.ok(base + '/datasets', {
    name: 'Business outcomes',
    cases: [
      { input: { name: 'Ada' }, expected: 'Hello Ada' },
      { input: { name: 'Lin' }, expected: 'Hello Lin' },
    ],
  });
  const evaluation = await owner.ok(base + '/evaluations', {
    datasetId: dataset.id,
    workflowId: greeting.id,
    mode: 'preview',
  });
  const result = await until(async () => {
    const e = await owner.ok(`${base}/evaluations/${evaluation.id}`);
    return ['completed', 'failed'].includes(e.status) && e;
  });
  assert.equal(result.summary.passed, 2);
  const schedule = await owner.ok(base + '/schedules', {
    name: 'Synthetic daily brief',
    workflowId: greeting.id,
    cronExpression: '0 9 * * 1-5',
    timezone: 'America/Toronto',
    input: { name: 'Operations' },
    mode: 'preview',
  });
  await owner.ok(`${base}/schedules/${schedule.id}`, { enabled: false }, 'PUT');
  if (!target.external) {
    await target.stop();
    await target.start();
  }
  const persisted = (await owner.ok(base + '/schedules')).find((s) => s.id === schedule.id);
  assert.equal(Boolean(persisted.enabled), false);
  assert.ok(persisted.next_at);
  assert.ok((await owner.ok(base + '/overview')).runs.some((run) => run.usage.inputTokens > 0));
  await owner.ok(`${base}/schedules/${schedule.id}`, undefined, 'DELETE');
});

test('D01 O02 local shutdown backup and restoration retain accounts, revisions and credential dependencies', async (t) => {
  if (target.external) {
    t.skip(
      'External production restore belongs to test:acceptance:services; local filesystem operation is intentionally excluded',
    );
    return;
  }
  const c = await connection('normal');
  const workflow = await flow(
    'Restored fixture connection',
    graph(node('model', 'model', { connectionId: c.id })),
  );
  await target.stop();
  const backup = path.join(target.directory, 'synthetic-backup');
  await fs.mkdir(backup);
  const { DatabaseSync } = await import('node:sqlite');
  const snapshot = new DatabaseSync(path.join(target.directory, 'relay.sqlite'));
  snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  snapshot.close();
  for (const file of ['relay.sqlite', 'vault.key'])
    await fs.copyFile(path.join(target.directory, file), path.join(backup, file));
  await target.start();
  await owner.ok(
    `${base}/workflows/${workflow.id}`,
    { revision: 1, name: 'Post-backup mutation', graph: workflow.graph },
    'PUT',
  );
  assert.equal((await owner.ok(`${base}/workflows/${workflow.id}`)).revision, 2);
  await target.stop();
  for (const suffix of ['-wal', '-shm'])
    await fs.rm(path.join(target.directory, `relay.sqlite${suffix}`), { force: true });
  const started = Date.now();
  for (const file of ['relay.sqlite', 'vault.key'])
    await fs.copyFile(path.join(backup, file), path.join(target.directory, file));
  await target.start();
  assert.equal((await owner.ok(`${base}/workflows/${workflow.id}`)).revision, 1);
  assert.equal(
    (await owner.ok(`${base}/workflows/${workflow.id}`)).name,
    'Restored fixture connection',
  );
  assert.equal(
    (await waitRun(owner, base, await launch(workflow, 'Restored connection', 'live'))).status,
    'completed',
  );
  assert.ok(Date.now() - started < 15000);
});

test('J01 all five business graphs execute with real adapters and synthetic provider/action evidence', async () => {
  const actor = await account(target.origin, 'BusinessExamples');
  const scopedBase = `/api/w/${actor.wid}`;
  const collection = await actor.ok(scopedBase + '/collections', {
    name: 'North example policy',
    config: { retrieval: 'lexical' },
  });
  const body = new FormData();
  body.set(
    'file',
    new Blob(['North travel reimbursement requires receipts. Maximum hotel rate: 180 CAD.']),
    'north.md',
  );
  await actor.ok(`${scopedBase}/collections/${collection.id}/upload`, body);
  await until(async () =>
    (await actor.ok(`${scopedBase}/collections/${collection.id}/sources`)).every(
      (s) => s.status === 'ready',
    ),
  );
  const endpoint = process.env.ACCEPTANCE_FIXTURE_URL || fixture.url;
  const c = await actor.ok(scopedBase + '/connections', {
    name: 'Business protocol fixture',
    provider: 'openai-compatible',
    endpoint: endpoint + '/v1',
    model: 'normal',
    secret: 'synthetic-business-key',
    config: { allowPrivate: true },
  });
  const research = await actor.ok(scopedBase + '/tools', {
    name: 'External research fixture',
    kind: 'http',
    config: { method: 'GET', url: endpoint + '/research', allowPrivate: true },
  });
  const action = await actor.ok(scopedBase + '/tools', {
    name: 'Reviewed action fixture',
    kind: 'http',
    config: {
      method: 'POST',
      url: endpoint + '/action',
      allowPrivate: true,
      requireApproval: true,
    },
  });
  const examples = businessExamples({
    collectionId: collection.id,
    connectionId: c.id,
    researchToolId: research.id,
    approvedToolId: action.id,
  });
  for (const example of examples) {
    const workflow = await actor.ok(scopedBase + '/workflows', {
      name: example.name,
      graph: example.graph,
    });
    const input =
      example.id === 'scheduled'
        ? { period: 'October', summary: 'Pilot ready for review' }
        : example.id === 'published-api'
          ? { name: 'Ada' }
          : 'travel reimbursement';
    let submitted;
    if (example.id === 'published-api') {
      const app = await actor.ok(scopedBase + '/applications', {
        name: example.name,
        workflowId: workflow.id,
        settings: { mode: 'preview', public: false },
      });
      submitted = await client(target.origin, '', app.token).ok(`/api/apps/${app.id}/invoke`, {
        input,
      });
    } else
      submitted = await actor.ok(`${scopedBase}/workflows/${workflow.id}/runs`, {
        input,
        mode: ['internal-knowledge', 'research'].includes(example.id) ? 'live' : 'preview',
      });
    if (example.id === 'approved-action') {
      const waiting = await waitRun(actor, scopedBase, submitted.id, ['waiting']);
      assert.equal(waiting.approvals[0].input, input);
      await actor.ok(`${scopedBase}/runs/${submitted.id}/approve`, {
        nodeId: 'action',
        approved: true,
      });
    }
    const done = await waitRun(actor, scopedBase, submitted.id);
    assert.equal(done.status, 'completed', `${example.id}: ${done.error}`);
    if (example.id === 'research') {
      const knowledge = done.steps.find((s) => s.node_id === 'internal').output;
      assert.ok(knowledge.sources[0].citation);
      assert.match(
        JSON.stringify(done.steps.find((s) => s.node_id === 'report').input),
        /Synthetic public product evidence/,
      );
      assert.match(JSON.stringify(done.steps.find((s) => s.node_id === 'report').input), /180 CAD/);
    }
    if (example.id === 'scheduled')
      assert.equal(done.output, 'Operations brief for October: Pilot ready for review');
    if (example.id === 'published-api') assert.equal(done.output, 'Hello Ada');
  }
});
