import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-operations-'));
const project = 'relay-ops-' + crypto.randomBytes(4).toString('hex');
const port = Number(process.env.OPERATIONS_PORT || 18431);
const tlsPort = Number(process.env.OPERATIONS_TLS_PORT || 18443);
const reportDir = path.resolve(process.env.OPERATIONS_RESULTS || 'operations-results');
await fs.mkdir(reportDir, { recursive: true });
const report = {
  releaseCommit: process.env.GITHUB_SHA || 'working-tree',
  qualificationOnly: true,
  runtimeIntegrated: false,
  platform: `${os.platform()}/${os.arch()}`,
  startedAt: new Date().toISOString(),
  drills: [],
};
const env = {
  ...process.env,
  OPERATIONS_PORT: String(port),
  TLS_BIND: '127.0.0.1',
  RELEASE_COMMIT: report.releaseCommit,
};
let secrets = [];
function sanitize(value) {
  for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED]');
  return value;
}
async function run(command, args, { allowFailure = false, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else
        reject(
          new Error(
            sanitize(
              `${command} ${args.join(' ')} failed (${code})\n${stderr.slice(-6000)}\n${stdout.slice(-3000)}`,
            ),
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
  '-f',
  'deploy/qualification/compose.yaml',
];
const compose = (...args) => run('docker', [...base, ...args]);
const url = `http://127.0.0.1:${port}`;
async function request(route, method = 'GET') {
  return fetch(url + route, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: { 'x-request-id': 'recovery-drill' },
  });
}
async function waitReady() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      if ((await request('/health/ready')).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Readiness timeout');
}
async function drill(name, callback) {
  console.log(JSON.stringify({ drill: name, status: 'started' }));
  const started = Date.now();
  await callback();
  report.drills.push({ name, status: 'passed', elapsedMs: Date.now() - started });
  console.log(JSON.stringify(report.drills.at(-1)));
}
try {
  await run('docker', ['info']);
  await run(process.execPath, ['bin/operations-init.mjs', root]);
  for (const file of await fs.readdir(path.join(root, 'secrets')))
    secrets.push((await fs.readFile(path.join(root, 'secrets', file), 'utf8')).trim());
  // Host ports are allocated by the caller, never a shared browser-test port.
  await fs.appendFile(path.join(root, 'production.env'), `\nOPERATIONS_PORT=${port}\n`);
  // Override proxy port with a third Compose file, leaving production default unchanged.
  const override = path.join(root, 'ports.yaml');
  await fs.writeFile(
    override,
    `services:\n  proxy:\n    ports: !override ['127.0.0.1:${tlsPort}:8443']\n`,
  );
  base.push('-f', override);
  await drill('clean-build-and-infrastructure', async () => {
    await compose('build', 'api', 'backup', 'proxy');
    await compose(
      'up',
      '-d',
      '--wait',
      'database',
      'queue',
      'storage',
      'collector',
      'alertmanager',
    );
    await compose('run', '--rm', 'admin');
    await compose(
      'run',
      '--rm',
      '--no-deps',
      'api',
      'node',
      '--input-type=module',
      '-e',
      "import fs from 'node:fs';import {createS3} from './server/observability/s3.js';const s=createS3({endpoint:process.env.S3_ENDPOINT,bucket:process.env.S3_BUCKET,accessKey:fs.readFileSync('/run/secrets/s3_access_key','utf8').trim(),secretKey:fs.readFileSync('/run/secrets/s3_secret_key','utf8').trim()});await s.createBucket();",
    );
    await compose('up', '-d', '--wait', 'api', 'worker', 'prometheus', 'proxy');
    await waitReady();
    const apiId = (await compose('ps', '-q', 'api')).stdout.trim();
    const inspect = JSON.parse((await run('docker', ['inspect', apiId])).stdout)[0];
    assert.equal(inspect.Config.User, '1000:1000');
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.ok(inspect.HostConfig.Memory > 0);
    assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
    report.resources = {
      appMemoryBytes: inspect.HostConfig.Memory,
      appNanoCpus: inspect.HostConfig.NanoCpus,
      appPidsLimit: inspect.HostConfig.PidsLimit,
    };
    const images = (await compose('images', '--format', 'json')).stdout;
    await fs.writeFile(path.join(reportDir, 'images.json'), sanitize(images));
  });
  await drill('startup-rejects-unsafe-settings', async () => {
    const result = await run(
      'docker',
      [...base, 'run', '--rm', '--no-deps', '-e', 'PUBLIC_ORIGIN=http://unsafe.example', 'api'],
      { allowFailure: true },
    );
    assert.notEqual(result.code, 0);
    const real = await run(
      'docker',
      [...base, 'run', '--rm', '--no-deps', 'api', 'node', 'bin/production-entrypoint.mjs'],
      { allowFailure: true },
    );
    assert.notEqual(real.code, 0); // Unintegrated foundation must stay blocked.
  });
  await drill('tls-and-private-exposure', async () => {
    const result = await run('curl', [
      '--silent',
      '--show-error',
      '--insecure',
      '--resolve',
      `relay.example.com:${tlsPort}:127.0.0.1`,
      `https://relay.example.com:${tlsPort}/metrics`,
      '--write-out',
      '%{http_code}',
    ]);
    assert.equal(result.stdout, '404');
    const ping = await run('curl', [
      '--silent',
      '--show-error',
      '--insecure',
      '--resolve',
      `relay.example.com:${tlsPort}:127.0.0.1`,
      `https://relay.example.com:${tlsPort}/`,
      '--write-out',
      '%{http_code}',
    ]);
    assert.ok(ping.stdout.endsWith('404')); // Fixture serves only ops APIs.
    assert.equal((await request('/metrics')).status, 403);
  });
  await drill('job-traces-and-structured-redaction', async () => {
    assert.equal((await request('/ops/seed', 'POST')).status, 200);
    assert.equal((await request('/ops/enqueue', 'POST')).status, 202);
    const deadline = Date.now() + 30000;
    let state;
    do {
      state = await (await request('/ops/verify')).json();
      if (state.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    assert.equal(state.state, 'completed');
    assert.equal(state.credentialDecrypted, true);
    assert.equal(state.vectorRestored, true);
    assert.equal(state.blobRestored, true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const logs = (await compose('logs', '--no-color', 'api', 'worker', 'collector')).stdout;
    assert.ok(!logs.includes('SHOULD_NEVER_APPEAR'));
    assert.match(logs, /relay.provider/);
    assert.match(logs, /relay.retrieval/);
    assert.match(logs, /traceId|Trace ID/);
    const records = logs
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line.slice(line.indexOf('{')))];
        } catch {
          return [];
        }
      })
      .filter((record) => record.event === 'span_completed');
    const job = records.find((record) => record.kind === 'job');
    assert.ok(job);
    for (const kind of ['api', 'provider', 'tool', 'retrieval'])
      assert.ok(records.some((record) => record.kind === kind && record.traceId === job.traceId));
    report.traceCorrelation = { apiJobProviderToolRetrievalSharedTrace: true };
    await fs.writeFile(path.join(reportDir, 'observability.log'), sanitize(logs));
  });
  await drill('provider-outage-and-quota', async () => {
    assert.equal((await request('/ops/fault/provider', 'POST')).status, 503);
    assert.equal((await request('/ops/fault/quota', 'POST')).status, 429);
  });
  await drill('disk-exhaustion', async () => {
    assert.equal((await request('/ops/fault/disk', 'POST')).status, 503);
    await compose(
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      "require('fs').rmSync('/tmp/disk-fixture',{force:true})",
    );
    await waitReady();
  });
  for (const dependency of ['database', 'queue'])
    await drill(dependency + '-outage', async () => {
      await compose('stop', dependency);
      assert.equal((await request('/health/ready')).status, 503);
      assert.equal((await request('/health/live')).status, 200);
      await compose('start', dependency);
      await waitReady();
    });
  await drill('worker-crash-and-stuck-jobs', async () => {
    await compose('kill', '-s', 'SIGKILL', 'worker');
    await compose('stop', 'worker');
    assert.equal((await request('/ops/enqueue', 'POST')).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const token = (await fs.readFile(path.join(root, 'secrets', 'metrics_token'), 'utf8')).trim();
    const metrics = await (
      await fetch(url + '/metrics', { headers: { authorization: `Bearer ${token}` } })
    ).text();
    assert.match(metrics, /relay_queue_age_seconds [1-9]/);
    await fs.writeFile(path.join(reportDir, 'metrics.prom'), metrics);
    await compose('up', '-d', '--wait', 'worker');
    await waitReady();
  });
  await drill('failed-migration', async () => {
    assert.match(
      (
        await compose(
          'run',
          '--rm',
          'admin',
          'node',
          'deploy/qualification/admin.mjs',
          'failed-migration',
        )
      ).stdout,
      /failedMigrationRolledBack/,
    );
  });
  await drill('graceful-drain-and-encrypted-backup', async () => {
    await compose('stop', 'api', 'worker');
    const logs = (await compose('logs', '--no-color', 'api', 'worker')).stdout;
    assert.match(logs, /shutdown_completed/);
    report.backup = JSON.parse(
      (await compose('run', '--rm', 'backup', 'create', 'rehearsal.relay-backup')).stdout.trim(),
    );
    assert.equal(
      JSON.parse(
        (await compose('run', '--rm', 'backup', 'verify', 'rehearsal.relay-backup')).stdout.trim(),
      ).command,
      'verify',
    );
    const data = await fs.readFile(path.join(root, 'backups', 'rehearsal.relay-backup'));
    assert.ok(!data.includes(Buffer.from('synthetic-credential')));
  });
  await drill('credential-compromise-key-dependency', async () => {
    const original = await fs.readFile(path.join(root, 'secrets', 'backup_key'));
    await fs.chmod(path.join(root, 'secrets', 'backup_key'), 0o600);
    await fs.writeFile(
      path.join(root, 'secrets', 'backup_key'),
      crypto.randomBytes(32).toString('hex'),
    );
    const result = await run(
      'docker',
      [...base, 'run', '--rm', 'backup', 'verify', 'rehearsal.relay-backup'],
      { allowFailure: true },
    );
    assert.notEqual(result.code, 0);
    await fs.writeFile(path.join(root, 'secrets', 'backup_key'), original);
    await fs.chmod(path.join(root, 'secrets', 'backup_key'), 0o444);
  });
  await drill('backup-tamper-rejected', async () => {
    const file = path.join(root, 'backups', 'rehearsal.relay-backup');
    const original = await fs.readFile(file);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 1;
    await fs.writeFile(file, tampered);
    const result = await run(
      'docker',
      [...base, 'run', '--rm', 'backup', 'verify', 'rehearsal.relay-backup'],
      { allowFailure: true },
    );
    assert.notEqual(result.code, 0);
    await fs.writeFile(file, original);
  });
  await drill('restore-empty-database-and-blobs', async () => {
    const started = Date.now();
    await compose('exec', '-T', 'database', 'createdb', '-U', 'relay_owner', 'relay_restore');
    await compose(
      'run',
      '--rm',
      'api',
      'node',
      '--input-type=module',
      '-e',
      "import fs from 'node:fs';import{createS3}from'./server/observability/s3.js';const s=createS3({endpoint:process.env.S3_ENDPOINT,bucket:process.env.S3_BUCKET,accessKey:fs.readFileSync('/run/secrets/s3_access_key','utf8').trim(),secretKey:fs.readFileSync('/run/secrets/s3_secret_key','utf8').trim()});await s.remove('qualification/blob-1');",
    );
    report.restore = JSON.parse(
      (
        await compose(
          'run',
          '--rm',
          '-e',
          'PGDATABASE=relay_restore',
          '-e',
          'RESTORE_ALLOW_EMPTY_TARGET=true',
          'backup',
          'restore',
          'rehearsal.relay-backup',
        )
      ).stdout.trim(),
    );
    await compose(
      'exec',
      '-T',
      'database',
      'psql',
      '-U',
      'relay_owner',
      '-d',
      'relay_restore',
      '-c',
      'GRANT USAGE ON SCHEMA relay TO relay_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA relay TO relay_app;',
    );
    const restoredDatabaseUrl = new URL(
      (await fs.readFile(path.join(root, 'secrets', 'app_database_url'), 'utf8')).trim(),
    );
    restoredDatabaseUrl.pathname = '/relay_restore';
    const appUrl = restoredDatabaseUrl.toString();
    await fs.chmod(path.join(root, 'secrets', 'app_database_url'), 0o600);
    await fs.writeFile(path.join(root, 'secrets', 'app_database_url'), appUrl);
    await fs.chmod(path.join(root, 'secrets', 'app_database_url'), 0o444);
    // Restore vault material from the encrypted archive after deliberately replacing the running key.
    const restoredKeys = JSON.parse(
      await fs.readFile(
        path.join(root, 'backups', 'rehearsal.relay-backup.restored-keyring'),
        'utf8',
      ),
    );
    await fs.chmod(path.join(root, 'secrets', 'encryption_key'), 0o600);
    await fs.writeFile(
      path.join(root, 'secrets', 'encryption_key'),
      crypto.randomBytes(32).toString('hex'),
    );
    await fs.chmod(path.join(root, 'secrets', 'encryption_key'), 0o444);
    await compose('up', '-d', '--wait', '--force-recreate', 'api');
    await waitReady();
    assert.equal((await request('/ops/verify')).status, 503);
    await compose('stop', 'api');
    await fs.chmod(path.join(root, 'secrets', 'encryption_key'), 0o600);
    await fs.writeFile(path.join(root, 'secrets', 'encryption_key'), restoredKeys.primary);
    await fs.chmod(path.join(root, 'secrets', 'encryption_key'), 0o444);
    await compose('up', '-d', '--wait', '--force-recreate', 'api');
    await waitReady();
    report.restoredState = await (await request('/ops/verify')).json();
    assert.equal(report.restoredState.credentialDecrypted, true);
    assert.equal(report.restoredState.vectorRestored, true);
    assert.equal(report.restoredState.blobRestored, true);
    report.recoveryTimeMs = Date.now() - started;
    report.recoveryPoint =
      'Quiesced snapshot; scheduled target <=1h only while every hourly backup succeeds and is copied off-host.';
  });
  await drill('image-rollback', async () => {
    await run('docker', ['tag', 'relay-operations:local', 'relay-operations:rollback']);
    env.RELAY_IMAGE = 'relay-operations:rollback';
    await compose('up', '-d', '--wait', '--force-recreate', 'api');
    await waitReady();
    assert.equal((await (await request('/ops/verify')).json()).credentialDecrypted, true);
    report.rollbackScope =
      'Same tested image identity and compatible restored schema; integrated previous-version rollback remains required.';
  });
  await compose(
    'exec',
    '-T',
    'prometheus',
    'promtool',
    'check',
    'config',
    '/etc/prometheus/prometheus.yml',
  );
  await compose(
    'exec',
    '-T',
    '-w',
    '/etc/prometheus',
    'prometheus',
    'promtool',
    'test',
    'rules',
    '/etc/prometheus/alert-tests.yml',
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = sanitize(error.message);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  try {
    const logs = await compose('logs', '--no-color');
    await fs.writeFile(path.join(reportDir, 'container-logs.txt'), sanitize(logs.stdout));
  } catch {}
  if (process.env.OPERATIONS_KEEP !== 'true') {
    await run('docker', [...base, 'down', '--volumes', '--remove-orphans'], {
      allowFailure: true,
    }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({ status: report.status, report: path.join(reportDir, 'report.json') }),
  );
}
