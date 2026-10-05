import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  acceptanceTarget,
  providerFixture,
  account,
  graph,
  node,
  sleep,
  until,
  waitRun,
} from '../acceptance/support.mjs';
import { distribution, host, resourceSample, directoryBytes, corpusDocument } from './measure.mjs';

const profiles = JSON.parse(await fs.readFile(new URL('./profiles.json', import.meta.url)));
const profileName = process.argv[2] || 'smoke';
assert.ok(profiles[profileName] && profileName !== 'thresholds', 'Choose smoke, load or soak');
const profile = profiles[profileName];
const thresholds = profiles.thresholds;
const output = path.resolve(process.env.LOAD_OUTPUT || 'verification-results/qualification');
await fs.mkdir(output, { recursive: true });
const manifest = {
  version: 1,
  startedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  profileName,
  profile,
  thresholds,
  hardware: host(),
  modelValidation: 'deterministic HTTP fixture; synthetic usage; no real reasoning claim',
  topology: process.env.LOAD_TOPOLOGY
    ? JSON.parse(process.env.LOAD_TOPOLOGY)
    : {
        api: 1,
        embeddedWorkers: 1,
        workerCapacity: 4,
        database: 'SQLite WAL',
        storage: 'local disposable directory',
        qualification: false,
      },
};
if (process.env.ACCEPTANCE_ORIGIN) {
  assert.ok(
    process.env.LOAD_TOPOLOGY,
    'External runs require actual allocation/topology in LOAD_TOPOLOGY JSON',
  );
  assert.ok(
    process.env.LOAD_RESOURCE_FILE,
    'External runs require a resource-series JSON file from operator monitoring',
  );
}
// Write and freeze the acceptance targets before provisioning or measuring.
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
let target, fixture, sampler;
const resources = [],
  samples = {
    api: [],
    retrieval: [],
    queue: [],
    run: [],
    provider: [],
    applicationResidual: [],
    ingestion: [],
  };
const counters = {
  api: { attempted: 0, unexpected: 0, missed: 0 },
  retrieval: { attempted: 0, unexpected: 0, missed: 0 },
  runs: { attempted: 0, unexpected: 0, expectedFaults: 0, lost: 0 },
  ingestion: { attempted: 0, unexpected: 0 },
};
const outcomes = [],
  faults = [];
const queueSeries = [];
let samplerBusy = false;
try {
  target = await acceptanceTarget();
  fixture = await providerFixture();
  if (target.external)
    assert.ok(
      process.env.ACCEPTANCE_FIXTURE_URL,
      'External workers require a reachable standalone fixture',
    );
  const fixtureUrl = process.env.ACCEPTANCE_FIXTURE_URL || fixture.url;
  const workspaces = [];
  for (let i = 0; i < profile.workspaces; i++) {
    const owner = await account(target.origin, `LoadOwner${i}`);
    const base = `/api/w/${owner.wid}`;
    for (let user = 1; user < profile.usersPerWorkspace; user++) {
      const member = await account(target.origin, `LoadViewer${i}_${user}`);
      const invite = await owner.ok(base + '/invitations', { email: member.email, role: 'viewer' });
      await member.ok('/api/invitations/accept', { token: invite.token });
    }
    const collection = await owner.ok(base + '/collections', {
      name: 'Synthetic load corpus',
      config: { chunkSize: 500, overlap: 0, retrieval: 'lexical' },
    });
    const workflows = {};
    for (const model of ['normal', 'auth-error', 'rate-error', 'server-error', 'partial-error']) {
      const connection = await owner.ok(base + '/connections', {
        name: model,
        provider: 'openai-compatible',
        endpoint: fixtureUrl + '/v1',
        model,
        secret: 'synthetic-load-fixture',
        config: { allowPrivate: true },
      });
      workflows[model] = await owner.ok(base + '/workflows', {
        name: `Load ${model}`,
        graph: graph(node('model', 'model', { connectionId: connection.id })),
      });
    }
    workspaces.push({ owner, base, collection, workflows });
  }
  async function ingest(index) {
    const workspace = workspaces[index % workspaces.length];
    const form = new FormData();
    form.set(
      'file',
      new Blob([corpusDocument(index, profile.chunksPerDocument)]),
      `synthetic-policy-${index}.md`,
    );
    const source = await workspace.owner.ok(
      `${workspace.base}/collections/${workspace.collection.id}/upload`,
      form,
    );
    return { source, workspace };
  }
  for (let batch = 0; batch < profile.documents; batch += 8) {
    await Promise.all(
      Array.from({ length: Math.min(8, profile.documents - batch) }, (_, i) => ingest(batch + i)),
    );
    if (batch % 200 === 0) process.stdout.write(`Corpus upload ${batch}/${profile.documents}\n`);
  }
  await until(
    async () => {
      const states = await Promise.all(
        workspaces.map((w) => w.owner.ok(`${w.base}/collections/${w.collection.id}/sources`)),
      );
      return states.flat().every((source) => source.status === 'ready');
    },
    Math.max(60000, profile.documents * 200),
  );
  const corpus = (
    await Promise.all(workspaces.map((w) => w.owner.ok(w.base + '/collections')))
  ).flat();
  manifest.corpus = {
    documents: corpus.reduce((sum, c) => sum + Number(c.source_count), 0),
    chunks: corpus.reduce((sum, c) => sum + Number(c.chunk_count), 0),
    generatedBytes:
      Buffer.byteLength(corpusDocument(0, profile.chunksPerDocument)) * profile.documents,
    retrieval: 'keyword/lexical; semantic capacity requires separate integrated run',
  };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const started = performance.now();
  const measuredAt = started + profile.warmupSeconds * 1000;
  const end = measuredAt + profile.durationSeconds * 1000;
  let sequence = 0;
  sampler = setInterval(async () => {
    if (samplerBusy) return;
    samplerBusy = true;
    try {
      if (!target.external)
        resources.push({
          ...(await resourceSample(target.child.pid)),
          diskBytes: await directoryBytes(target.directory),
        });
      const operations = await Promise.all(
        workspaces.map((w) => w.owner.ok(w.base + '/operations')),
      );
      queueSeries.push({
        at: new Date().toISOString(),
        states: operations
          .flatMap((o) => o.queue)
          .reduce(
            (counts, entry) => ({
              ...counts,
              [entry.status]: (counts[entry.status] || 0) + Number(entry.count),
            }),
            {},
          ),
      });
    } catch {
      resources.push({ at: new Date().toISOString(), unavailable: true });
    } finally {
      samplerBusy = false;
    }
  }, 5000);
  async function openLoop(kind, rate, operation) {
    const pending = new Set();
    let due = started,
      cursor = 0;
    while (performance.now() < end) {
      await sleep(Math.max(0, due - performance.now()));
      if (performance.now() >= end) break;
      const measured = performance.now() >= measuredAt;
      const index = cursor++;
      due += 1000 / rate;
      if (pending.size >= 100) {
        if (measured) counters[kind].missed++;
        continue;
      }
      const beginning = performance.now();
      if (measured) counters[kind].attempted++;
      const task = operation(workspaces[index % workspaces.length])
        .catch(() => {
          if (measured) counters[kind].unexpected++;
        })
        .finally(() => {
          if (measured) samples[kind].push(performance.now() - beginning);
          pending.delete(task);
        });
      pending.add(task);
    }
    await Promise.all(pending);
  }
  async function runs() {
    while (performance.now() < end) {
      const index = sequence++;
      const workspace = workspaces[index % workspaces.length];
      const expectedFault = index % profile.faultEveryRuns === 0;
      const model = expectedFault
        ? ['auth-error', 'rate-error', 'server-error', 'partial-error'][
            Math.floor(index / profile.faultEveryRuns) % 4
          ]
        : 'normal';
      const measured = performance.now() >= measuredAt;
      const correlation = `LOAD-${randomUUID()}`;
      const start = performance.now();
      if (measured) counters.runs.attempted++;
      try {
        const run = await workspace.owner.ok(
          `${workspace.base}/workflows/${workspace.workflows[model].id}/runs`,
          { input: correlation, mode: 'live' },
        );
        const done = await waitRun(workspace.owner, workspace.base, run.id);
        const earliest = Math.min(
          ...done.steps.filter((s) => s.started_at).map((s) => new Date(s.started_at).getTime()),
        );
        const queue = earliest - new Date(done.created_at).getTime();
        const fixtureCalls = target.external
          ? (
              await (
                await fetch(fixtureUrl + '/diagnostics', { signal: AbortSignal.timeout(10000) })
              ).json()
            ).calls
          : fixture.calls;
        const provider = fixtureCalls
          .filter((call) => call.correlation === correlation && call.durationMs != null)
          .reduce((sum, call) => sum + call.durationMs, 0);
        if (measured) {
          samples.queue.push(queue);
          samples.run.push(performance.now() - start);
          if (provider > 0) {
            samples.provider.push(provider);
            samples.applicationResidual.push(
              Math.max(0, new Date(done.finished_at).getTime() - earliest - provider),
            );
          }
          if (expectedFault && done.status === 'failed') {
            counters.runs.expectedFaults++;
            faults.push({ model, expectedStatus: 'failed', observedStatus: done.status });
          } else if (done.status !== 'completed' || expectedFault) counters.runs.unexpected++;
          if (done.status === 'completed' && done.output !== 'Synthetic fixture answer')
            counters.runs.unexpected++;
          outcomes.push({ status: done.status, model, queueMs: queue });
        }
      } catch {
        if (measured) {
          counters.runs.unexpected++;
          counters.runs.lost++;
        }
      }
    }
  }
  async function backgroundIngestion() {
    let index = profile.documents;
    while (performance.now() + profile.ingestionEverySeconds * 1000 < end) {
      await sleep(profile.ingestionEverySeconds * 1000);
      if (performance.now() < measuredAt) continue;
      counters.ingestion.attempted++;
      const start = performance.now();
      try {
        const { source, workspace } = await ingest(index++);
        await until(async () => {
          const state = (
            await workspace.owner.ok(
              `${workspace.base}/collections/${workspace.collection.id}/sources`,
            )
          ).find((s) => s.id === source.id);
          if (state?.status === 'failed') throw new Error('Background ingestion failed');
          return state?.status === 'ready';
        });
        samples.ingestion.push(performance.now() - start);
      } catch {
        counters.ingestion.unexpected++;
      }
    }
  }
  process.stdout.write(
    `Measuring ${profileName}: ${profile.durationSeconds}s after ${profile.warmupSeconds}s warmup; ${profile.concurrency} active clients\n`,
  );
  await Promise.all([
    openLoop('api', profile.apiRps, (w) => w.owner.ok(w.base + '/workflows')),
    openLoop('retrieval', profile.retrievalRps, (w) =>
      w.owner.ok(`${w.base}/collections/${w.collection.id}/retrieve`, {
        query: 'travel reimbursement',
        topK: 5,
      }),
    ),
    ...Array.from({ length: profile.concurrency }, runs),
    backgroundIngestion(),
  ]);
  if (sampler) clearInterval(sampler);
  while (samplerBusy) await sleep(20);
  if (target.external) {
    const externalResources = JSON.parse(await fs.readFile(process.env.LOAD_RESOURCE_FILE, 'utf8'));
    for (const r of externalResources) {
      assert.equal(
        r.scope,
        'application-total',
        'Aggregate resources across application processes, excluding the load generator',
      );
      assert.ok(Number.isFinite(r.rssBytes) && Number.isFinite(r.cpuSeconds));
      resources.push({ at: r.at, rssBytes: r.rssBytes, cpuSeconds: r.cpuSeconds, scope: r.scope });
    }
  }
  const percentiles = Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [name, distribution(values)]),
  );
  const errorRate = (kind) => counters[kind].unexpected / Math.max(1, counters[kind].attempted);
  const stable = resources.filter(
    (r) => r.rssBytes && new Date(r.at).getTime() >= Date.now() - 30 * 60 * 1000,
  );
  const half = Math.floor(stable.length / 2);
  const average = (series) => series.reduce((sum, r) => sum + r.rssBytes, 0) / series.length;
  const memoryGrowth = half
    ? average(stable.slice(half)) / average(stable.slice(0, half)) - 1
    : null;
  const finalQueue = (
    await Promise.all(workspaces.map((w) => w.owner.ok(w.base + '/operations')))
  ).flatMap((o) => o.queue);
  const remainingActive = finalQueue
    .filter((entry) => ['queued', 'running'].includes(entry.status))
    .reduce((sum, entry) => sum + Number(entry.count), 0);
  const queueBounded =
    queueSeries.length > 0 &&
    queueSeries.every((q) => (q.states.queued || 0) <= thresholds.maximumQueuedRuns) &&
    remainingActive <= thresholds.remainingActiveRuns;
  const gates = {
    P01:
      percentiles.api.p95 != null &&
      percentiles.api.p95 <= thresholds.apiP95Ms &&
      errorRate('api') < thresholds.unexpectedErrorRateExclusive &&
      counters.api.attempted >=
        profile.apiRps * profile.durationSeconds * thresholds.minimumRateFraction &&
      !counters.api.missed,
    P02:
      percentiles.retrieval.p95 != null &&
      percentiles.retrieval.p95 <= thresholds.retrievalP95Ms &&
      errorRate('retrieval') < thresholds.unexpectedErrorRateExclusive &&
      counters.retrieval.attempted >=
        profile.retrievalRps * profile.durationSeconds * thresholds.minimumRateFraction &&
      !counters.retrieval.missed,
    P03:
      percentiles.queue.p95 != null &&
      percentiles.queue.p95 <= thresholds.dispatchP95Ms &&
      !counters.runs.lost &&
      !counters.runs.unexpected &&
      !counters.ingestion.unexpected,
    P04:
      profile.durationSeconds >= 3600
        ? stable.length >= 300 &&
          memoryGrowth < thresholds.stableMemoryGrowthExclusive &&
          !counters.runs.lost &&
          queueBounded
        : null,
  };
  const report = {
    ...manifest,
    finishedAt: new Date().toISOString(),
    counters,
    percentilesMs: percentiles,
    unexpectedErrorRates: {
      api: errorRate('api'),
      retrieval: errorRate('retrieval'),
      runs: errorRate('runs'),
    },
    observedRps: {
      api: counters.api.attempted / profile.durationSeconds,
      retrieval: counters.retrieval.attempted / profile.durationSeconds,
    },
    resources,
    stableMemoryGrowth: memoryGrowth,
    queueSeries,
    remainingActive,
    faults,
    outcomes,
    thresholdChecks: gates,
    releaseGates: Object.fromEntries(
      Object.entries(gates).map(([id, passed]) => [
        id,
        !target.external ||
        profile.durationSeconds < 3600 ||
        profile.apiRps < 20 ||
        profile.retrievalRps < 10 ||
        manifest.corpus.chunks < 50000
          ? 'blocked: target topology/workload/duration is not qualified'
          : passed === null
            ? 'blocked: measurement unavailable'
            : passed
              ? 'pending: correlate with service, ACL and quality evidence'
              : 'failed',
      ]),
    ),
    interpretation:
      'Checks apply only to this manifest. P02 needs 50,000 actual chunks and ACL quality; P04 needs one hour. Provider duration is measured at the fixture; application residual includes network/adapter/persistence time and excludes dispatch. Unavailable timings stay null. This report cannot certify another commit or topology.',
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify(
      { output, thresholdChecks: gates, percentilesMs: percentiles, counters },
      null,
      2,
    ) + '\n',
  );
  if (Object.values(gates).some((value) => value === false)) process.exitCode = 1;
} catch (error) {
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        failedAt: new Date().toISOString(),
        classification: 'harness or application failure',
        message: String(error.message).slice(0, 500),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (sampler) clearInterval(sampler);
  while (samplerBusy) await sleep(20);
  await target?.close();
  await fixture?.close();
}
