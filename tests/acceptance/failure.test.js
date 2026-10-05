import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { host } from '../load/measure.mjs';
import { localApplication, account, graph, node, until, waitRun, sleep } from './support.mjs';

test('R02 fault drill: worker death, lease expiry, safe read recovery, uncertain write reconciliation and cross-process cancellation', async () => {
  const report = {
    type: 'local-fixture-failure-drill',
    startedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
    thresholds: { recoveryMs: 15000, cancellationMs: 2000 },
    hardware: host(),
    topology: { api: 1, separateWorkers: 2, database: 'SQLite WAL', sharedHost: true },
    cases: [],
    status: 'running',
  };
  await fs.mkdir('verification-results', { recursive: true });
  await fs.writeFile('verification-results/failure-manifest.json', JSON.stringify(report, null, 2));
  let target,
    workerA,
    workerB,
    writes = 0,
    reads = 0;
  const fixture = http.createServer(async (req, res) => {
    for await (const _ of req) {
      /* drain synthetic body */
    }
    if (req.url === '/write') {
      writes++;
      res.destroy();
      return;
    }
    reads++;
    setTimeout(() => {
      if (!res.destroyed) {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"evidence":"synthetic safe read"}');
      }
    }, 2500);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const stop = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    await ended;
  };
  try {
    target = await localApplication({ ENGINE_ROLE: 'api', WORKER_CAPACITY: '1' });
    const owner = await account(target.origin, 'FailureDrill');
    const base = `/api/w/${owner.wid}`;
    const startWorker = (name) => {
      const worker = spawn(process.execPath, ['server/worker.js'], {
        env: {
          ...process.env,
          RELAY_PROFILE: 'local',
          DATA_DIR: target.directory,
          WORKER_ID: name,
          WORKER_CAPACITY: '1',
          WORKER_LEASE_MS: '2000',
          ALLOW_PRIVATE_NETWORK: 'true',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return worker;
    };
    const tool = await owner.ok(base + '/tools', {
      name: 'Safe slow read',
      kind: 'http',
      config: {
        method: 'GET',
        url: `http://127.0.0.1:${fixture.address().port}/read`,
        allowPrivate: true,
      },
    });
    const workflow = await owner.ok(base + '/workflows', {
      name: 'Safe read recovery',
      graph: graph(node('read', 'tool', { toolId: tool.id })),
    });
    workerA = startWorker('acceptance-worker-a');
    const run = await owner.ok(`${base}/workflows/${workflow.id}/runs`, { input: {} });
    await until(() => reads === 1);
    const start = Date.now();
    await stop(workerA);
    workerB = startWorker('acceptance-worker-b');
    const done = await waitRun(owner, base, run.id);
    const recoveryMs = Date.now() - start;
    assert.equal(done.status, 'completed');
    assert.equal(reads, 2, 'Safe read repeats once after interrupted ownership');
    assert.ok(recoveryMs < report.thresholds.recoveryMs);
    report.cases.push({ name: 'worker-kill-safe-read', recoveryMs, reads });
    const writeTool = await owner.ok(base + '/tools', {
      name: 'Uncertain synthetic write',
      kind: 'http',
      config: {
        method: 'POST',
        url: `http://127.0.0.1:${fixture.address().port}/write`,
        allowPrivate: true,
        requireApproval: true,
      },
    });
    const writeFlow = await owner.ok(base + '/workflows', {
      name: 'Uncertain write',
      graph: graph(node('write', 'tool', { toolId: writeTool.id })),
    });
    const uncertain = await owner.ok(`${base}/workflows/${writeFlow.id}/runs`, {
      input: { amount: 42 },
    });
    await waitRun(owner, base, uncertain.id, ['waiting']);
    await owner.ok(`${base}/runs/${uncertain.id}/approve`, { nodeId: 'write', approved: true });
    assert.equal((await waitRun(owner, base, uncertain.id)).status, 'failed');
    const retry = await owner.request(`${base}/runs/${uncertain.id}/retry`, {});
    assert.ok(retry.status >= 400, 'Uncertain side effects must not automatically replay');
    await sleep(200);
    assert.equal(writes, 1);
    report.cases.push({
      name: 'response-loss-after-write',
      observedWrites: writes,
      automaticRetryDenied: true,
    });
    const cancelled = await owner.ok(`${base}/workflows/${workflow.id}/runs`, { input: {} });
    await waitRun(owner, base, cancelled.id, ['running']);
    const cancelling = Date.now();
    await owner.ok(`${base}/runs/${cancelled.id}/cancel`, {});
    assert.equal((await waitRun(owner, base, cancelled.id)).status, 'cancelled');
    const cancellationMs = Date.now() - cancelling;
    assert.ok(cancellationMs < report.thresholds.cancellationMs);
    report.cases.push({ name: 'cross-process-cancel', cancellationMs });
    const scheduledFlow = await owner.ok(base + '/workflows', {
      name: 'Durable catch-up example',
      graph: graph(node('brief', 'transform', { template: 'Brief {{period}}' })),
    });
    const schedule = await owner.ok(base + '/schedules', {
      name: 'Synthetic catch-up',
      workflowId: scheduledFlow.id,
      intervalMinutes: 1,
      input: { period: 'October' },
      mode: 'preview',
    });
    await stop(workerB);
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(target.directory + '/relay.sqlite');
    database
      .prepare('UPDATE schedules SET next_at=? WHERE id=? AND workspace_id=?')
      .run(Date.now() - 300000, schedule.id, owner.wid);
    database.close();
    workerA = startWorker('acceptance-schedule-a');
    workerB = startWorker('acceptance-schedule-b');
    const advanced = await until(async () => {
      const record = (await owner.ok(base + '/schedules')).find((s) => s.id === schedule.id);
      return record?.last_run_id && record;
    });
    assert.equal((await waitRun(owner, base, advanced.last_run_id)).output, 'Brief October');
    await sleep(700);
    const scheduledRuns = (await owner.ok(base + '/runs')).filter(
      (r) => r.workflow_id === scheduledFlow.id,
    );
    assert.equal(
      scheduledRuns.length,
      1,
      'Two workers must enqueue one overdue occurrence, not replay five missed intervals',
    );
    report.cases.push({
      name: 'two-worker-schedule-catch-up',
      overdueMinutes: 5,
      observedRuns: scheduledRuns.length,
    });
    await owner.ok(`${base}/schedules/${schedule.id}`, undefined, 'DELETE');
    report.status = 'passed';
  } finally {
    await stop(workerA);
    await stop(workerB);
    await target?.close();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    await fs.mkdir('verification-results', { recursive: true });
    report.finishedAt = new Date().toISOString();
    if (report.status !== 'passed') report.status = 'failed';
    await fs.writeFile('verification-results/failure-report.json', JSON.stringify(report, null, 2));
  }
});
