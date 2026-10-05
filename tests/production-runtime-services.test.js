import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import Redis from 'ioredis';
import { loadConfig } from '../server/foundation/config.js';
import { createPostgresDatabase } from '../server/foundation/database.js';
import { applyMigrations } from '../server/foundation/migrations.js';
import { createJobQueue } from '../server/foundation/queue.js';
import { createRuntimeRepository } from '../server/runtime/repository.js';
import { createRuntimeWorker } from '../server/runtime/worker.js';
import { createDispatcher } from '../server/runtime/dispatcher.js';
import { createRuntimeScheduler } from '../server/runtime/scheduler.js';
import { createRuntimeApi } from '../server/runtime/api.js';
import { importToPostgres } from '../server/runtime/import.js';
import { uuid, json, decode, argumentHash } from '../server/runtime/core.js';
import {
  linear,
  node,
  edge,
  context,
  usageFixture,
  sqliteFixture,
} from './helpers/runtime-fixtures.js';
const databaseUrl = process.env.FOUNDATION_TEST_DATABASE_URL,
  redisUrl = process.env.FOUNDATION_TEST_REDIS_URL;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error('Runtime service condition timed out');
}
test(
  'production runtime qualification on disposable PostgreSQL and Redis',
  { skip: !databaseUrl || !redisUrl, timeout: 180000 },
  async (t) => {
    assert.match(new URL(databaseUrl).pathname, /^\/relay_foundation_test(?:_[a-zA-Z0-9]+)?$/);
    const suffix = crypto.randomBytes(6).toString('hex'),
      dbName = 'relay_foundation_test_' + suffix,
      role = 'runtime_test_' + suffix;
    const root = new pg.Pool({ connectionString: databaseUrl }),
      adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/' + dbName;
    const admin = new pg.Pool({ connectionString: adminUrl.href }),
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-runtime-services-'));
    let database, queue, redis, server;
    const children = [];
    const metrics = [];
    const c = context();
    let appUrl;
    try {
      await root.query(`CREATE DATABASE "${dbName}"`);
      await applyMigrations(admin);
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA relay TO "${role}"`);
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO "${role}"`,
      );
      await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA relay TO "${role}"`);
      appUrl = new URL(adminUrl);
      appUrl.username = role;
      appUrl.password = password;
      database = createPostgresDatabase(loadConfig({ DATABASE_URL: appUrl.href }));
      await database.assertApplicationRole();
      const repo = createRuntimeRepository(database, { leaseMs: 400 }),
        usage = usageFixture();
      const telemetry = {
        event() {},
        timing(name, ms, attributes) {
          metrics.push({ name, ms, ...attributes });
        },
      };
      let writes = 0,
        modelCalls = 0;
      const tools = {
        async describe(ctx, tool) {
          return {
            effect: tool.config?.effect || 'read',
            requiresApproval: tool.config?.approval !== false,
            inputSchema: tool.config?.inputSchema,
            idempotency: 'none',
          };
        },
        async invoke(ctx, call) {
          const config = call.tool.config || {};
          if (config.effect === 'write') writes++;
          if (config.fail)
            throw new Error('sensitive fixture payload must never become persisted error');
          if (config.slow) await delay(config.slow);
          call.signal.throwIfAborted();
          return { data: config.result ?? call.input };
        },
      };
      const worker = () =>
        createRuntimeWorker({
          repository: repo,
          leaseMs: 400,
          ownerId: uuid(),
          authorize: async () => true,
          usage,
          tools,
          telemetry,
          shutdownMs: 100,
          model: {
            async call(ctx, request) {
              return request.meteredCall(
                { maximumTokens: 100, maximumCostMicros: null },
                async () => {
                  modelCalls++;
                  await delay(20);
                  return {
                    text: 'done',
                    toolCalls: [],
                    usage: { tokens: 10, costMicros: null },
                    provider: 'fixture',
                    model: 'fixture',
                  };
                },
              );
            },
          },
        });
      const reference = (id) => ({
        version: 1,
        id: uuid(),
        workspaceId: c.workspaceId,
        kind: 'workflow.run',
        resourceId: id,
        requestId: c.requestId,
      });
      const create = async (graph = linear(), input = { value: 1 }, options = {}) => {
        const workflowId = await repo.createWorkflow(c, {
          name: 'Synthetic runtime qualification',
          graph,
        });
        const versionId = await repo.publish(c, workflowId);
        return repo.createRun(c, { workflowId, versionId, input, ...options });
      };
      await t.test(
        'migration dry-run, atomic import, exact IDs and ciphertext, refused overwrite, restore rehearsal',
        async () => {
          const source = path.join(dir, 'representative-synthetic.sqlite'),
            copy = path.join(dir, 'backup-copy.sqlite');
          const fixture = sqliteFixture(source);
          await fs.copyFile(source, copy);
          const dry = await importToPostgres(admin, copy, { legacyKey: fixture.key });
          assert.equal(dry.dryRun, true);
          assert.equal(
            Number((await admin.query('SELECT count(*) n FROM relay.users')).rows[0].n),
            0,
          );
          const result = await importToPostgres(admin, copy, {
            dryRun: false,
            legacyKey: fixture.key,
          });
          assert.deepEqual(result.counts, dry.counts);
          assert.equal(
            (await admin.query('SELECT secret FROM relay.connections')).rows[0].secret,
            fixture.envelope,
          );
          assert.equal(
            (await admin.query("SELECT status FROM relay.actions WHERE id='fixture_action'"))
              .rows[0].status,
            'uncertain',
          );
          assert.equal((await repo.getRun(c, 'fixture_run')).actor, null);
          assert.equal(await repo.claim(c, 'fixture_run', 'worker-a'), null);
          await assert.rejects(
            importToPostgres(admin, copy, { dryRun: false, legacyKey: fixture.key }),
            /IMPORT_DESTINATION_NOT_EMPTY/,
          );
          assert.deepEqual(await fs.readFile(copy), await fs.readFile(source));
          // Restore target from the same disposable source after deliberately discarding ONLY this test DB's data.
          await admin.query('TRUNCATE relay.users,relay.workspaces CASCADE');
          await importToPostgres(admin, copy, { dryRun: false, legacyKey: fixture.key });
          assert.equal((await repo.getRun(c, 'fixture_run')).event_seq, '1');
        },
      );
      await t.test(
        'RLS, tenant references, frozen published graphs and immutable snapshots',
        async () => {
          assert.equal(await repo.getRun(context('other_workspace'), 'fixture_run'), null);
          const id = await create();
          const run = await repo.getRun(c, id);
          await assert.rejects(
            repo.tx(c, (s) =>
              s.query('UPDATE relay.runs SET graph=$2 WHERE id=$1', [
                id,
                json(linear('transform', { path: 'other' })),
              ]),
            ),
            /immutable/,
          );
          await assert.rejects(
            repo.tx(c, (s) =>
              s.query('UPDATE relay.versions SET graph=$2 WHERE id=$1', [
                run.version_id,
                json(linear()) + ' ',
              ]),
            ),
            /immutable/,
          );
          await repo.tx(c, (s) =>
            s.query('UPDATE relay.workflows SET graph=$2 WHERE id=$1', [
              run.workflow_id,
              json(linear('transform', { path: 'changed' })),
            ]),
          );
          await worker().execute(reference(id));
          assert.deepEqual(decode((await repo.getRun(c, id)).output), { value: 1 });
          const events = await repo.events(c, id);
          assert.deepEqual(
            events.map((e) => Number(e.sequence)),
            events.map((_, i) => i + 1),
          );
        },
      );
      await t.test(
        'parallel branches, conditional joins, skipped paths and failure propagation',
        async () => {
          const graph = {
            nodes: [
              node('in', 'input'),
              node('c', 'condition', { path: 'go' }),
              node('yes', 'transform', { template: 'yes' }),
              node('no', 'transform', { template: 'no' }),
              node('a', 'tool', { kind: 'fixture', slow: 30 }),
              node('b', 'tool', { kind: 'fixture', slow: 30 }),
              node('out', 'output'),
            ],
            edges: [
              edge('in', 'c'),
              edge('c', 'yes', 'true'),
              edge('c', 'no', 'false'),
              edge('yes', 'a'),
              edge('yes', 'b'),
              edge('a', 'out'),
              edge('b', 'out'),
              edge('no', 'out'),
            ],
          };
          const id = await create(graph, { go: true });
          await worker().execute(reference(id));
          const r = await repo.getRun(c, id);
          assert.equal(r.status, 'completed');
          assert.deepEqual(decode(r.output), { a: 'yes', b: 'yes' });
          assert.equal(
            (await repo.getSteps(c, id)).find((s) => s.node_id === 'no').status,
            'skipped',
          );
        },
      );
      await t.test(
        'atomic claims, capacity, expired lease fencing, heartbeat and stale writes',
        async () => {
          await repo.tx(c, (s) =>
            s.query(
              'INSERT INTO relay.runtime_capacity(workspace_id,max_running) VALUES($1,1) ON CONFLICT(workspace_id) DO UPDATE SET max_running=1',
              [c.workspaceId],
            ),
          );
          const a = await create(),
            b = await create();
          const claims = await Promise.all([
            repo.claim(c, a, 'worker-a'),
            repo.claim(c, a, 'worker-b'),
          ]);
          assert.equal(claims.filter(Boolean).length, 1);
          const first = claims.find(Boolean);
          assert.equal(await repo.claim(c, b, 'worker-b'), null);
          await repo.heartbeat(c, first.lease);
          await delay(450);
          const second = await repo.claim(c, a, 'worker-b');
          assert.ok(second);
          assert.ok(second.lease.generation > first.lease.generation);
          await assert.rejects(repo.heartbeat(c, first.lease), /STALE_LEASE/);
          const step = (await repo.getSteps(c, a))[0];
          await assert.rejects(repo.completeStep(c, first.lease, step.id, {}), /STALE_LEASE/);
          await repo.pause(c, second.lease, 'queued');
          await worker().execute(reference(a));
          await worker().execute(reference(b));
          await repo.tx(c, (s) =>
            s.query('UPDATE relay.runtime_capacity SET max_running=4 WHERE workspace_id=$1', [
              c.workspaceId,
            ]),
          );
        },
      );
      await t.test(
        'approval survives worker replacement, hashes exact arguments and rejects stale decisions',
        async () => {
          const before = writes,
            id = await create(linear('tool', { kind: 'fixture', effect: 'write' }), {
              recipient: 'synthetic',
              amount: 7,
            });
          await worker().execute(reference(id));
          assert.equal((await repo.getRun(c, id)).status, 'waiting');
          assert.equal(writes, before);
          const approval = await repo.tx(c, (s) =>
            s.one('SELECT * FROM relay.runtime_approvals WHERE run_id=$1', [id]),
          );
          await assert.rejects(
            repo.decide(c, approval.id, argumentHash({ recipient: 'synthetic', amount: 8 }), true),
            /APPROVAL_CONFLICT/,
          );
          await repo.decide(c, approval.id, approval.argument_hash, true);
          await assert.rejects(
            repo.decide(c, approval.id, approval.argument_hash, true),
            /APPROVAL_CONFLICT/,
          );
          await worker().execute(reference(id));
          await worker().execute(reference(id));
          assert.equal(writes, before + 1);
          assert.equal((await repo.getRun(c, id)).status, 'completed');
        },
      );
      await t.test(
        'interrupted agent approval reuses frozen model checkpoint and accounting hooks',
        async () => {
          await repo.tx(c, (s) =>
            s.query(
              'INSERT INTO relay.tools(id,workspace_id,name,kind,config,created_at) VALUES($1,$2,$3,$4,$5,$6)',
              [
                'agent_fixture_tool',
                c.workspaceId,
                'Synthetic writer',
                'fixture',
                json({ effect: 'write' }),
                new Date().toISOString(),
              ],
            ),
          );
          let calls = 0;
          const agentWorker = () =>
            createRuntimeWorker({
              repository: repo,
              leaseMs: 400,
              authorize: async () => true,
              usage,
              tools,
              model: {
                async call(ctx, request) {
                  return request.meteredCall(
                    { maximumTokens: 50, maximumCostMicros: null },
                    async () => ({
                      text: ++calls === 1 ? '' : 'agent done',
                      toolCalls:
                        calls === 1
                          ? [{ id: 'call-1', name: 'agent_fixture_tool', arguments: { exact: 1 } }]
                          : [],
                      usage: { tokens: 4, costMicros: null },
                      provider: 'fixture',
                      model: 'fixture',
                    }),
                  );
                },
              },
            });
          const id = await create(linear('agent', { toolIds: ['agent_fixture_tool'] }));
          await agentWorker().execute(reference(id));
          assert.equal(calls, 1);
          const approval = await repo.tx(c, (s) =>
            s.one('SELECT * FROM relay.runtime_approvals WHERE run_id=$1', [id]),
          );
          await repo.decide(c, approval.id, approval.argument_hash, true);
          await agentWorker().execute(reference(id));
          assert.equal(calls, 2);
          assert.equal((await repo.getRun(c, id)).status, 'completed');
          assert.equal(usage.reservations.length, usage.settlements.length);
        },
      );
      await t.test(
        'uncertain external write blocks retry, requires explicit reconciliation, never repeats observed effect',
        async () => {
          const before = writes,
            id = await create(
              linear('tool', {
                kind: 'fixture',
                effect: 'write',
                approval: false,
                fail: true,
                retries: 3,
              }),
            );
          await worker().execute(reference(id));
          assert.equal(writes, before + 1);
          await assert.rejects(repo.retry(c, id), /UNCERTAIN_ACTION/);
          const action = await repo.tx(c, (s) =>
            s.one('SELECT * FROM relay.actions WHERE run_id=$1', [id]),
          );
          assert.equal(action.status, 'uncertain');
          await repo.reconcile(
            c,
            action.id,
            'succeeded',
            { reconciled: true },
            'Synthetic fixture confirms write',
          );
          await repo.retry(c, id);
          await worker().execute(reference(id));
          assert.equal(writes, before + 1);
          assert.equal((await repo.getRun(c, id)).status, 'completed');
        },
      );
      await t.test(
        'bounded retries persist backoff, terminate in dead letters and timeout drains safely',
        async () => {
          let tries = 0;
          const w = createRuntimeWorker({
            repository: repo,
            leaseMs: 400,
            authorize: async () => true,
            usage,
            tools: {
              async describe() {
                return { effect: 'read' };
              },
              async invoke() {
                tries++;
                throw Object.assign(new Error('private payload'), {
                  code: 'DEPENDENCY_UNAVAILABLE',
                  knownNotExecuted: true,
                });
              },
            },
          });
          const id = await create(linear('tool', { kind: 'fixture', retries: 1 }));
          await w.execute(reference(id));
          assert.equal((await repo.getRun(c, id)).status, 'queued');
          await w.execute(reference(id));
          assert.equal(tries, 1);
          await delay(300);
          await w.execute(reference(id));
          assert.equal(tries, 2);
          assert.equal((await repo.getRun(c, id)).status, 'failed');
          assert.ok(
            await repo.tx(c, (s) =>
              s.one('SELECT id FROM relay.runtime_dead_letters WHERE run_id=$1', [id]),
            ),
          );
          const timeout = await create(
            linear('tool', { kind: 'fixture', slow: 500 }),
            {},
            { limits: { nodeTimeoutMs: 100 } },
          );
          await worker().execute(reference(timeout));
          assert.equal((await repo.getRun(c, timeout)).status, 'failed');
          const drain = await create(linear('tool', { kind: 'fixture', slow: 2000 }));
          const draining = worker(),
            running = draining.execute(reference(drain));
          await until(() => draining.active);
          await draining.close();
          await running;
          assert.equal(draining.active, 0);
          assert.equal(draining.draining, true);
        },
      );
      await t.test(
        'subworkflow and bounded item loops resume without duplicate child runs',
        async () => {
          const child = await repo.createWorkflow(c, {
            name: 'Synthetic child',
            graph: linear('transform', { path: 'n' }),
          });
          const id = await create(
            linear('loop', { workflowId: child, itemsPath: 'items', maxIterations: 3 }),
            { items: [{ n: 2 }, { n: 4 }, { n: 8 }] },
          );
          for (let turn = 0; turn < 10; turn++) {
            await worker().execute(reference(id));
            const children = await repo.tx(c, (s) =>
              s.all('SELECT id FROM relay.runs WHERE parent_id=$1', [id]),
            );
            for (const child of children) await worker().execute(reference(child.id));
            if ((await repo.getRun(c, id)).status === 'completed') break;
          }
          assert.deepEqual(decode((await repo.getRun(c, id)).output), [2, 4, 8]);
          assert.equal(
            Number(
              (
                await repo.tx(c, (s) =>
                  s.one('SELECT count(*) n FROM relay.runs WHERE parent_id=$1', [id]),
                )
              ).n,
            ),
            3,
          );
        },
      );
      await t.test(
        'durable schedule races enqueue one run per occurrence and preserve published revision',
        async () => {
          const workflowId = await repo.createWorkflow(c, {
              name: 'Scheduled fixture',
              graph: linear(),
            }),
            versionId = await repo.publish(c, workflowId),
            scheduler = createRuntimeScheduler({ repository: repo, authorize: async () => true });
          const id = await scheduler.create(c, {
            workflowId,
            versionId,
            name: 'Synthetic due schedule',
            input: { scheduled: true },
          });
          await repo.tx(c, (s) =>
            s.query('UPDATE relay.schedules SET next_at=$2 WHERE id=$1', [id, Date.now() - 10]),
          );
          await Promise.all([scheduler.tick(c), scheduler.tick(c)]);
          assert.equal(
            Number(
              (
                await repo.tx(c, (s) =>
                  s.one(
                    'SELECT count(*) n FROM relay.runtime_schedule_fires WHERE schedule_id=$1',
                    [id],
                  ),
                )
              ).n,
            ),
            1,
          );
        },
      );
      await t.test(
        'async API authorizes reviewers, persists events and refuses cross-workspace context',
        async () => {
          const scheduler = createRuntimeScheduler({
            repository: repo,
            authorize: async () => true,
          });
          const app = createRuntimeApi({
            repository: repo,
            scheduler,
            authenticate: async () => c,
            authorize: async (ctx, op) => op.operation !== 'approve',
          });
          server = app.listen(0, '127.0.0.1');
          await new Promise((r) => server.once('listening', r));
          const origin = `http://127.0.0.1:${server.address().port}`;
          assert.equal((await fetch(origin + '/api/w/other_workspace/runs')).status, 403);
          assert.equal(
            (
              await fetch(origin + `/api/w/${c.workspaceId}/approvals/fake/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: json({ approved: true }),
              })
            ).status,
            403,
          );
          const run = await create();
          await worker().execute(reference(run));
          assert.equal(
            (await fetch(origin + `/api/w/${c.workspaceId}/runs/${run}/events`)).status,
            200,
          );
        },
      );
      const prefix = 'runtime_test_' + suffix;
      queue = createJobQueue(
        loadConfig({ REDIS_URL: redisUrl, QUEUE_PREFIX: prefix, WORKER_CAPACITY: '2' }),
      );
      await queue.probe();
      redis = new Redis(redisUrl);
      redis.on('error', () => {});
      const launch = async (effect, fixtureUrl) => {
        const child = fork(new URL('./helpers/production-worker.mjs', import.meta.url), [], {
          env: {
            ...process.env,
            RELAY_PROFILE: 'local',
            DATABASE_URL: appUrl.href,
            REDIS_URL: redisUrl,
            QUEUE_PREFIX: prefix,
            TEST_WORKER_ID: uuid(),
            TEST_EFFECT: effect,
            TEST_FIXTURE_URL: fixtureUrl,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        children.push(child);
        let errors = '';
        child.stderr.on('data', (v) => (errors += v));
        child.stdout.on('data', () => {});
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Worker start failed: ' + errors)),
            10000,
          );
          child.once('message', () => {
            clearTimeout(timer);
            resolve();
          });
          child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Worker exited: ' + errors));
          });
        });
        return child;
      };
      await t.test(
        'multiple processes, worker termination, application repository restart, duplicate delivery and cancellation',
        async () => {
          let arrivals = 0;
          const fixture = http.createServer((req, res) => {
            arrivals++;
            setTimeout(() => {
              res.setHeader('Content-Type', 'application/json');
              res.end('{"fixture":true}');
            }, 600);
          });
          await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
          try {
            const url = `http://127.0.0.1:${fixture.address().port}`,
              a = await launch('read', url),
              b = await launch('read', url);
            const id = await create(linear('tool', { kind: 'fixture' }));
            await queue.publish(reference(id));
            await until(
              async () => arrivals > 0 && (await repo.getRun(c, id)).status === 'running',
            );
            // Kill both consumers; neither can retain authority after lease expiry.
            a.kill('SIGKILL');
            b.kill('SIGKILL');
            await delay(500);
            const replacement = await launch('read', url);
            await queue.publish(reference(id));
            await until(async () => (await repo.getRun(c, id)).status === 'completed');
            const restarted = createRuntimeRepository(database, { leaseMs: 400 });
            assert.equal((await restarted.getRun(c, id)).status, 'completed');
            const before = arrivals;
            await queue.publish(reference(id));
            await delay(200);
            assert.equal(arrivals, before);
            const cancelled = await create(linear('tool', { kind: 'fixture' }));
            await queue.publish(reference(cancelled));
            await until(async () => arrivals > before);
            await repo.cancel(c, cancelled);
            await delay(700);
            assert.equal((await repo.getRun(c, cancelled)).status, 'cancelled');
            replacement.send('drain');
            await new Promise((r) => replacement.once('exit', r));
          } finally {
            await new Promise((r) => fixture.close(r));
          }
        },
      );
      await t.test(
        'killed write worker leaves uncertain ledger and cannot automatically replay',
        async () => {
          let arrivals = 0;
          const fixture = http.createServer((req, res) => {
            arrivals++;
            setTimeout(() => {
              res.end('{"written":true}');
            }, 1000);
          });
          await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
          try {
            const a = await launch('write', `http://127.0.0.1:${fixture.address().port}`),
              id = await create(
                linear('tool', { kind: 'fixture', effect: 'write', approval: false }),
              );
            await queue.publish(reference(id));
            await until(() => arrivals);
            a.kill('SIGKILL');
            await delay(500);
            await worker().execute(reference(id));
            assert.equal((await repo.getRun(c, id)).error, 'UNCERTAIN_ACTION');
            assert.equal(arrivals, 1);
            await assert.rejects(repo.retry(c, id), /UNCERTAIN_ACTION/);
          } finally {
            await new Promise((r) => fixture.close(r));
          }
        },
      );
      await t.test(
        'dispatcher acknowledgement loss, fenced retries, reference-only queue and Redis-loss repair',
        async () => {
          const id = await create();
          let published = 0;
          const dispatcher = createDispatcher({
            repository: repo,
            leaseMs: 200,
            listWorkspaces: async () => [c.workspaceId],
            queue: {
              async publish(job) {
                published++;
                await queue.publish(job);
                if (published === 1) throw new Error('synthetic lost acknowledgement');
              },
            },
          });
          const consumer = queue.createWorker(worker().execute);
          for (let i = 0; i < 100 && (await repo.getRun(c, id)).status !== 'completed'; i++) {
            await dispatcher.tick();
            await delay(25);
          }
          assert.equal((await repo.getRun(c, id)).status, 'completed');
          await delay(250);
          await dispatcher.tick();
          const ref = reference(id);
          await queue.publish(ref);
          const value = await redis.hget(`${prefix}:jobs:${ref.id}`, 'data');
          assert.ok(value && !value.includes('graph') && !value.includes('input'));
          await consumer.close();
          await dispatcher.close();
        },
      );
      await t.test(
        'application overhead measured separately from fixture provider latency',
        async () => {
          const samples = [];
          const overhead = [];
          for (let i = 0; i < 30; i++) {
            const start = performance.now();
            const id = await create(linear('model'));
            await worker().execute(reference(id));
            samples.push(performance.now() - start);
            const provider = metrics
              .filter((m) => m.runId === id && m.name === 'runtime.provider_ms')
              .reduce((sum, m) => sum + m.ms, 0);
            overhead.push(samples.at(-1) - provider);
            assert.equal((await repo.getRun(c, id)).status, 'completed');
          }
          const p95 = (values) =>
            [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
          console.log(
            'RUNTIME_MEASUREMENT ' +
              json({
                samples: samples.length,
                fixtureProviderMs: 20,
                wallP95Ms: Number(p95(samples).toFixed(2)),
                applicationOverheadP95Ms: Number(p95(overhead).toFixed(2)),
                scope:
                  'serial create+publish+enqueue+execute, single service host; excludes production API load qualification',
              }),
          );
          assert.ok(modelCalls >= 30);
        },
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      if (server) await new Promise((r) => server.close(r));
      if (queue) await queue.close();
      if (redis) {
        let cursor = '0';
        do {
          const result = await redis.scan(
            cursor,
            'MATCH',
            'runtime_test_' + suffix + ':*',
            'COUNT',
            100,
          );
          cursor = result[0];
          if (result[1].length) await redis.del(...result[1]);
        } while (cursor !== '0');
        redis.disconnect();
      }
      await database?.close();
      await admin.end();
      await root.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await root.query(`DROP ROLE IF EXISTS "${role}"`);
      await root.end();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
