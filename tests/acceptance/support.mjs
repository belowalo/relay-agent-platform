import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const node = (id, kind, config = {}) => ({
  id,
  type: 'relay',
  position: { x: 100, y: 100 },
  data: { kind, label: id, config },
});
export const graph = (...middle) => {
  const nodes = [node('input', 'input'), ...middle, node('output', 'output')];
  return {
    nodes,
    edges: nodes
      .slice(1)
      .map((n, i) => ({ id: `${nodes[i].id}-${n.id}`, source: nodes[i].id, target: n.id })),
  };
};
export async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(60);
  }
  throw new Error(`Acceptance condition did not become true within ${timeout}ms`);
}
export async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export function client(origin, cookie = '', bearer = '') {
  return {
    async request(url, body, method) {
      const response = await fetch(origin + url, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined
          ? {}
          : { body: body instanceof FormData ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        data: text ? JSON.parse(text) : null,
      };
    },
    async ok(url, body, method) {
      const result = await this.request(url, body, method);
      assert.ok(
        result.status < 300,
        `${url}: HTTP ${result.status} ${JSON.stringify(result.data)}`,
      );
      return result.data;
    },
  };
}
export async function account(origin, label) {
  const email = `${label}-${crypto.randomUUID()}@relay.test`;
  const password = 'Synthetic-acceptance-password-2026';
  const result = await client(origin).request('/api/auth/register', {
    name: label,
    email,
    password,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const cookie = result.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { ...client(origin, cookie), cookie, email, password, wid: result.data.workspaceId };
}
export async function waitRun(actor, base, id, statuses = ['completed', 'failed', 'cancelled']) {
  return until(async () => {
    const run = await actor.ok(`${base}/runs/${id}`);
    return statuses.includes(run.status) && run;
  });
}

// Local HTTP protocol fixture. The application uses its real provider/tool adapters.
// Synthetic tokens and answers are never evidence of real-model quality.
export async function providerFixture() {
  const calls = [],
    actions = [],
    timers = new Set();
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : {};
    if (req.url === '/diagnostics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ calls, actions }));
      return;
    }
    const started = performance.now();
    const correlation = JSON.stringify(body.messages || []).match(/LOAD-[a-f0-9-]{36}/)?.[0];
    const record = { route: req.url, model: body.model, correlation, started, durationMs: null };
    calls.push(record);
    res.once('close', () => {
      record.durationMs = performance.now() - started;
    });
    if (req.url === '/research') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          title: 'Synthetic public product evidence',
          url: 'https://example.org/research',
          text: 'Orion external research is a synthetic fixture. No public pricing or availability is asserted.',
        }),
      );
      return;
    }
    if (req.url === '/action') {
      actions.push({ body, idempotencyKey: req.headers['idempotency-key'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, input: body }));
      return;
    }
    if (['auth-error', 'quota-error', 'rate-error', 'server-error'].includes(body.model)) {
      res.writeHead(body.model === 'auth-error' ? 401 : body.model === 'server-error' ? 503 : 429, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: {
            code: body.model === 'quota-error' ? 'insufficient_quota' : 'rate_limit',
            message: 'synthetic-sensitive-provider-detail',
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const finish = () => {
      if (res.destroyed) return;
      if (body.tools?.length && !body.messages?.some((message) => message.role === 'tool')) {
        emit({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'fixture-action',
                    function: {
                      name: body.tools[0].function.name,
                      arguments: JSON.stringify({
                        message: 'Reviewed synthetic purchase',
                        amount: 42,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      } else {
        emit({ choices: [{ delta: { content: 'Synthetic fixture answer' } }] });
      }
      emit({
        choices: [
          {
            delta: {},
            finish_reason:
              body.tools?.length && !body.messages?.some((m) => m.role === 'tool')
                ? 'tool_calls'
                : 'stop',
          },
        ],
      });
      emit({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } });
      res.end('data: [DONE]\n\n');
    };
    if (body.model === 'partial-error') {
      emit({ choices: [{ delta: { content: 'Partial fixture output' } }] });
    }
    const delay =
      body.model === 'slow'
        ? 3000
        : body.model === 'partial-error'
          ? 50
          : Number(process.env.FIXTURE_DELAY_MS || 60);
    const timer = setTimeout(() => {
      timers.delete(timer);
      body.model === 'partial-error' ? res.destroy() : finish();
    }, delay);
    timers.add(timer);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    actions,
    async close() {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
export async function localApplication(extraEnv = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-acceptance-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let logs = '';
  async function start() {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RELAY_PROFILE: 'local',
        PORT: String(port),
        DATA_DIR: directory,
        ALLOW_PRIVATE_NETWORK: 'true',
        WORKER_CAPACITY: '4',
        WORKER_LEASE_MS: '2000',
        ...extraEnv,
      },
    });
    child.stdout.on('data', (data) => {
      logs = (logs + data).slice(-8000);
    });
    child.stderr.on('data', (data) => {
      logs = (logs + data).slice(-8000);
    });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Isolated application exited: ${logs}`);
      try {
        return (await fetch(origin + '/api/health')).ok;
      } catch {
        return false;
      }
    });
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill(signal);
    await exited;
  }
  await start();
  return {
    origin,
    directory,
    start,
    stop,
    get child() {
      return child;
    },
    async close() {
      await stop();
      assert.equal(path.dirname(directory), os.tmpdir());
      assert.ok(path.basename(directory).startsWith('relay-acceptance-'));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

export async function acceptanceTarget() {
  if (!process.env.ACCEPTANCE_ORIGIN) return localApplication();
  assert.equal(
    process.env.ACCEPTANCE_DISPOSABLE,
    'yes',
    'External target requires ACCEPTANCE_DISPOSABLE=yes; this suite creates synthetic accounts and actions',
  );
  const origin = new URL(process.env.ACCEPTANCE_ORIGIN).origin;
  return { origin, close: async () => {}, external: true };
}
