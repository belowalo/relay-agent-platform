import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { measureProductionWorkload } from './production-load.mjs';
import { verifyProductionBrowser } from './production-browser.mjs';
import { verifyProductionBusiness } from './production-business.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-integrated-'));
const project = 'relay-integrated-' + crypto.randomBytes(4).toString('hex');
const results = path.resolve(process.env.PRODUCTION_RESULTS || 'production-results');
await fs.mkdir(results, { recursive: true });
const env = { ...process.env, RELEASE_COMMIT: process.env.GITHUB_SHA || 'working-tree' };
const report = {
  releaseCommit: env.RELEASE_COMMIT,
  runtimeIntegrated: true,
  hosts: 1,
  modelEvidence: 'Synthetic protocol endpoint only; live quality is unqualified',
  deployment:
    'Production Compose, restricted roles, S3, CPU embeddings, parser, 2 API + 2 worker containers',
  host: { cpuCount: os.availableParallelism(), memoryBytes: os.totalmem() },
  startedAt: new Date().toISOString(),
  checks: [],
};
let secrets = ['synthetic-deployment-credential'];
const sanitize = (v) => secrets.reduce((s, k) => s.replaceAll(k, '[REDACTED]'), v);
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
    });
    child.stderr.on('data', (b) => {
      stderr += b;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || 600000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      const value = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) resolve(value);
      else
        reject(
          new Error(
            sanitize(`${command} failed (${code}): ${stderr.slice(-5000)} ${stdout.slice(-2000)}`),
          ),
        );
    });
  });
}
const base = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  path.join(root, 'production.env'),
  '-f',
  'deploy/compose.production.yaml',
];
const compose = (...args) => run('docker', [...base, ...args]);
let api,
  apis = [],
  apiIndex = 0,
  cookie = '',
  workspace;
const origin = 'https://relay.example.com';
async function request(route, body, method, cookieValue = cookie) {
  const r = await fetch((apis.length ? apis[apiIndex++ % apis.length] : api) + route, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      Origin: origin,
      Cookie: cookieValue,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { r, data };
}
async function until(callback, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await callback();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Qualification deadline exceeded');
}
async function ready() {
  await until(async () => {
    try {
      return (await request('/health/ready')).r.ok;
    } catch {
      return false;
    }
  });
}
async function refreshApis() {
  apis = await Promise.all(
    [1, 2].map(
      async (index) =>
        'http://' + (await compose('port', '--index', String(index), 'api', '4311')).stdout.trim(),
    ),
  );
  api = apis[0];
}
async function drill(name, callback) {
  console.log(JSON.stringify({ name, status: 'started' }));
  const start = Date.now();
  await callback();
  const v = { name, status: 'passed', elapsedMs: Date.now() - start };
  report.checks.push(v);
  console.log(JSON.stringify(v));
}
const graph = (kind, config = {}) => ({
  nodes: ['in', 'work', 'out'].map((id, i) => ({
    id,
    type: 'relay',
    position: { x: i * 340, y: 0 },
    data: {
      kind: i === 0 ? 'input' : i === 2 ? 'output' : kind,
      label: id,
      config: i === 1 ? config : {},
    },
  })),
  edges: [
    { id: 'a', source: 'in', target: 'work' },
    { id: 'b', source: 'work', target: 'out' },
  ],
});
const expect = (v, status) => {
  assert.equal(v.r.status, status, JSON.stringify(v.data));
  return v.data;
};
let runId, sourceId, collectionId, connectionId, workflowId;
try {
  report.releaseCommit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  env.RELEASE_COMMIT = report.releaseCommit;
  await run('docker', ['info']);
  await run(process.execPath, ['bin/operations-init.mjs', root]);
  for (const f of await fs.readdir(path.join(root, 'secrets')))
    secrets.push((await fs.readFile(path.join(root, 'secrets', f), 'utf8')).trim());
  await run(process.execPath, ['bin/provision-embeddings.mjs', path.join(root, 'models')]);
  const override = path.join(root, 'integrated.yaml');
  await fs.writeFile(
    override,
    `services:
  api:
    environment:
      RUNTIME_LEASE_MS: '2000'
      ALLOW_REGISTRATION: 'true'
      OUTBOUND_POLICY_JSON: '{"origins":["http://qualification-model:4320"],"privateCidrs":["172.16.0.0/12","192.168.0.0/16","10.0.0.0/8"]}'
    ports: ['127.0.0.1::4311']
  worker:
    environment:
      RUNTIME_LEASE_MS: '2000'
      OUTBOUND_POLICY_JSON: '{"origins":["http://qualification-model:4320"],"privateCidrs":["172.16.0.0/12","192.168.0.0/16","10.0.0.0/8"]}'
  qualification-model:
    image: relay-operations:local
    command: [node, bin/production-fixture.mjs]
    environment: { INTEGRATION_FIXTURE: 'true', PORT: '4320' }
    networks: [private]
    read_only: true
    cap_drop: [ALL]
    mem_limit: 128m
    cpus: 0.25
  proxy:
    ports: !override ['127.0.0.1:443:8443']
    volumes: ['${path.resolve('deploy/qualification/Caddyfile').replaceAll('\\', '/')}:/etc/caddy/Caddyfile:ro']
  backup:
    environment: { BACKUP_QUIESCED: 'true', RELEASE_COMMIT: '${env.RELEASE_COMMIT}' }
`,
  );
  base.push('-f', override);
  await drill('build-migrate-start-actual-application', async () => {
    await compose('build', 'api', 'backup', 'database', 'proxy', 'alertmanager');
    await compose(
      'up',
      '-d',
      '--wait',
      'database',
      'queue',
      'storage',
      'collector',
      'qualification-model',
    );
    await compose('run', '--rm', 'migrate');
    const ownerPassword = path.join(root, 'owner-password');
    await fs.writeFile(ownerPassword, 'Disposable-provisioned-2026', { mode: 0o444 });
    const provisioned = JSON.parse(
      (
        await compose(
          'run',
          '--rm',
          '-v',
          `${ownerPassword}:/run/owner-password:ro`,
          '-e',
          'PROVISION_EMAIL=provisioned@relay.test',
          '-e',
          'PROVISION_NAME=Private provisioned owner',
          '-e',
          'PROVISION_PASSWORD_FILE=/run/owner-password',
          'migrate',
          'node',
          'bin/production-admin.mjs',
          'create-owner',
        )
      ).stdout.trim(),
    );
    assert.equal(provisioned.provisioned, true);
    await compose(
      'run',
      '--rm',
      '--no-deps',
      'api',
      'node',
      '--input-type=module',
      '-e',
      "import fs from 'node:fs';import {createS3} from './server/observability/s3.js';await createS3({endpoint:process.env.S3_ENDPOINT,bucket:process.env.S3_BUCKET,accessKey:fs.readFileSync('/run/secrets/s3_access_key','utf8').trim(),secretKey:fs.readFileSync('/run/secrets/s3_secret_key','utf8').trim()}).createBucket();",
    );
    await compose(
      'up',
      '-d',
      '--wait',
      '--scale',
      'api=2',
      '--scale',
      'worker=2',
      'api',
      'worker',
      'parser',
      'proxy',
    );
    await refreshApis();
    apis = [api, 'http://' + (await compose('port', '--index', '2', 'api', '4311')).stdout.trim()];
    await ready();
    const ids = (await compose('ps', '-q', 'api', 'worker', 'parser')).stdout.trim().split(/\s+/);
    const containers = JSON.parse((await run('docker', ['inspect', ...ids])).stdout);
    assert.equal(containers.length, 5);
    for (const c of containers) {
      assert.equal(c.Config.User, '1000:1000');
      assert.equal(c.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
      assert.ok(c.HostConfig.Memory > 0);
    }
    const parser = containers.find((c) =>
      c.Config.Cmd.includes('server/production/parser-service.js'),
    );
    assert.equal(Object.keys(parser.NetworkSettings.Networks).length, 1);
    assert.ok(
      parser.Mounts.filter((m) => m.Destination.startsWith('/run/secrets/')).every((m) =>
        m.Destination.endsWith('/parser_token'),
      ),
    );
    const net = JSON.parse(
      (await run('docker', ['network', 'inspect', Object.keys(parser.NetworkSettings.Networks)[0]]))
        .stdout,
    )[0];
    assert.equal(net.Internal, true);
    await compose(
      'exec',
      '-T',
      'parser',
      'node',
      '--input-type=module',
      '-e',
      "import fs from 'node:fs';import assert from 'node:assert/strict';assert.deepEqual(fs.readdirSync('/run/secrets'),['parser_token']);for(const u of ['http://database:5432','https://example.com']){let denied=false;try{await fetch(u,{signal:AbortSignal.timeout(2000)})}catch{denied=true}assert.ok(denied)}",
    );
    report.containerLimits = containers.map((c) => ({
      role: c.Config.Env.find((v) => v.startsWith('ENGINE_ROLE=')) || 'parser',
      memoryBytes: c.HostConfig.Memory,
      nanoCpus: c.HostConfig.NanoCpus,
    }));
  });
  await drill('tls-spa-and-private-metrics', async () => {
    const port = (await compose('port', 'proxy', '8443')).stdout.trim().split(':').at(-1);
    const curl = (p) =>
      run('curl', [
        '--silent',
        '--show-error',
        '--insecure',
        '--resolve',
        `relay.example.com:${port}:127.0.0.1`,
        `https://relay.example.com:${port}${p}`,
        '--write-out',
        '%{http_code}',
      ]);
    assert.ok((await curl('/')).stdout.includes('root'));
    assert.equal((await curl('/metrics')).stdout, '404');
    assert.equal((await request('/metrics')).r.status, 403);
    report.tls = 'Internal test CA only; public DNS/CA is not qualified';
  });
  await drill('session-budget-model-and-ingestion', async () => {
    const a = await request('/api/auth/register', {
      email: 'deploy@relay.test',
      name: 'Disposable deployment owner',
      password: 'Disposable-password-2026',
    });
    workspace = expect(a, 201).workspaceId;
    cookie = a.r.headers.get('set-cookie').split(';')[0];
    expect(
      await request(
        `/api/w/${workspace}/budget`,
        {
          periodId: 'qualification',
          tokenLimit: 100000,
          costLimitMicros: null,
          allowUnknownCost: true,
          maxConcurrent: 8,
          maxReservedTokens: 20000,
        },
        'PUT',
      ),
      200,
    );
    connectionId = expect(
      await request(`/api/w/${workspace}/connections`, {
        name: 'Fixture model',
        provider: 'openai-compatible',
        endpoint: 'http://qualification-model:4320/v1',
        model: 'fixture',
        secret: 'synthetic-deployment-credential',
        config: { inputPrice: 1, outputPrice: 2 },
      }),
      201,
    ).id;
    expect(await request(`/api/w/${workspace}/connections/${connectionId}/test`, {}), 200);
    workflowId = expect(
      await request(`/api/w/${workspace}/workflows`, {
        name: 'Actual deployment run',
        graph: graph('agent', { connectionId, maxTokens: 64 }),
      }),
      201,
    ).id;
    runId = expect(
      await request(`/api/w/${workspace}/workflows/${workflowId}/runs`, {
        input: 'Protocol question',
        mode: 'live',
      }),
      202,
    ).id;
    const done = await until(async () => {
      const d = (await request(`/api/w/${workspace}/runs/${runId}`)).data;
      return ['completed', 'failed'].includes(d.status) && d;
    });
    assert.equal(done.status, 'completed', done.error);
    assert.equal(done.usage.tokens, 28);
    assert.equal(done.usage.reservedTokens, 0);
    collectionId = expect(
      await request(`/api/w/${workspace}/collections`, {
        name: 'Deployment documents',
        config: {},
      }),
      201,
    ).id;
    // Upload through S3 and the isolated parser rather than exercising only inline text.
    const form = new FormData();
    form.set(
      'file',
      new Blob(['The approved travel limit is 180 CAD.'], { type: 'text/markdown' }),
      'travel.md',
    );
    const u = await fetch(`${api}/api/w/${workspace}/collections/${collectionId}/upload`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    const data = await u.json();
    assert.equal(u.status, 201, JSON.stringify(data));
    sourceId = data.id;
    await until(async () => {
      const job = (await request(`/api/w/${workspace}/knowledge/jobs/${data.jobId}`)).data;
      if (job.state === 'failed') throw new Error(JSON.stringify(job.error));
      return job.state === 'completed';
    }, 120000);
    const found = expect(
      await request(`/api/w/${workspace}/collections/${collectionId}/search`, {
        query: 'approved travel limit',
        mode: 'hybrid',
      }),
      200,
    );
    assert.ok(found.evidence.length);
    assert.equal(found.evidence[0].citation.sourceId, sourceId);
  });
  await drill('isolated-binary-document-ingestion', async () => {
    for (const ext of ['pdf', 'docx']) {
      const form = new FormData();
      form.set(
        'file',
        new Blob([await fs.readFile(`tests/fixtures/knowledge.${ext}`)]),
        `knowledge.${ext}`,
      );
      const u = await fetch(`${api}/api/w/${workspace}/collections/${collectionId}/upload`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie },
        body: form,
      });
      const d = await u.json();
      assert.equal(u.status, 201, JSON.stringify(d));
      await until(async () => {
        const j = (await request(`/api/w/${workspace}/knowledge/jobs/${d.jobId}`)).data;
        if (j.state === 'failed') throw new Error(JSON.stringify(j.error));
        return j.state === 'completed';
      }, 120000);
    }
    const found = expect(
      await request(`/api/w/${workspace}/collections/${collectionId}/search`, {
        query: 'Orion',
        mode: 'hybrid',
      }),
      200,
    );
    assert.ok(found.evidence.some((v) => v.citation.text.includes('Orion')));
  });
  await drill('uncertain-write-kill-and-recovery-no-replay', async () => {
    const base = `/api/w/${workspace}`;
    const tool = expect(
      await request(base + '/tools', {
        name: 'Crash after external acceptance',
        kind: 'http',
        config: { url: 'http://qualification-model:4320/action-slow', method: 'POST' },
      }),
      201,
    );
    const w = expect(
      await request(base + '/workflows', {
        name: 'Write recovery',
        graph: graph('tool', { toolId: tool.id }),
      }),
      201,
    );
    const id = expect(
      await request(base + `/workflows/${w.id}/runs`, {
        input: { qualification: true },
        mode: 'live',
      }),
      202,
    ).id;
    const approval = await until(async () => {
      const d = (await request(base + `/runs/${id}`)).data;
      return d.approvals?.[0];
    });
    expect(
      await request(base + `/approvals/${approval.id}/decision`, {
        approved: true,
        argumentHash: approval.argumentHash || approval.argument_hash,
      }),
      200,
    );
    const count = () =>
      compose(
        'exec',
        '-T',
        'qualification-model',
        'node',
        '--input-type=module',
        '-e',
        "console.log(JSON.stringify(await(await fetch('http://127.0.0.1:4320/actions')).json()))",
      );
    await until(async () => JSON.parse((await count()).stdout).count === 1);
    await compose('kill', '-s', 'SIGKILL', 'worker');
    await compose('up', '-d', '--wait', '--scale', 'worker=2', 'worker');
    await until(async () => {
      const a = (await request(base + `/runs/${id}/actions`)).data;
      return a.some((v) => v.status === 'uncertain');
    });
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(JSON.parse((await count()).stdout).count, 1);
    expect(await request(base + `/runs/${id}/cancel`, {}), 200);
  });
  await drill('measured-actual-api-and-retrieval-workload', async () => {
    const cookies = [];
    for (let i = 0; i < 8; i++) {
      const email = `load-${i}@relay.test`;
      const u = expect(
        await request('/api/auth/register', {
          name: `Load ${i}`,
          email,
          password: 'Disposable-load-2026',
        }),
        201,
      );
      const login = await request('/api/auth/login', { email, password: 'Disposable-load-2026' });
      expect(login, 200);
      const c = login.r.headers.get('set-cookie').split(';')[0];
      secrets.push(c);
      const invitation = expect(
        await request(`/api/w/${workspace}/invitations`, { email, role: 'viewer' }),
        201,
      );
      secrets.push(invitation.token);
      expect(
        await request('/api/invitations/accept', { token: invitation.token }, undefined, c),
        200,
      );
      cookies.push(c);
    }
    const token = (await fs.readFile(path.join(root, 'secrets', 'metrics_token'), 'utf8')).trim();
    const memBytes = (v) => {
      const m = v.match(/([\d.]+)([KMGT]?i?B)/);
      if (!m) throw new Error('Unknown Docker memory unit');
      return (
        Number(m[1]) *
        ({ B: 1, kB: 1000, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824 }[m[2]] ||
          NaN)
      );
    };
    async function sampleResources() {
      const ids = (await compose('ps', '-q', 'api', 'worker')).stdout.trim().split(/\s+/);
      const rows = (
        await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids])
      ).stdout
        .trim()
        .split('\n')
        .map((v) => JSON.parse(v));
      const metrics = await (
        await fetch(api + '/metrics', { headers: { Authorization: 'Bearer ' + token } })
      ).text();
      const m = metrics.match(/^relay_queue_waiting ([\d.]+)/m);
      return {
        memoryBytes: Object.fromEntries(rows.map((v) => [v.Name, memBytes(v.MemUsage)])),
        queueWaiting: m ? Number(m[1]) : null,
      };
    }
    report.workload = await measureProductionWorkload({
      request,
      base: `/api/w/${workspace}`,
      collectionId,
      cookies,
      durationSeconds: env.PRODUCTION_SOAK === 'true' ? 3600 : 120,
      sampleResources,
      progress: (v) => console.log(JSON.stringify({ workloadProgress: v })),
    });
    await fs.writeFile(
      path.join(results, 'workload.json'),
      JSON.stringify(report.workload, null, 2),
    );
    assert.ok(report.workload.passed, JSON.stringify({ ...report.workload, resources: undefined }));
  });
  await drill('actual-production-browser-journeys', async () => {
    report.browser = await verifyProductionBrowser({ results, workflowId });
  });
  await drill('five-deployed-business-examples', async () => {
    report.business = await verifyProductionBusiness({
      request,
      base: `/api/w/${workspace}`,
      collectionId,
      connectionId,
      until,
      applicationRequest: async (path, body, token) => {
        secrets.push(token);
        const r = await fetch(api + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15000),
        });
        return { r, data: await r.json() };
      },
    });
  });
  for (const dependency of ['database', 'queue', 'storage'])
    await drill(dependency + '-readiness-and-recovery', async () => {
      await compose('stop', dependency);
      assert.equal((await request('/health/ready')).r.status, 503);
      assert.equal((await request('/health/live')).r.status, 200);
      await compose('start', dependency);
      await ready();
    });
  await drill('worker-loss-persistent-dispatch', async () => {
    await compose('kill', '-s', 'SIGKILL', 'worker');
    await compose('stop', 'worker');
    const id = expect(
      await request(`/api/w/${workspace}/workflows/${workflowId}/runs`, {
        input: 'Recover notification',
        mode: 'live',
      }),
      202,
    ).id;
    await compose('up', '-d', '--wait', '--scale', 'worker=2', 'worker');
    const done = await until(async () => {
      const d = (await request(`/api/w/${workspace}/runs/${id}`)).data;
      return ['completed', 'failed'].includes(d.status) && d;
    });
    assert.equal(done.status, 'completed', done.error);
  });
  await drill('quiesce-backup-restore-and-regrant', async () => {
    const start = Date.now();
    await compose('stop', 'api', 'worker');
    const created = await compose('run', '--rm', 'backup', 'create', 'integrated.relay-backup');
    report.backup = JSON.parse(created.stdout.trim());
    assert.ok(report.backup.objects > 0);
    await compose('run', '--rm', 'backup', 'verify', 'integrated.relay-backup');
    const archive = await fs.readFile(path.join(root, 'backups', 'integrated.relay-backup'));
    assert.ok(!archive.includes(Buffer.from('synthetic-deployment-credential')));
    await compose('exec', '-T', 'database', 'createdb', '-U', 'relay_owner', 'relay_restore');
    // A fresh, empty object target is mandatory for restore; leave original bucket untouched.
    await compose(
      'run',
      '--rm',
      '--no-deps',
      'api',
      'node',
      '--input-type=module',
      '-e',
      "import fs from 'node:fs';import {createS3} from './server/observability/s3.js';await createS3({endpoint:process.env.S3_ENDPOINT,bucket:'relay-restore',accessKey:fs.readFileSync('/run/secrets/s3_access_key','utf8').trim(),secretKey:fs.readFileSync('/run/secrets/s3_secret_key','utf8').trim()}).createBucket();",
    );
    report.restore = JSON.parse(
      (
        await compose(
          'run',
          '--rm',
          '-e',
          'PGDATABASE=relay_restore',
          '-e',
          'S3_BUCKET=relay-restore',
          '-e',
          'RESTORE_ALLOW_EMPTY_TARGET=true',
          'backup',
          'restore',
          'integrated.relay-backup',
        )
      ).stdout.trim(),
    );
    await compose('run', '--rm', '-e', 'PGDATABASE=relay_restore', 'migrate');
    for (const f of [
      'app_database_url',
      'identity_database_url',
      'rate_database_url',
      'dispatch_database_url',
    ]) {
      const file = path.join(root, 'secrets', f),
        u = new URL((await fs.readFile(file, 'utf8')).trim());
      u.pathname = '/relay_restore';
      await fs.chmod(file, 0o600);
      await fs.writeFile(file, u.href);
      await fs.chmod(file, 0o444);
      secrets.push(u.href);
    }
    const restoreConfig = path.join(root, 'restore.yaml');
    await fs.writeFile(
      restoreConfig,
      'services:\n  api:\n    environment: { S3_BUCKET: relay-restore }\n  worker:\n    environment: { S3_BUCKET: relay-restore }\n',
    );
    base.push('-f', restoreConfig);
    await compose(
      'up',
      '-d',
      '--wait',
      '--force-recreate',
      '--scale',
      'api=2',
      '--scale',
      'worker=2',
      'api',
      'worker',
    );
    await refreshApis();
    await ready();
    expect(await request('/api/me'), 200); // Restored sessions and memberships, not a newly seeded account.
    const run = expect(await request(`/api/w/${workspace}/runs/${runId}`), 200);
    assert.equal(run.status, 'completed');
    expect(await request(`/api/w/${workspace}/connections/${connectionId}/test`, {}), 200); // Decrypt and invoke restored credential.
    const found = expect(
      await request(`/api/w/${workspace}/collections/${collectionId}/search`, {
        query: 'approved travel limit',
        mode: 'hybrid',
      }),
      200,
    );
    assert.equal(found.evidence[0].citation.sourceId, sourceId);
    report.recoveryTimeMs = Date.now() - start;
    report.recoveryScope =
      'One-host quiesced database, identity, credential, vectors and S3 backup; no off-host copy or two-host failover claim';
  });
  await drill('prior-code-rollback-on-migrated-database', async () => {
    const prior = '555a53ccd9d03a28cf7ecb91f1f209b21dbec154';
    await run('git', ['fetch', '--depth=1', 'origin', prior]);
    const directory = path.join(root, 'prior-code');
    await fs.mkdir(directory);
    const archive = path.join(root, 'prior-code.tar');
    await run('git', ['archive', '--format=tar', '--output', archive, prior]);
    await run('tar', ['-xf', archive, '-C', directory]);
    // Rebuild prior application code on the current hardened runtime base, since
    // the original prior database image has known vulnerabilities. Record both.
    await fs.copyFile('deploy/Dockerfile', path.join(directory, 'deploy/Dockerfile'));
    const image = project + '-prior';
    await run('docker', [
      'build',
      '-f',
      path.join(directory, 'deploy/Dockerfile'),
      '-t',
      image,
      '--label',
      `org.opencontainers.image.revision=${prior}`,
      directory,
    ]);
    const candidate = (
      await run('docker', ['image', 'inspect', 'relay-operations:local', '--format', '{{.Id}}'])
    ).stdout.trim();
    const previous = (
      await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])
    ).stdout.trim();
    assert.notEqual(candidate, previous);
    async function switchTo(name) {
      env.RELAY_IMAGE = name;
      await compose(
        'up',
        '-d',
        '--wait',
        '--force-recreate',
        '--scale',
        'api=2',
        '--scale',
        'worker=2',
        'api',
        'worker',
      );
      await refreshApis();
      await ready();
    }
    try {
      await switchTo(image);
      expect(await request('/api/me'), 200);
      expect(await request(`/api/w/${workspace}/connections/${connectionId}/test`, {}), 200);
      const id = expect(
        await request(`/api/w/${workspace}/workflows/${workflowId}/runs`, {
          input: 'Rollback compatibility',
          mode: 'live',
        }),
        202,
      ).id;
      const done = await until(async () => {
        const r = (await request(`/api/w/${workspace}/runs/${id}`)).data;
        return ['completed', 'failed'].includes(r.status) && r;
      });
      assert.equal(done.status, 'completed', done.error);
    } finally {
      await switchTo('relay-operations:local');
    }
    report.rollback = {
      priorCodeCommit: prior,
      priorImage: previous,
      candidateImage: candidate,
      currentSchema: true,
      scope:
        'Prior application code rebuilt on current hardened base, one-host restored test database. Reversing migrations and physical cross-libc database upgrades is unsupported.',
    };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = sanitize(error.message);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(results, 'report.json'), JSON.stringify(report, null, 2));
  try {
    const logs = await compose('logs', '--no-color');
    await fs.writeFile(path.join(results, 'container-logs.txt'), sanitize(logs.stdout));
  } catch {}
  await run('docker', [...base, 'down', '--volumes', '--remove-orphans'], {
    allowFailure: true,
  }).catch(() => {});
  // root is a mkdtemp-owned disposable directory, never a user's workspace/data path.
  await fs.rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, report: path.join(results, 'report.json') }));
}
