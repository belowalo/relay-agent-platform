import crypto from 'node:crypto';
import { validateGraph } from '../catalog.js';
import { tenantContextSchema } from '../foundation/contracts.js';
export const json = (value) => JSON.stringify(value ?? null);
export const decode = (value) => (value == null ? null : JSON.parse(value));
export const uuid = () => crypto.randomUUID();
export const instant = () => new Date().toISOString();
export function bestEffortTelemetry(port) {
  const call = (method, ...args) => {
    try {
      Promise.resolve(port?.[method]?.(...args)).catch(() => {});
    } catch {}
  };
  return {
    event: (...args) => call('event', ...args),
    timing: (...args) => call('timing', ...args),
  };
}
// Keep legacy field aliases while exposing v1 camelCase row fields. JSON payload
// keys are user data and are never renamed; bigint counters become safe numbers.
export function publicRow(row) {
  if (!row) return row;
  const result = {};
  const jsonColumns = new Set([
    'graph',
    'input',
    'output',
    'usage',
    'config',
    'arguments',
    'result',
    'resolution',
    'checkpoint',
    'data',
  ]);
  const numericColumns = new Set([
    'revision',
    'sequence',
    'event_seq',
    'attempt',
    'max_running',
    'max_queued',
    'attempts',
    'active_ms',
  ]);
  for (const [key, raw] of Object.entries(row)) {
    let value = jsonColumns.has(key) && typeof raw === 'string' ? decode(raw) : raw;
    if (numericColumns.has(key) && typeof raw === 'string' && Number.isSafeInteger(Number(raw)))
      value = Number(raw);
    result[key] = value;
    if (key.includes('_')) result[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return result;
}
export class RuntimeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
export const fail = (code) => {
  throw new RuntimeError(code);
};
const dependencyCodes = new Set([
  'DEPENDENCY_UNAVAILABLE',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONFLICT',
  'NOT_FOUND',
  'VALIDATION_ERROR',
]);
export function safeCode(error, fallback = 'EXECUTION_FAILED') {
  if (error instanceof RuntimeError && /^[A-Z_]{1,64}$/.test(error.code)) return error.code;
  return dependencyCodes.has(error?.code) ? error.code : fallback;
}
export const clockSql = '(extract(epoch from clock_timestamp())*1000)::bigint';
export function contextFor(run) {
  return tenantContextSchema.parse({
    workspaceId: run.workspace_id,
    actor: decode(run.actor),
    requestId: run.request_id,
  });
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  if (
    value === undefined ||
    typeof value === 'function' ||
    (!Number.isFinite(value) && typeof value === 'number')
  )
    fail('INVALID_ARGUMENTS');
  return JSON.stringify(value);
}
export const argumentHash = (value) =>
  crypto.createHash('sha256').update(canonical(value)).digest('hex');
export function limitsFor(input = {}) {
  const bounds = {
    durationMs: [900000, 1000, 900000],
    nodeTimeoutMs: [60000, 100, 600000],
    rounds: [5, 1, 12],
    tools: [30, 0, 100],
    nodes: [50, 1, 50],
    parallelism: [4, 1, 8],
    outputBytes: [1048576, 1024, 10485760],
    childDepth: [5, 0, 5],
  };
  return Object.fromEntries(
    Object.entries(bounds).map(([key, [fallback, min, max]]) => {
      const value = input[key] ?? fallback;
      if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_LIMITS');
      return [key, value];
    }),
  );
}
export function checkGraph(graph, limits = limitsFor()) {
  if (
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    graph.nodes.length > limits.nodes ||
    Buffer.byteLength(json(graph)) > limits.outputBytes
  )
    fail('INVALID_GRAPH');
  const errors = validateGraph(graph);
  if (errors.length) throw new RuntimeError('INVALID_GRAPH', errors.join('; '));
  return graph;
}
export function boundOutput(value, limits) {
  if (Buffer.byteLength(json(value)) > limits.outputBytes) fail('RESOURCE_LIMIT');
  return value;
}
export const getPath = (value, path) =>
  String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((v, k) => v?.[k], value);
export function plan(graph, steps, input) {
  const ready = [],
    skipped = [];
  const rows = new Map(steps.map((s) => [s.node_id, s]));
  for (const node of graph.nodes) {
    if (rows.get(node.id)?.status !== 'queued') continue;
    const incoming = graph.edges.filter((e) => e.target === node.id);
    const parents = incoming.map((e) => rows.get(e.source));
    if (parents.some((s) => !s || ['queued', 'running', 'waiting'].includes(s.status))) continue;
    const active = incoming.filter((e) => {
      const s = rows.get(e.source),
        output = decode(s.output);
      return (
        s.status === 'completed' &&
        (!output?.branch || (e.data?.branch || e.label) === output.branch)
      );
    });
    if (
      incoming.length &&
      (!active.length ||
        (parents.some((s) => s.status === 'failed') && !node.data.config?.continueOnError))
    ) {
      skipped.push(node.id);
      continue;
    }
    const values = active.map((e) => {
      const out = decode(rows.get(e.source).output);
      return out?.branch ? out.value : out;
    });
    ready.push({
      node,
      step: rows.get(node.id),
      input:
        values.length === 1
          ? values[0]
          : values.length
            ? Object.fromEntries(active.map((e, i) => [e.source, values[i]]))
            : input,
    });
  }
  return { ready, skipped };
}
