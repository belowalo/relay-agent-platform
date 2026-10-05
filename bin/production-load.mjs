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
}) {
  const stats = {
      api: { latencies: [], offered: 0, completed: 0, errors: 0 },
      retrieval: { latencies: [], offered: 0, completed: 0, errors: 0 },
    },
    resources = [];
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
      if (!v.r.ok || (kind === 'retrieval' && !v.data.evidence?.length)) s.errors++;
      else s.completed++;
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
    await Promise.all([generate('api', 20), generate('retrieval', 10)]);
    await Promise.all(pending);
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
    Object.values(result.memoryGrowth).every((v) => Number.isFinite(v) && v < 0.1);
  result.scope =
    'One host, eight load users, small actually ingested corpus. This does not qualify the declared two-host/100-user/50,000-chunk profile.';
  return result;
}
