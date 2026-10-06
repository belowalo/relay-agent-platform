import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
test('HTTP isolation: roles, removed users, revoked/scope-limited tokens, guest receipts, webhook replay and queued actors', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-boundaries-'));
  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    DATA_DIR: directory,
    PORT: String(port),
    ENGINE_ROLE: 'api',
    RELAY_PROFILE: 'local',
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin,
  };
  const children = [];
  let logs = '';
  const start = (file, env) => {
    const child = spawn(process.execPath, [file], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    child.stdout.on('data', () => {});
    child.stderr.on('data', (s) => (logs += s));
    return child;
  };
  const request = async (url, { body, method, cookie = '', token = '', headers = {} } = {}) => {
    const r = await fetch(origin + url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0],
    };
  };
  try {
    start('server/index.js', environment);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await request('/api/health')).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(ready, logs);
    const account = async (name) => {
      const r = await request('/api/auth/register', {
        body: { name, email: name + '@relay.test', password: 'Fixture-password-2026' },
      });
      assert.equal(r.status, 201);
      return r;
    };
    const owner = await account('boundaryowner'),
      editor = await account('boundaryeditor'),
      outsider = await account('boundaryoutsider'),
      admin = await account('boundaryadmin');
    const workspace = owner.data.workspaceId,
      w = (route) => `/api/w/${workspace}${route}`;
    const own = (body, method) => ({ body, method, cookie: owner.cookie });
    const adminInvite = await request(
      w('/invitations'),
      own({ email: 'boundaryadmin@relay.test', role: 'administrator' }),
    );
    await request('/api/invitations/accept', {
      body: { token: adminInvite.data.token },
      cookie: admin.cookie,
    });
    const invited = await request(
      w('/invitations'),
      own({ email: 'boundaryeditor@relay.test', role: 'editor' }),
    );
    assert.equal(
      (
        await request('/api/invitations/accept', {
          body: { token: invited.data.token },
          cookie: editor.cookie,
        })
      ).status,
      200,
    );
    assert.equal((await request(w('/workflows'), { cookie: outsider.cookie })).status, 403);
    assert.equal(
      (
        await request(w('/members/' + owner.data.id), {
          method: 'PUT',
          body: { role: 'viewer' },
          cookie: editor.cookie,
        })
      ).status,
      403,
    );
    const graph = {
      nodes: [
        {
          id: 'input',
          type: 'relay',
          position: { x: 0, y: 0 },
          data: { kind: 'input', label: 'Input', config: {} },
        },
        {
          id: 'output',
          type: 'relay',
          position: { x: 1, y: 1 },
          data: { kind: 'output', label: 'Output', config: {} },
        },
      ],
      edges: [{ id: 'edge', source: 'input', target: 'output' }],
    };
    const workflow = await request(w('/workflows'), own({ name: 'Boundary workflow', graph }));
    assert.equal(workflow.status, 201);
    const collection = await request(
      w('/collections'),
      own({ name: 'Restricted fixture', config: { retrieval: 'lexical' } }),
    );
    assert.equal(collection.status, 201);
    const fixture = new DatabaseSync(path.join(directory, 'relay.sqlite'));
    try {
      fixture
        .prepare(
          `INSERT INTO sources(id,workspace_id,collection_id,name,status,content,created_at)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          'restricted-source',
          workspace,
          collection.data.id,
          'Restricted',
          'ready',
          'boundarysecret',
          new Date().toISOString(),
        );
      fixture
        .prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)')
        .run(
          'restricted-chunk',
          workspace,
          collection.data.id,
          'restricted-source',
          0,
          'boundarysecret',
        );
      fixture
        .prepare('INSERT INTO chunk_search VALUES(?,?,?,?)')
        .run('boundarysecret', 'restricted-chunk', workspace, collection.data.id);
      fixture
        .prepare('INSERT INTO security_source_access VALUES(?,?,?)')
        .run('restricted-source', workspace, JSON.stringify(['user:' + editor.data.id]));
    } finally {
      fixture.close();
    }
    const permitted = await request(w(`/collections/${collection.data.id}/retrieve`), {
      cookie: editor.cookie,
      body: { query: 'boundarysecret' },
    });
    assert.equal(permitted.status, 200);
    assert.equal(permitted.data.sources.length, 1);
    const restricted = await request(
      w(`/collections/${collection.data.id}/retrieve`),
      own({ query: 'boundarysecret' }),
    );
    assert.equal(restricted.status, 200);
    assert.deepEqual(restricted.data.sources, []); // Owner role does not bypass document ACL.
    const credential = await request(
      w('/connections'),
      own({
        name: 'Bound credential',
        provider: 'credential',
        endpoint: 'https://provider.test/v1',
        secret: 'synthetic-fixture-credential',
      }),
    );
    assert.equal(credential.status, 201);
    const tool = await request(
      w('/tools'),
      own({
        name: 'Attempt credential export',
        kind: 'http',
        config: { url: 'https://attacker.test/capture', connectionId: credential.data.id },
      }),
    );
    const blocked = await request(w(`/tools/${tool.data.id}/test`), own({ input: {} }));
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /configured endpoint/);
    const queued = await request(w('/workflows/' + workflow.data.id + '/runs'), {
      body: { input: 'private fixture' },
      cookie: editor.cookie,
    });
    assert.equal(queued.status, 201);
    await request(w('/members/' + editor.data.id), own({ role: 'viewer' }, 'PUT'));
    assert.equal(
      (
        await request(w('/workflows/' + workflow.data.id + '/runs'), {
          body: { input: 'denied' },
          cookie: editor.cookie,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(w('/applications'), {
          body: { workflowId: workflow.data.id },
          cookie: editor.cookie,
        })
      ).status,
      403,
    );
    const app = await request(
      w('/applications'),
      own({ workflowId: workflow.data.id, settings: { public: true, mode: 'preview' } }),
    );
    assert.equal(app.status, 201);
    const guest = await request('/apps/' + app.data.id + '/invoke', { body: { input: 'guest' } });
    assert.equal(guest.status, 202);
    assert.ok(guest.cookie);
    assert.equal((await request(`/apps/${app.data.id}/runs/${guest.data.id}`)).status, 403);
    assert.equal(
      (await request(`/apps/${app.data.id}/runs/${guest.data.id}`, { cookie: guest.cookie }))
        .status,
      200,
    );
    assert.equal(
      (await request(`/api/apps/${app.data.id}/runs/${guest.data.id}`, { cookie: guest.cookie }))
        .status,
      401,
    );
    const webhook = (key) =>
      request(`/api/apps/${app.data.id}/webhook`, {
        body: { input: 'fixture' },
        token: app.data.token,
        headers: { 'Idempotency-Key': key },
      });
    assert.equal((await webhook('delivery-fixture-0001')).status, 202);
    assert.equal((await webhook('delivery-fixture-0001')).status, 409);
    const applicationRun = await request(`/api/apps/${app.data.id}/invoke`, {
      body: { input: 'revoked' },
      token: app.data.token,
    });
    assert.equal(applicationRun.status, 202);
    const applicationStream = await fetch(
      origin + `/api/apps/${app.data.id}/runs/${applicationRun.data.id}/events`,
      { headers: { Authorization: 'Bearer ' + app.data.token }, signal: AbortSignal.timeout(4000) },
    );
    assert.equal(applicationStream.status, 200);
    const rotated = await request(
      w(`/applications/${app.data.id}/rotate`),
      own({ scopes: ['read'], expiresInDays: 1 }),
    );
    assert.equal(rotated.status, 200);
    await applicationStream.text(); // Rotation closes already-open streams on the next poll.
    assert.equal(
      (await request(`/api/apps/${app.data.id}/invoke`, { body: {}, token: rotated.data.token }))
        .status,
      403,
    );
    assert.equal(
      (await request(`/api/apps/${app.data.id}/invoke`, { body: {}, token: app.data.token }))
        .status,
      401,
    );
    await request(w(`/applications/${app.data.id}/revoke`), own({}));
    assert.equal(
      (
        await request(`/api/apps/${app.data.id}/runs/${applicationRun.data.id}`, {
          token: rotated.data.token,
        })
      ).status,
      401,
    );
    const memberStream = await fetch(origin + w(`/runs/${queued.data.id}/events`), {
      headers: { Cookie: editor.cookie },
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(memberStream.status, 200);
    await request(w('/members/' + editor.data.id), own(undefined, 'DELETE'));
    await memberStream.text();
    assert.equal((await request(w('/workflows'), { cookie: editor.cookie })).status, 403);
    const delegatedInvite = await request(w('/invitations'), {
      cookie: admin.cookie,
      body: { email: 'boundaryoutsider@relay.test', role: 'editor' },
    });
    assert.equal(delegatedInvite.status, 201);
    const delegatedApp = await request(w('/applications'), {
      cookie: admin.cookie,
      body: { workflowId: workflow.data.id, settings: { public: true, mode: 'preview' } },
    });
    assert.equal(delegatedApp.status, 201);
    assert.equal(
      (await request(w('/members/' + admin.data.id), own(undefined, 'DELETE'))).status,
      200,
    );
    assert.equal(
      (
        await request('/api/invitations/accept', {
          cookie: outsider.cookie,
          body: { token: delegatedInvite.data.token },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/api/apps/${delegatedApp.data.id}/invoke`, {
          token: delegatedApp.data.token,
          body: {},
        })
      ).status,
      403,
    );
    assert.equal((await request(`/apps/${delegatedApp.data.id}/invoke`, { body: {} })).status, 403);
    start('server/worker.js', { ...environment, ENGINE_ROLE: 'worker' });
    for (const rid of [queued.data.id, applicationRun.data.id]) {
      let run;
      for (let i = 0; i < 100; i++) {
        run = await request(w('/runs/' + rid), { cookie: owner.cookie });
        if (['failed', 'cancelled', 'completed'].includes(run.data.status)) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.equal(run.data.status, 'failed', JSON.stringify(run.data));
      assert.deepEqual(run.data.output, {});
    }
    const hostile = await request(w('/settings'), {
      body: { name: 'attack' },
      cookie: owner.cookie,
      headers: { Origin: 'https://attacker.test' },
    });
    assert.equal(hostile.status, 403);
    const invalid = await request(w('/settings'), {
      body: { name: 'attack' },
      cookie: owner.cookie,
      headers: { Origin: 'null' },
    });
    assert.equal(invalid.status, 403);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise((r) => child.once('exit', r));
      }
    const resolved = path.resolve(directory);
    assert.ok(
      resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(resolved).startsWith('relay-boundaries-'),
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
