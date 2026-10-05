import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import Redis from 'ioredis';
import { loadConfig } from '../server/foundation/config.js';
import { createPostgresDatabase } from '../server/foundation/database.js';
import { applyMigrations, readMigrations } from '../server/foundation/migrations.js';
import { enqueueInTransaction } from '../server/foundation/outbox.js';
import { createJobQueue } from '../server/foundation/queue.js';

const databaseUrl = process.env.FOUNDATION_TEST_DATABASE_URL;
const redisUrl = process.env.FOUNDATION_TEST_REDIS_URL;
const context = (workspaceId) => ({
  workspaceId,
  actor: { kind: 'service', id: 'test-worker' },
  requestId: 'test-request',
});
const job = (workspaceId) => ({
  version: 1,
  id: crypto.randomUUID(),
  workspaceId,
  kind: 'workflow.run',
  resourceId: 'test-run',
  requestId: 'test-request',
});

test(
  'live PostgreSQL: migrations, RLS, rollback, outbox atomicity and pooled context reset',
  { skip: !databaseUrl, timeout: 30000 },
  async () => {
    // Never run migration qualification against an arbitrary application database.
    const url = new URL(databaseUrl);
    assert.match(url.pathname, /^\/relay_foundation_test(?:_[a-zA-Z0-9]+)?$/);
    const admin = new pg.Pool({ connectionString: databaseUrl });
    admin.on('error', () => {});
    const role = 'relay_test_' + crypto.randomBytes(8).toString('hex');
    const password = crypto.randomBytes(24).toString('hex');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-foundation-migrations-'));
    let application;
    let appPool;
    let created = false;
    try {
      await applyMigrations(admin);
      assert.ok(
        (await admin.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]
          ?.extversion,
      );
      assert.deepEqual(await applyMigrations(admin), []);
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      created = true;
      await admin.query(`GRANT USAGE ON SCHEMA relay TO "${role}"`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON relay.job_outbox TO "${role}"`);
      url.username = role;
      url.password = password;
      appPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
      application = createPostgresDatabase(loadConfig({ DATABASE_URL: url.toString() }), {
        pool: appPool,
      });
      await application.assertApplicationRole();
      const adminDatabase = createPostgresDatabase(loadConfig({ DATABASE_URL: databaseUrl }), {
        pool: admin,
      });
      await assert.rejects(adminDatabase.assertApplicationRole(), /must not own/);
      const a = 'workspace_' + crypto.randomUUID();
      const b = 'workspace_' + crypto.randomUUID();
      const first = job(a);
      await application.transaction(context(a), (session) => enqueueInTransaction(session, first));
      await application.transaction(context(a), (session) => enqueueInTransaction(session, first));
      await assert.rejects(
        application.transaction(context(a), (session) =>
          enqueueInTransaction(session, { ...first, resourceId: 'changed' }),
        ),
        /reused/,
      );
      assert.equal(
        (
          await application.transaction(context(a), (session) =>
            session.all('SELECT * FROM relay.job_outbox'),
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await application.transaction(context(b), (session) =>
            session.all('SELECT * FROM relay.job_outbox'),
          )
        ).length,
        0,
      );
      assert.equal((await appPool.query('SELECT * FROM relay.job_outbox')).rows.length, 0);
      const cancelled = job(a);
      await assert.rejects(
        application.transaction(context(a), async (session) => {
          await enqueueInTransaction(session, cancelled);
          throw new Error('rollback-test');
        }),
        /rollback-test/,
      );
      assert.equal(
        await application.transaction(context(a), (session) =>
          session.one('SELECT * FROM relay.job_outbox WHERE id=$1', [cancelled.id]),
        ),
        null,
      );
      await assert.rejects(
        application.transaction(context(a), (session) =>
          session.query(
            'INSERT INTO relay.job_outbox(id,workspace_id,kind,resource_id,request_id) VALUES($1,$2,$3,$4,$5)',
            [crypto.randomUUID(), b, 'workflow.run', 'run', 'request'],
          ),
        ),
        /row-level security/,
      );
      await application.transaction(context(a), (session) =>
        session.query('DELETE FROM relay.job_outbox WHERE id=$1', [first.id]),
      );
      for (const entry of await readMigrations())
        await fs.writeFile(path.join(directory, entry.name), entry.sql);
      await fs.writeFile(
        path.join(directory, '0002-failing-fixture.sql'),
        'CREATE TABLE relay.rollback_probe(id integer); INVALID SQL;',
      );
      await assert.rejects(applyMigrations(admin, directory));
      assert.equal(
        (await admin.query("SELECT to_regclass('relay.rollback_probe') AS name")).rows[0].name,
        null,
      );
      await fs.rm(path.join(directory, '0002-failing-fixture.sql'));
      const firstMigration = (await readMigrations())[0];
      await fs.appendFile(path.join(directory, firstMigration.name), '\n-- checksum changed\n');
      await assert.rejects(applyMigrations(admin, directory), /history does not match/);
    } finally {
      if (application) await application.close();
      if (created) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
      await admin.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'live Redis/BullMQ: reference-only job delivery, duplicate suppression and worker shutdown',
  { skip: !redisUrl, timeout: 30000 },
  async () => {
    const prefix = 'relay_test_' + crypto.randomBytes(8).toString('hex');
    const config = loadConfig({ REDIS_URL: redisUrl, QUEUE_PREFIX: prefix, WORKER_CAPACITY: '2' });
    const queue = createJobQueue(config);
    const cleanup = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    cleanup.on('error', () => {});
    let count = 0;
    let complete;
    const delivered = new Promise((resolve) => {
      complete = resolve;
    });
    try {
      assert.equal(await queue.probe(), true);
      const reference = job('workspace-a');
      const worker = queue.createWorker(async (received) => {
        if (received.resourceId === 'failing-run')
          throw new Error('private-worker-error-must-not-reach-redis');
        count++;
        assert.deepEqual(received, reference);
        complete();
        return { secret: 'private-worker-result-must-not-reach-redis' };
      });
      await queue.publish(reference);
      await queue.publish(reference);
      await Promise.race([
        delivered,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('job delivery timed out')), 10000);
          timer.unref();
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(count, 1);
      await assert.rejects(queue.publish({ ...reference, secret: 'never-publish' }));
      const failureReference = { ...job('workspace-a'), resourceId: 'failing-run' };
      await queue.publish(failureReference);
      const failureKey = `${prefix}:jobs:${failureReference.id}`;
      let failureReason;
      for (let attempt = 0; attempt < 100; attempt++) {
        failureReason = await cleanup.hget(failureKey, 'failedReason');
        if (failureReason) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(failureReason, 'Job execution failed. Inspect authorized run history.');
      assert.ok(!(await cleanup.hget(failureKey, 'stacktrace')).includes('private-worker-error'));
      await worker.close();
      const persistedResult = await cleanup.hget(`${prefix}:jobs:${reference.id}`, 'returnvalue');
      assert.ok(persistedResult && !persistedResult.includes('private-worker-result'));
      assert.deepEqual(JSON.parse(persistedResult), { id: reference.id });
    } finally {
      await queue.close();
      let cursor = '0';
      do {
        const result = await cleanup.scan(cursor, 'MATCH', prefix + ':*', 'COUNT', 100);
        cursor = result[0];
        if (result[1].length) await cleanup.del(...result[1]);
      } while (cursor !== '0');
      cleanup.disconnect();
    }
  },
);
