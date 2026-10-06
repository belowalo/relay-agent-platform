import express from 'express';
import pg from 'pg';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { loadConfig } from '../../server/foundation/config.js';
import { createPostgresDatabase } from '../../server/foundation/database.js';
import { createSecretVault } from '../../server/foundation/secrets.js';
import { createS3 } from '../../server/observability/s3.js';
import { createTelemetry, otlpExporter } from '../../server/observability/telemetry.js';
import {
  createHealth,
  registerOperations,
  requestTelemetry,
  installShutdown,
} from '../../server/observability/health.js';
if (process.env.OPERATIONS_QUALIFICATION !== 'true') throw new Error('Qualification only');
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 1500 });
pool.on('error', () => {});
const db = createPostgresDatabase(config, { pool });
const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: () => 500,
});
redis.on('error', () => {});
const queue = new Queue('jobs', { connection: redis, prefix: config.queuePrefix });
const storage = createS3({
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  accessKey: process.env.S3_ACCESS_KEY_ID,
  secretKey: process.env.S3_SECRET_ACCESS_KEY,
});
const vault = createSecretVault({ primary: config.encryptionKey }, 'primary');
const service = 'relay-' + config.role;
const telemetry = createTelemetry({
  service,
  exporter: otlpExporter(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, service),
});
const tenant = {
  workspaceId: 'qualification',
  actor: { kind: 'service', id: 'operator' },
  requestId: 'qualification',
};
const health = createHealth({
  integrated: true,
  probes: {
    database: async () => {
      await db.assertApplicationRole();
      return db.probe();
    },
    schema: async () => {
      const value = await pool.query(
        "SELECT checksum FROM relay.schema_migrations WHERE name='0001-foundation.sql'",
      );
      return value.rowCount === 1;
    },
    queue: async () => (await redis.ping()) === 'PONG',
    storage: () => storage.probe(),
  },
});
let worker;
let heartbeat = Date.now();
if (config.role === 'worker') {
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', () => {});
  worker = new Worker(
    'jobs',
    async (entry) => {
      const row = await db.transaction(tenant, (session) =>
        session.one('SELECT traceparent FROM relay.operations_fixture WHERE id=$1', [
          entry.data.resourceId,
        ]),
      );
      try {
        return await telemetry.job(entry.data, row?.traceparent, async () => {
          await telemetry.span('provider', {}, async () => {});
          await telemetry.span('tool', {}, async () => {});
          await telemetry.span('retrieval', {}, () =>
            db.transaction(tenant, (session) =>
              session.one(
                'SELECT embedding <=> embedding AS distance FROM relay.operations_fixture WHERE id=$1',
                [entry.data.resourceId],
              ),
            ),
          );
          await db.transaction(tenant, (session) =>
            session.query("UPDATE relay.operations_fixture SET state='completed' WHERE id=$1", [
              entry.data.resourceId,
            ]),
          );
          return { id: entry.data.id };
        });
      } catch {
        throw new Error('Qualification job failed.');
      }
    },
    { connection, prefix: config.queuePrefix },
  );
  worker.on('error', () => telemetry.log('worker_error', { code: 'DEPENDENCY_UNAVAILABLE' }));
  worker.relayConnection = connection;
}
const app = express();
app.use(requestTelemetry(telemetry));
app.use(express.json({ limit: '16kb' }));
registerOperations(app, { health, telemetry, metricsToken: process.env.METRICS_TOKEN });
app.get('/ops/ping', (_req, res) => res.json({ qualificationOnly: true, role: config.role }));
app.post('/ops/seed', async (_req, res) => {
  const ref = { workspaceId: 'qualification', connectionId: 'fixture', version: 1 };
  const secret = vault.seal(ref, 'synthetic-credential-for-restoration');
  await storage.put('qualification/blob-1', Buffer.from('synthetic document contents'));
  await db.transaction(tenant, (session) =>
    session.query(
      "INSERT INTO relay.operations_fixture(id,workspace_id,secret,embedding,state,traceparent) VALUES('fixture','qualification',$1,'[1,0,0]','queued',$2) ON CONFLICT(id) DO NOTHING",
      [secret, telemetry.headers().traceparent],
    ),
  );
  res.json({ seeded: true });
});
app.post('/ops/enqueue', async (req, res) => {
  const job = {
    version: 1,
    id: crypto.randomUUID(),
    workspaceId: 'qualification',
    kind: 'workflow.run',
    resourceId: 'fixture',
    requestId: req.requestId,
  };
  await queue.add(job.kind, job, { jobId: job.id, attempts: 1 });
  res.status(202).json({ id: job.id });
});
app.get('/ops/verify', async (_req, res) => {
  const row = await db.transaction(tenant, (session) =>
    session.one(
      "SELECT secret,embedding::text,state FROM relay.operations_fixture WHERE id='fixture'",
    ),
  );
  const keyring = process.env.RESTORED_KEYRING_FILE
    ? JSON.parse(await fs.readFile(process.env.RESTORED_KEYRING_FILE, 'utf8'))
    : { primary: config.encryptionKey };
  const restoredVault = createSecretVault(keyring, 'primary');
  const decrypted = restoredVault.open(
    tenant,
    { workspaceId: 'qualification', connectionId: 'fixture', version: 1 },
    row.secret,
  );
  res.json({
    credentialDecrypted: decrypted === 'synthetic-credential-for-restoration',
    vectorRestored: row.embedding === '[1,0,0]',
    blobRestored:
      (await storage.get('qualification/blob-1')).toString() === 'synthetic document contents',
    state: row.state,
  });
});
app.post('/ops/fault/:kind', async (req, res) => {
  const kind = req.params.kind;
  if (!['provider', 'quota', 'disk'].includes(kind)) return res.sendStatus(404);
  try {
    await telemetry.span(
      kind === 'disk' ? 'storage' : 'provider',
      { code: kind === 'quota' ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE' },
      async () => {
        if (kind === 'disk') {
          await fs.writeFile('/tmp/disk-fixture', Buffer.alloc(300 * 1024 * 1024));
          return;
        }
        throw new Error('private provider token SHOULD_NEVER_APPEAR');
      },
    );
  } catch {
    telemetry.retry(kind === 'disk' ? 'storage' : 'provider');
    return res.status(kind === 'quota' ? 429 : 503).json({
      error: {
        code: kind === 'quota' ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE',
        requestId: req.requestId,
      },
    });
  }
  res.sendStatus(500);
});
app.use((_error, req, res, _next) => {
  telemetry.log('request_failed', { requestId: req.requestId, code: 'DEPENDENCY_UNAVAILABLE' });
  res.status(503).json({ error: { code: 'DEPENDENCY_UNAVAILABLE', requestId: req.requestId } });
});
const timer = setInterval(async () => {
  try {
    heartbeat = Date.now();
    telemetry.gauge('worker_heartbeat_age_seconds', (Date.now() - heartbeat) / 1000);
    const jobs = await queue.getJobs(['wait'], 0, 0, true);
    telemetry.gauge(
      'queue_age_seconds',
      jobs[0] ? Math.max(0, (Date.now() - jobs[0].timestamp) / 1000) : 0,
    );
    telemetry.gauge('queue_waiting', await queue.getWaitingCount());
    telemetry.gauge('dependency_ready', (await health.ready()).ready ? 1 : 0);
    const disk = await fs.statfs('/tmp');
    telemetry.gauge('disk_free_bytes', disk.bavail * disk.bsize);
  } catch {
    telemetry.gauge('dependency_ready', 0);
  }
}, 1000);
health.start();
const server = app.listen(config.port, config.host);
installShutdown({
  server,
  health,
  telemetry,
  timeoutMs: config.shutdownTimeoutMs,
  stopAccepting: () => worker?.pause(true),
  drain: () => worker?.close(),
  close: async () => {
    clearInterval(timer);
    worker?.relayConnection.disconnect();
    await queue.close();
    redis.disconnect();
    await db.close();
  },
});
telemetry.log('qualification_started', { ready: true });
