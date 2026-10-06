import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createTelemetry,
  safeMetadata,
  parseTraceparent,
} from '../server/observability/telemetry.js';
import {
  createHealth,
  requestTelemetry,
  registerOperations,
} from '../server/observability/health.js';

test('sensitive values and arbitrary errors never enter logs/traces; exporter failure preserves business results', async () => {
  const logs = [];
  const spans = [];
  const telemetry = createTelemetry({
    write: (line) => logs.push(line),
    exporter: async (span) => {
      spans.push(span);
      throw new Error('private');
    },
  });
  assert.equal(
    await telemetry.span(
      'provider',
      {
        requestId: 'safe',
        apiKey: 'SECRET',
        email: 'PRIVATE',
        code: 'TOKEN with spaces',
        runId: 'run1',
      },
      async () => 42,
    ),
    42,
  );
  await assert.rejects(
    telemetry.span('tool', { password: 'SECRET' }, async () => {
      throw new Error('SECRET');
    }),
  );
  await telemetry.flush();
  assert.ok(!JSON.stringify({ logs, spans }).includes('SECRET'));
  assert.ok(!JSON.stringify({ logs, spans }).includes('PRIVATE'));
  assert.match(telemetry.metrics(), /relay_telemetry_dropped_total 2/);
  assert.match(telemetry.metrics(), /kind="tool",status="error"/);
  assert.deepEqual(safeMetadata({ authorization: 'secret', durationMs: Infinity, status: 'ok' }), {
    status: 'ok',
  });
});
test('concurrent request contexts and nested provider/tool/retrieval spans preserve isolated trace parents', async () => {
  const spans = [];
  const telemetry = createTelemetry({
    write: () => {},
    exporter: async (span) => spans.push(span),
  });
  await Promise.all(
    ['requestA', 'requestB'].map((requestId) =>
      telemetry.span('api', { requestId }, async () => {
        const parent = telemetry.headers().traceparent;
        await telemetry.span('provider', {}, async () => {
          await telemetry.span('tool', {}, async () => {});
        });
        await telemetry.job({ requestId, id: 'job1' }, parent, async () =>
          telemetry.span('retrieval', {}, async () => {}),
        );
      }),
    ),
  );
  await telemetry.flush();
  const roots = spans.filter((span) => span.name === 'relay.api');
  assert.equal(roots.length, 2);
  assert.notEqual(roots[0].traceId, roots[1].traceId);
  for (const root of roots)
    assert.equal(spans.filter((span) => span.traceId === root.traceId).length, 5);
  assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-' + '1'.repeat(16) + '-01'), undefined);
});
test('readiness requires integration and successful bounded probes, and draining fails readiness', async () => {
  const unintegrated = createHealth({ probes: { db: async () => true } });
  unintegrated.start();
  assert.equal((await unintegrated.ready()).ready, false);
  const health = createHealth({
    integrated: true,
    timeoutMs: 20,
    probes: { db: async () => true },
  });
  health.start();
  assert.equal((await health.ready()).ready, true);
  health.drain();
  assert.equal((await health.ready()).ready, false);
  const hung = createHealth({
    integrated: true,
    timeoutMs: 20,
    probes: { db: () => new Promise(() => {}) },
  });
  hung.start();
  assert.equal((await hung.ready()).dependencies.db, false);
});
test('HTTP correlation is validated and metrics requires authentication', async () => {
  const app = express();
  const telemetry = createTelemetry({ write: () => {} });
  const health = createHealth({ integrated: true, probes: {} });
  health.start();
  app.use(requestTelemetry(telemetry));
  registerOperations(app, { health, telemetry, metricsToken: 'test-token' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(url + '/health/ready', {
      headers: { 'x-request-id': 'caller-1' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'caller-1');
    assert.equal((await fetch(url + '/metrics')).status, 403);
    assert.equal(
      (await fetch(url + '/metrics', { headers: { authorization: 'Bearer test-token' } })).status,
      200,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
