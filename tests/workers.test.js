import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
test('two workers share capacity, fence ownership, recover crashed reads, and cancel across processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workers-')),
    port = 14325,
    origin = `http://127.0.0.1:${port}`,
    children = [];
  let cookie,
    wid,
    actions = 0,
    db;
  const mock = http.createServer((req, res) => {
    if (req.url === '/write') actions++;
    setTimeout(
      () => {
        if (!res.destroyed) {
          res.setHeader('Content-Type', 'application/json');
          res.end('{"done":true}');
        }
      },
      req.url === '/slow' ? 1800 : 30,
    );
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const launch = (file, extra = {}) => {
    const child = spawn(process.execPath, [file], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: String(port),
        ALLOW_PRIVATE_NETWORK: 'true',
        ENGINE_ROLE: 'api',
        WORKER_CAPACITY: '1',
        WORKER_LEASE_MS: '2000',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stderr.on('data', (v) => (logs += v));
    child.stdout.on('data', () => {});
    children.push(child);
    child.logs = () => logs;
    return child;
  };
  const until = async (fn, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await fn();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Worker test timed out: ' + children.map((c) => c.logs()).join('\n'));
  };
  const request = async (url, body) => {
    const r = await fetch(origin + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await r.json();
    assert.ok(r.ok, JSON.stringify(data));
    return data;
  };
  const node = (id, kind, config = {}) => ({
    id,
    type: 'relay',
    position: { x: 0, y: 0 },
    data: { kind, label: id, config },
  });
  const graph = (toolId) => ({
    nodes: [node('input', 'input'), node('tool', 'tool', { toolId }), node('output', 'output')],
    edges: [
      { id: 'a', source: 'input', target: 'tool' },
      { id: 'b', source: 'tool', target: 'output' },
    ],
  });
  try {
    launch('server/index.js');
    await until(async () => {
      try {
        return (await fetch(origin + '/api/health')).ok;
      } catch {
        return false;
      }
    });
    const r = await fetch(origin + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Workers',
        email: 'workers@relay.test',
        password: 'Workers-password-2026',
      }),
    });
    wid = (await r.json()).workspaceId;
    cookie = r.headers.get('set-cookie').split(';')[0];
    const base = `/api/w/${wid}`;
    db = new DatabaseSync(path.join(dir, 'relay.sqlite'));
    db.exec('PRAGMA busy_timeout=5000');
    const tool = await request(base + '/tools', {
      name: 'Slow read',
      kind: 'http',
      config: {
        url: `http://127.0.0.1:${mock.address().port}/slow`,
        method: 'GET',
        allowPrivate: true,
      },
    });
    const flow = await request(base + '/workflows', {
      name: 'Read recovery',
      graph: graph(tool.id),
    });
    const a = launch('server/worker.js', { WORKER_ID: 'worker-a' }),
      b = launch('server/worker.js', { WORKER_ID: 'worker-b' });
    await until(() => db.prepare('SELECT count(*) AS n FROM workers').get().n === 2);
    const runs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(`${base}/workflows/${flow.id}/runs`, { input: 'Task ' + i }),
      ),
    );
    await until(
      () =>
        db.prepare("SELECT count(DISTINCT lease_owner) AS n FROM runs WHERE status='running'").get()
          .n === 2,
    );
    const interrupted = db
      .prepare("SELECT id FROM runs WHERE status='running' AND lease_owner='worker-a'")
      .get();
    assert.ok(interrupted);
    a.kill();
    await new Promise((r) => a.once('exit', r));
    await until(async () => {
      const run = await request(`${base}/runs/${interrupted.id}`);
      return run.status === 'completed' && run;
    });
    assert.equal(
      db.prepare('SELECT lease_owner FROM runs WHERE id=?').get(interrupted.id).lease_owner,
      'worker-b',
    );
    assert.ok(
      db.prepare('SELECT lease_generation FROM runs WHERE id=?').get(interrupted.id)
        .lease_generation >= 2,
    );
    await until(
      () => db.prepare("SELECT count(*) AS n FROM runs WHERE status='completed'").get().n === 4,
    );
    const cancel = await request(`${base}/workflows/${flow.id}/runs`, { input: 'Cancel' });
    await until(
      () => db.prepare('SELECT status FROM runs WHERE id=?').get(cancel.id).status === 'running',
    );
    await request(`${base}/runs/${cancel.id}/cancel`, {});
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(
      db.prepare('SELECT status FROM runs WHERE id=?').get(cancel.id).status,
      'cancelled',
    );
    const write = await request(base + '/tools', {
        name: 'External write',
        kind: 'http',
        config: {
          url: `http://127.0.0.1:${mock.address().port}/write`,
          method: 'POST',
          allowPrivate: true,
        },
      }),
      wf = await request(base + '/workflows', { name: 'Write once', graph: graph(write.id) });
    launch('server/worker.js', { WORKER_ID: 'worker-c' });
    await until(
      () => db.prepare("SELECT count(*) AS n FROM workers WHERE id='worker-c'").get().n === 1,
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => request(`${base}/workflows/${wf.id}/runs`, { input: i })),
    );
    await until(
      () =>
        db
          .prepare("SELECT count(*) AS n FROM runs WHERE workflow_id=? AND status='completed'")
          .get(wf.id).n === 8,
    );
    assert.equal(actions, 8);
    const operations = await until(async () => {
      const op = await request(base + '/operations');
      return op.workers.length === 2 && op;
    }, 20000);
    assert.equal(operations.workers.length, 2);
    const sid = await request(base + '/schedules', {
      name: 'Recurring write',
      workflowId: wf.id,
      intervalMinutes: 10,
      input: 'scheduled task',
      mode: 'preview',
    });
    db.prepare('UPDATE schedules SET next_at=0 WHERE id=?').run(sid.id);
    const scheduled = await until(
      () => db.prepare('SELECT last_run_id FROM schedules WHERE id=?').get(sid.id).last_run_id,
    );
    await until(
      () => db.prepare('SELECT status FROM runs WHERE id=?').get(scheduled).status === 'completed',
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM runs WHERE workflow_id=?').get(wf.id).n, 9);
    assert.equal(actions, 9);
    assert.equal(runs.length, 4);
    assert.equal(b.exitCode, null);
  } finally {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) {
        c.kill();
        await new Promise((r) => c.once('exit', r));
      }
    db?.close();
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
    if (
      !path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(dir).startsWith('relay-workers-')
    )
      throw new Error('Unexpected test path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
