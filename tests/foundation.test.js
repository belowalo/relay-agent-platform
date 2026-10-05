import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig, configSummary, assertLegacyEntryPoint } from '../server/foundation/config.js';
import { PlatformError, errorEnvelope } from '../server/foundation/errors.js';
import {
  withTenant,
  tenantContext,
  assertWorkspace,
  requestId,
} from '../server/foundation/context.js';
import {
  jobSchema,
  connectorDescriptorSchema,
  citationSchema,
} from '../server/foundation/contracts.js';
import { createSecretVault } from '../server/foundation/secrets.js';
import { createLocalBlobStore } from '../server/foundation/blob-store.js';
import { createPostgresDatabase } from '../server/foundation/database.js';
import { createJobQueue } from '../server/foundation/queue.js';

const context = (workspaceId) => ({
  workspaceId,
  actor: { kind: 'user', id: 'user-1' },
  requestId: 'request-1',
});
const production = {
  RELAY_PROFILE: 'production',
  DATABASE_URL: 'postgres://app:fixture-password@localhost/relay',
  REDIS_URL: 'redis://:fixture-password@localhost:6379/0',
  PUBLIC_ORIGIN: 'https://relay.example.com',
  ENCRYPTION_KEY: 'ab'.repeat(32),
};

test('production configuration is strict, secret-safe, and cannot use the legacy SQLite entry point', () => {
  const local = loadConfig({});
  assert.equal(local.profile, 'local');
  assert.doesNotThrow(() => assertLegacyEntryPoint(local));
  const config = loadConfig(production);
  assert.equal(config.role, 'api');
  assert.throws(() => assertLegacyEntryPoint(config), /legacy SQLite/);
  const summary = JSON.stringify(configSummary(config));
  assert.ok(!summary.includes('fixture-password') && !summary.includes(production.ENCRYPTION_KEY));
  for (const changes of [
    { DATABASE_URL: '' },
    { REDIS_URL: '' },
    { ENCRYPTION_KEY: 'x'.repeat(64) },
    { COOKIE_SECURE: 'false' },
    { ALLOW_PRIVATE_NETWORK: 'true' },
    { ENGINE_ROLE: 'embedded' },
    { PUBLIC_ORIGIN: 'http://relay.example.com' },
    { PUBLIC_ORIGIN: 'https://a.example/path' },
    { DATABASE_URL: 'file:///private/password' },
    { REDIS_URL: 'redis://localhost/not-a-db' },
    { PORT: '4311junk' },
    { WORKER_CAPACITY: '-1' },
    { QUEUE_PREFIX: 'bad:prefix' },
  ]) {
    assert.throws(() => loadConfig({ ...production, ...changes }), PlatformError);
  }
  try {
    loadConfig({ ...production, DATABASE_URL: 'password-secret' });
  } catch (error) {
    assert.ok(!error.message.includes('password-secret'));
  }
});

test('async tenant context stays isolated and caller correlation IDs are constrained', async () => {
  assert.throws(() => tenantContext(), PlatformError);
  const seen = await Promise.all(
    ['a', 'b'].map((workspace) =>
      withTenant(context(workspace), async () => {
        await new Promise((resolve) => setTimeout(resolve, workspace === 'a' ? 10 : 1));
        assertWorkspace(workspace);
        assert.throws(() => assertWorkspace('foreign'), PlatformError);
        return tenantContext().workspaceId;
      }),
    ),
  );
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(requestId('safe-request'), 'safe-request');
  assert.match(requestId('unsafe\nheader'), /^[a-f0-9-]{36}$/);
});

test('vault binds ciphertext to workspace, connection, version and supports key rotation', () => {
  const ref = { workspaceId: 'a', connectionId: 'connection', version: 1 };
  const oldKey = crypto.randomBytes(32).toString('hex');
  const newKey = crypto.randomBytes(32).toString('hex');
  const old = createSecretVault({ old: oldKey }, 'old');
  const sealed = old.seal(ref, 'private-fixture-credential');
  assert.ok(!sealed.includes('private-fixture-credential'));
  assert.equal(old.open(context('a'), ref, sealed), 'private-fixture-credential');
  assert.throws(() => old.open(context('b'), ref, sealed), PlatformError);
  assert.throws(
    () => old.open(context('a'), { ...ref, connectionId: 'different' }, sealed),
    PlatformError,
  );
  assert.throws(() => old.open(context('a'), { ...ref, version: 2 }, sealed), PlatformError);
  const rotated = createSecretVault({ old: oldKey, current: newKey }, 'current');
  assert.equal(rotated.open(context('a'), ref, sealed), 'private-fixture-credential');
  assert.equal(JSON.parse(rotated.seal(ref, 'new')).keyId, 'current');
  assert.throws(() => createSecretVault({ bad: 'invalid' }, 'bad'), PlatformError);
});

test('queue, connector and citation contracts reject ambiguous or secret-bearing payloads', () => {
  const job = {
    version: 1,
    id: crypto.randomUUID(),
    workspaceId: 'a',
    kind: 'workflow.run',
    resourceId: 'run',
    requestId: 'request',
  };
  assert.deepEqual(jobSchema.parse(job), job);
  assert.equal(jobSchema.safeParse({ ...job, secret: 'credential' }).success, false);
  assert.equal(jobSchema.safeParse({ ...job, kind: 'execute-arbitrary-code' }).success, false);
  const descriptor = {
    id: 'github',
    version: '1.0.0',
    auth: 'oauth2',
    actions: [
      { id: 'write', effect: 'write', idempotency: 'provider-key', requiresApproval: true },
    ],
  };
  assert.equal(connectorDescriptorSchema.safeParse(descriptor).success, true);
  assert.equal(
    connectorDescriptorSchema.safeParse({
      ...descriptor,
      actions: [...descriptor.actions, ...descriptor.actions],
    }).success,
    false,
  );
  assert.equal(
    connectorDescriptorSchema.safeParse({
      ...descriptor,
      actions: [{ ...descriptor.actions[0], idempotency: 'read-only' }],
    }).success,
    false,
  );
  assert.equal(
    citationSchema.safeParse({
      workspaceId: 'a',
      collectionId: 'c',
      sourceId: 's',
      sourceVersion: 1,
      chunkId: 'chunk',
      text: 'evidence',
      score: 0.5,
      location: { start: 10, end: 2 },
    }).success,
    false,
  );
});

test('local blob storage isolates workspaces, prevents traversal and refuses overwrite', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-foundation-blobs-'));
  try {
    const store = await createLocalBlobStore(directory, { maximumBytes: 10 });
    const blob = await store.put(context('a'), 'blob-1', Buffer.from('content'), 'text/plain');
    assert.equal(blob.bytes, 7);
    assert.equal((await store.get(context('a'), 'blob-1')).toString(), 'content');
    await assert.rejects(store.get(context('b'), 'blob-1'), PlatformError);
    await assert.rejects(store.get(context('a'), '../escape'), /Invalid/);
    await assert.rejects(
      store.put(context('a'), 'blob-1', Buffer.from('new'), 'text/plain'),
      PlatformError,
    );
    await assert.rejects(
      store.put(context('a'), 'large', Buffer.alloc(11), 'text/plain'),
      PlatformError,
    );
    await store.delete(context('a'), 'blob-1');
    await assert.rejects(store.get(context('a'), 'blob-1'), PlatformError);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('public error envelopes do not expose arbitrary dependency messages', () => {
  const error = new Error('postgres://user:credential@host/private');
  assert.ok(!JSON.stringify(errorEnvelope(error, 'request')).includes('credential'));
  assert.equal(
    errorEnvelope(new PlatformError('RATE_LIMITED', 'Try later.'), 'request').error.code,
    'RATE_LIMITED',
  );
});

test('PostgreSQL transaction failures roll back on the pinned connection and destroy broken clients', async () => {
  const statements = [];
  let released;
  const client = {
    query: async (text) => {
      statements.push(text);
      if (text === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [] };
    },
    release: (error) => {
      released = error;
    },
  };
  const pool = { on() {}, connect: async () => client };
  const database = createPostgresDatabase(loadConfig(production), { pool });
  const failure = new Error('callback failed');
  await assert.rejects(
    database.transaction(context('a'), async () => {
      throw failure;
    }),
    /callback failed/,
  );
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, failure);
});

test(
  'unavailable Redis produces a bounded dependency failure and closes cleanly',
  { timeout: 5000 },
  async () => {
    const portServer = net.createServer();
    await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const queue = createJobQueue(
      loadConfig({ REDIS_URL: `redis://127.0.0.1:${port}/0`, DATABASE_TIMEOUT_MS: '100' }),
    );
    const started = Date.now();
    try {
      await assert.rejects(
        queue.probe(),
        (error) => error instanceof PlatformError && error.code === 'DEPENDENCY_UNAVAILABLE',
      );
      assert.ok(Date.now() - started < 2000);
    } finally {
      await queue.close();
    }
  },
);

test(
  'production server fails closed without adapters before creating a SQLite database or vault',
  { timeout: 10000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-foundation-guard-'));
    try {
      await assert.rejects(
        promisify(execFile)(process.execPath, ['server/index.js'], {
          env: { ...process.env, ...production, DATA_DIR: directory },
          timeout: 5000,
        }),
        (error) => {
          assert.match(error.stderr, /Runtime command failed/);
          assert.ok(!error.stderr.includes('fixture-password'));
          return true;
        },
      );
      assert.deepEqual(await fs.readdir(directory), []);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
