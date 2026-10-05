import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { requestId } from '../foundation/context.js';

const context = new AsyncLocalStorage();
const kinds = new Set([
  'api',
  'job',
  'provider',
  'tool',
  'retrieval',
  'database',
  'queue',
  'storage',
]);
const fields = new Set([
  'requestId',
  'runId',
  'jobId',
  'workspaceId',
  'code',
  'kind',
  'status',
  'durationMs',
  'attempt',
  'generation',
  'ready',
  'signal',
]);
const safeId = /^[a-zA-Z0-9_-]{1,128}$/;
const buckets = [0.01, 0.05, 0.1, 0.3, 1, 3, 10, 30, 120];
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
export function safeMetadata(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) =>
        fields.has(key) &&
        (typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && safeId.test(value))),
    ),
  );
}
export function parseTraceparent(value) {
  const match = typeof value === 'string' && /^00-([a-f0-9]{32})-([a-f0-9]{16})-0[01]$/.exec(value);
  return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
    ? { traceId: match[1], spanId: match[2] }
    : undefined;
}
export function createTelemetry({
  service = 'relay-api',
  write = (line) => process.stdout.write(line + '\n'),
  exporter,
  maxPending = 64,
} = {}) {
  if (!safeId.test(service)) throw new Error('Invalid telemetry service');
  const metrics = new Map();
  const gauges = new Map();
  const pending = new Set();
  let dropped = 0;
  const log = (event, metadata = {}) => {
    if (!safeId.test(event)) event = 'event';
    const current = context.getStore();
    try {
      write(
        JSON.stringify({
          time: new Date().toISOString(),
          service,
          event,
          ...safeMetadata(metadata),
          ...(current
            ? { requestId: current.requestId, traceId: current.traceId, spanId: current.spanId }
            : {}),
        }),
      );
    } catch {
      /* Logging cannot fail business work. */
    }
  };
  function record(kind, status, seconds) {
    if (!kinds.has(kind)) kind = 'api';
    status = status === 'ok' ? 'ok' : 'error';
    const key = `${kind}:${status}`;
    const entry = metrics.get(key) || {
      kind,
      status,
      count: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    };
    entry.count++;
    entry.sum += seconds;
    buckets.forEach((limit, i) => {
      if (seconds <= limit) entry.buckets[i]++;
    });
    metrics.set(key, entry);
  }
  async function span(kind, metadata, callback, parent) {
    if (!kinds.has(kind)) throw new Error('Invalid span kind');
    const upstream = parent || context.getStore();
    const state = {
      requestId: requestId(metadata?.requestId || upstream?.requestId),
      traceId: upstream?.traceId || hex(16),
      spanId: hex(8),
    };
    const started = Date.now();
    const startTimeUnixNano = String(BigInt(started) * 1000000n);
    let status = 'ok';
    return context.run(state, async () => {
      try {
        return await callback();
      } catch (error) {
        status = 'error';
        throw error;
      } finally {
        const durationMs = Date.now() - started;
        record(kind, status, durationMs / 1000);
        const attributes = safeMetadata({ ...metadata, kind, status });
        log('span_completed', { ...attributes, durationMs });
        if (exporter && pending.size < maxPending) {
          const value = {
            traceId: state.traceId,
            spanId: state.spanId,
            ...(upstream?.spanId ? { parentSpanId: upstream.spanId } : {}),
            name: `relay.${kind}`,
            kind: kind === 'api' ? 2 : 1,
            startTimeUnixNano,
            endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
            attributes: Object.entries(attributes).map(([key, value]) => ({
              key,
              value:
                typeof value === 'string'
                  ? { stringValue: value }
                  : typeof value === 'boolean'
                    ? { boolValue: value }
                    : { doubleValue: value },
            })),
            status: { code: status === 'ok' ? 1 : 2 },
          };
          const task = Promise.resolve()
            .then(() => exporter(value))
            .catch(() => {
              dropped++;
            })
            .finally(() => pending.delete(task));
          pending.add(task);
        } else if (exporter) dropped++;
      }
    });
  }
  return {
    log,
    span,
    headers: () => {
      const current = context.getStore();
      return current
        ? {
            'x-request-id': current.requestId,
            traceparent: `00-${current.traceId}-${current.spanId}-01`,
          }
        : {};
    },
    // Queue envelope stays v1. Persist traceparent alongside authoritative run state and pass it here.
    job: (job, traceparent, callback) =>
      span('job', { requestId: job.requestId, jobId: job.id, kind: job.kind }, callback, {
        ...parseTraceparent(traceparent),
        requestId: job.requestId,
      }),
    gauge(name, value) {
      if (
        ![
          'queue_age_seconds',
          'queue_waiting',
          'worker_heartbeat_age_seconds',
          'worker_active',
          'dependency_ready',
          'backup_age_seconds',
          'disk_free_bytes',
        ].includes(name) ||
        !Number.isFinite(value) ||
        value < 0
      )
        throw new Error('Invalid operational metric');
      gauges.set(name, value);
    },
    retry(kind) {
      if (!kinds.has(kind)) throw new Error('Invalid retry kind');
      const name = `retries_${kind}`;
      gauges.set(name, (gauges.get(name) || 0) + 1);
    },
    metrics() {
      const lines = [
        '# TYPE relay_operations_total counter',
        '# TYPE relay_operation_duration_seconds histogram',
      ];
      for (const entry of metrics.values()) {
        const labels = `kind="${entry.kind}",status="${entry.status}"`;
        lines.push(`relay_operations_total{${labels}} ${entry.count}`);
        buckets.forEach((limit, i) =>
          lines.push(
            `relay_operation_duration_seconds_bucket{${labels},le="${limit}"} ${entry.buckets[i]}`,
          ),
        );
        lines.push(
          `relay_operation_duration_seconds_bucket{${labels},le="+Inf"} ${entry.count}`,
          `relay_operation_duration_seconds_count{${labels}} ${entry.count}`,
          `relay_operation_duration_seconds_sum{${labels}} ${entry.sum}`,
        );
      }
      for (const [key, value] of gauges)
        lines.push(
          `# TYPE relay_${key} ${key.startsWith('retries_') ? 'counter' : 'gauge'}`,
          `relay_${key} ${value}`,
        );
      lines.push(
        '# TYPE relay_telemetry_dropped_total counter',
        `relay_telemetry_dropped_total ${dropped}`,
        '# TYPE relay_process_uptime_seconds gauge',
        `relay_process_uptime_seconds ${process.uptime()}`,
      );
      return lines.join('\n') + '\n';
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}
export function otlpExporter(endpoint, service) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search)
    throw new Error('Invalid OTLP endpoint');
  return async (span) => {
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
            scopeSpans: [{ scope: { name: 'relay.operations', version: '1' }, spans: [span] }],
          },
        ],
      }),
    });
    if (!response.ok) throw new Error('Telemetry export failed');
    await response.body?.cancel();
  };
}
