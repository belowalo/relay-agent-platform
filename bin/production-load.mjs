// Measures the actual deployed application. No synthetic response is substituted
// for authentication, SQL, ACL filtering, CPU embedding, retrieval or dispatch.
import { performance } from 'node:perf_hooks';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p95 = (a) => (a.length ? [...a].sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1] : null);
export async function measureProductionWorkload({
  request,
  base,
  collectionId,
  cookies,
  durationSeconds,
  sampleResources,
  progress,
  executeWorkflow,
}) {
  const stats = {
      api: { latencies: [], offered: 0, completed: 0, errors: 0, failures: {} },
      retrieval: { latencies: [], offered: 0, completed: 0, errors: 0, failures: {} },
    },
    resources = [],
    dispatch = { runs: [], errors: 0 };
  const pending = new Set();
  const start = performance.now(),
    end = start + durationSeconds * 1000;
  let identity = 0,
    maxPending = 0,
    sampling = false;
  async function offered(kind) {
    const s = stats[kind],
      cookie = cookies[identity++ % cookies.length],
      t = performance.now();
    s.offered++;
    try {
      const v = await request(
        kind === 'api' ? base + '/overview' : `${base}/collections/${collectionId}/search`,
        kind === 'api' ? undefined : { query: 'approved travel limit', mode: 'hybrid', topK: 5 },
        undefined,
        cookie,
      );
      if (!v.r.ok || (kind === 'retrieval' && !v.data.evidence?.length)) {
        s.errors++;
        const code = !v.r.ok ? `http_${v.r.status}` : 'missing_evidence';
        s.failures[code] = (s.failures[code] || 0) + 1;
      } else s.completed++;
    } catch {
      s.errors++;
    } finally {
      s.latencies.push(performance.now() - t);
    }
  }
  async function generate(kind, rate) {
    let n = 0;
    while (performance.now() < end) {
      await sleep(Math.max(0, start + (n++ * 1000) / rate - performance.now()));
      if (performance.now() >= end) break;
      // Bound the driver and count skipped offers rather than disguising saturation.
      if (pending.size >= 100) {
        stats[kind].offered++;
        stats[kind].errors++;
        continue;
      }
      const p = offered(kind).finally(() => pending.delete(p));
      pending.add(p);
      maxPending = Math.max(maxPending, pending.size);
    }
  }
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      resources.push({
        elapsedSeconds: (performance.now() - start) / 1000,
        ...(await sampleResources()),
      });
    } finally {
      sampling = false;
    }
  }
  async function workflows() {
    if (!executeWorkflow) return;
    let due = start;
    while (performance.now() < end) {
      await sleep(Math.max(0, due - performance.now()));
      if (performance.now() >= end) break;
      due += 10000;
      try {
        const run = await executeWorkflow();
        const firstStep = Math.min(
          ...run.steps.filter((s) => s.started_at).map((s) => Date.parse(s.started_at)),
        );
        const dispatchMs = firstStep - Date.parse(run.created_at);
        if (run.status !== 'completed' || !Number.isFinite(dispatchMs) || dispatchMs < 0)
          dispatch.errors++;
        dispatch.runs.push({ id: run.id, status: run.status, dispatchMs });
      } catch {
        dispatch.errors++;
      }
    }
  }
  await sample();
  const timer = setInterval(() => sample().catch(() => {}), 15000),
    notices = setInterval(
      () =>
        progress?.({
          elapsedSeconds: Math.round((performance.now() - start) / 1000),
          api: stats.api.completed,
          retrieval: stats.retrieval.completed,
        }),
      60000,
    );
  try {
    await Promise.all([generate('api', 20), generate('retrieval', 10), workflows()]);
    await Promise.all(pending);
    while (sampling) await sleep(20);
    await sample();
  } finally {
    clearInterval(timer);
    clearInterval(notices);
  }
  const elapsedSeconds = (performance.now() - start) / 1000,
    result = {
      durationSeconds,
      elapsedSeconds,
      registeredLoadUsers: cookies.length,
      maxDriverPending: maxPending,
      resources,
    };
  for (const [kind, s] of Object.entries(stats)) {
    const targetRate = kind === 'api' ? 20 : 10;
    result[kind] = {
      offered: s.offered,
      completed: s.completed,
      unexpectedErrors: s.errors,
      failureCounts: s.failures,
      p95Ms: p95(s.latencies),
      offeredRate: s.offered / durationSeconds,
      achievedRate: s.completed / durationSeconds,
      errorRate: s.errors / s.offered,
    };
    result[kind].passed =
      result[kind].p95Ms <= (kind === 'api' ? 300 : 1000) &&
      result[kind].errorRate < 0.01 &&
      result[kind].achievedRate >= targetRate * 0.95;
  }
  result.maxQueueWaiting = Math.max(...resources.map((s) => s.queueWaiting ?? Infinity));
  result.dispatch = {
    ...dispatch,
    p95Ms: p95(dispatch.runs.map((r) => r.dispatchMs)),
    configuredIntervalSeconds: 10,
    configuredConcurrentClients: 1,
    remainingActiveRuns: dispatch.runs.filter((r) =>
      ['queued', 'running', 'waiting'].includes(r.status),
    ).length,
  };
  result.dispatch.passed =
    !executeWorkflow ||
    (result.dispatch.runs.length >= (durationSeconds / 10) * 0.9 &&
      result.dispatch.p95Ms !== null &&
      result.dispatch.p95Ms <= 2000 &&
      !result.dispatch.errors &&
      !result.dispatch.remainingActiveRuns);
  result.memoryGrowth = {};
  const window = resources.filter((s) => s.elapsedSeconds >= Math.max(0, durationSeconds - 1800));
  if (durationSeconds >= 3600 && window.length >= 8)
    for (const id of Object.keys(window[0].memoryBytes || {})) {
      const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;
      const before = average(window.slice(0, 8).map((s) => s.memoryBytes[id])),
        after = average(window.slice(-8).map((s) => s.memoryBytes[id]));
      result.memoryGrowth[id] = (after - before) / before;
    }
  result.passed =
    result.api.passed &&
    result.retrieval.passed &&
    result.maxQueueWaiting <= 50 &&
    result.dispatch.passed &&
    (durationSeconds < 3600 || Object.keys(result.memoryGrowth).length === 4) &&
    Object.values(result.memoryGrowth).every((v) => Number.isFinite(v) && v < 0.1);
  result.scope =
    'One host, eight read-load users and one sequential workflow issuer, small actually ingested corpus. Workflow dispatch uses a synthetic provider. This does not qualify the declared two-host/100-user/25-concurrent-run/50,000-chunk profile.';
  return result;
}
