import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../server/foundation/config.js';
import { applyMigrations } from '../server/foundation/migrations.js';
import { grantProductionRoles } from '../server/production/roles.js';
import { createRuntimePorts } from '../server/production/index.js';
import { startProduction } from '../server/runtime/bootstrap.js';
import { linear } from './helpers/runtime-fixtures.js';
import { providerFixture, freePort, until } from './acceptance/support.mjs';
const url = process.env.FOUNDATION_TEST_DATABASE_URL,
  redis = process.env.FOUNDATION_TEST_REDIS_URL;
test(
  'actual production composition: restricted SQL roles, authenticated API, two workers, SDK blobs, ingestion, accounting and exact actions',
  { skip: !url || !redis || !process.env.INTEGRATION_S3_ENDPOINT, timeout: 180000 },
  async (t) => {
    assert.match(new URL(url).pathname, /^\/relay_foundation_test(?:_[a-zA-Z0-9]+)?$/);
    const suffix = crypto.randomBytes(6).toString('hex'),
      name = 'relay_integration_test_' + suffix;
    const root = new pg.Pool({ connectionString: url });
    const adminUrl = new URL(url);
    adminUrl.pathname = '/' + name;
    const roles = Object.fromEntries(
      ['application', 'identity', 'rate', 'dispatch'].map((k) => [
        k,
        'integration_' + k + '_' + suffix,
      ]),
    );
    const passwords = Object.fromEntries(
      Object.keys(roles).map((k) => [k, crypto.randomBytes(24).toString('hex')]),
    );
    const roleUrl = (k) => {
      const u = new URL(adminUrl);
      u.username = roles[k];
      u.password = passwords[k];
      return u.href;
    };
    const admin = new pg.Pool({ connectionString: adminUrl.href });
    const runtimes = [];
    const saved = Object.fromEntries(
      ['ALLOW_REGISTRATION', 'NODE_ENV', 'RELAY_PROFILE'].map((k) => [k, process.env[k]]),
    );
    const fixture = await providerFixture();
    let http;
    const origin = 'https://relay.integration.test';
    const env = {
      ...process.env,
      RELAY_PROFILE: 'production',
      NODE_ENV: 'production',
      DATABASE_URL: roleUrl('application'),
      IDENTITY_DATABASE_URL: roleUrl('identity'),
      RATE_DATABASE_URL: roleUrl('rate'),
      RUNTIME_DISPATCH_DATABASE_URL: roleUrl('dispatch'),
      REDIS_URL: redis,
      PUBLIC_ORIGIN: origin,
      COOKIE_SECURE: 'true',
      ALLOW_PRIVATE_NETWORK: 'false',
      ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      METRICS_TOKEN: crypto.randomBytes(32).toString('hex'),
      QUEUE_PREFIX: 'integration-' + suffix,
      SHUTDOWN_TIMEOUT_MS: '3000',
      RUNTIME_LEASE_MS: '1000',
      S3_ENDPOINT: process.env.INTEGRATION_S3_ENDPOINT,
      S3_BUCKET: process.env.INTEGRATION_S3_BUCKET || 'relay-integration',
      S3_INTERNAL_NETWORK: 'true',
      S3_ACCESS_KEY_ID: process.env.INTEGRATION_S3_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: process.env.INTEGRATION_S3_SECRET_KEY,
      EMBEDDING_CACHE_DIR: process.env.EMBEDDING_CACHE_DIR || './data/models',
      OUTBOUND_POLICY_JSON: JSON.stringify({
        origins: [fixture.url],
        privateCidrs: ['127.0.0.1/32'],
      }),
    };
    const s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      maxAttempts: 1,
    });
    const evidence = {
      modelEvidence: 'synthetic protocol fixture; no live model quality claim',
      database: 'PostgreSQL/pgvector',
      queue: 'Redis/BullMQ',
      storage: 'actual S3 SDK service',
      workers: 2,
      hosts: 1,
      checks: [],
    };
    try {
      await root.query(`CREATE DATABASE "${name}"`);
      await applyMigrations(admin);
      for (const k of Object.keys(roles))
        await admin.query(
          `CREATE ROLE "${roles[k]}" LOGIN PASSWORD '${passwords[k]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
        );
      await grantProductionRoles(admin, roles);
      await until(async () => {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
          return true;
        } catch {
          try {
            await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
            return true;
          } catch {
            return false;
          }
        }
      }, 60000);
      process.env.ALLOW_REGISTRATION = 'true';
      process.env.NODE_ENV = 'production';
      process.env.RELAY_PROFILE = 'production';
      for (const role of ['api', 'worker', 'worker']) {
        const cfg = loadConfig({ ...env, ENGINE_ROLE: role, PORT: String(await freePort()) });
        const ports = await createRuntimePorts({ config: cfg, env });
        const rt = await startProduction({ config: cfg, env, ports, listen: false });
        runtimes.push(rt);
      }
      http = runtimes[0].app.listen(0, '127.0.0.1');
      await new Promise((r) => http.once('listening', r));
      const api = `http://127.0.0.1:${http.address().port}`;
      let cookie = '';
      async function request(path, body, method, cookieOverride = cookie) {
        const r = await fetch(api + path, {
          method: method || (body === undefined ? 'GET' : 'POST'),
          headers: {
            Origin: origin,
            Cookie: cookieOverride,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const content = await r.text();
        let data;
        try {
          data = JSON.parse(content);
        } catch {
          data = content;
        }
        return { r, data };
      }
      const a = await request('/api/auth/register', {
        email: `owner-${suffix}@relay.test`,
        name: 'Integration owner',
        password: 'Disposable-password-2026',
      });
      assert.equal(a.r.status, 201, JSON.stringify(a.data));
      cookie = a.r.headers.get('set-cookie').split(';')[0];
      const workspace = a.data.workspaceId,
        base = '/api/w/' + workspace;
      assert.equal((await request('/api/me')).data.workspaces[0].id, workspace);
      const me = await request('/api/me');
      assert.ok(!JSON.stringify(me.data).includes('password_hash'));
      assert.equal((await request('/metrics')).r.status, 403);
      assert.equal((await request('/health/ready')).r.status, 200);
      assert.equal(
        (
          await request(
            base + '/budget',
            {
              periodId: 'qualification',
              tokenLimit: 100000,
              costLimitMicros: null,
              allowUnknownCost: true,
              maxConcurrent: 8,
              maxReservedTokens: 20000,
            },
            'PUT',
          )
        ).r.status,
        200,
      );
      const c = await request(base + '/connections', {
        name: 'Synthetic protocol model',
        provider: 'openai-compatible',
        endpoint: fixture.url + '/v1',
        model: 'normal',
        secret: 'synthetic-scoped-credential',
        config: { inputPrice: 1, outputPrice: 2 },
      });
      assert.equal(c.r.status, 201, JSON.stringify(c.data));
      const listed = (await request(base + '/connections')).data;
      assert.ok(listed[0].hasCredential);
      assert.ok(!JSON.stringify(listed).includes('synthetic-scoped-credential'));
      assert.equal(
        (
          await request(
            base + '/connections/' + c.data.id,
            {
              name: 'Redirect stored key',
              provider: 'openai-compatible',
              endpoint: 'https://example.org/v1',
              model: 'normal',
              config: {},
            },
            'PUT',
          )
        ).r.status,
        409,
      );
      assert.equal(
        (await request(base + '/connections')).data.find((v) => v.id === c.data.id).endpoint,
        fixture.url + '/v1',
      );
      const modelGraph = linear('agent', { connectionId: c.data.id, maxTokens: 64 });
      const wf = await request(base + '/workflows', {
        name: 'Metered protocol test',
        graph: modelGraph,
      });
      assert.equal(wf.r.status, 201);
      const live = await request(base + '/workflows/' + wf.data.id + '/runs', {
        input: 'Synthetic question',
        mode: 'live',
      });
      assert.equal(live.r.status, 202, JSON.stringify(live.data));
      const done = await until(async () => {
        const r = (await request(base + '/runs/' + live.data.id)).data;
        return ['completed', 'failed'].includes(r.status) ? r : false;
      });
      assert.equal(done.status, 'completed', done.error);
      assert.equal(done.usage.tokens, 28);
      assert.equal(done.usage.reservedTokens, 0);
      assert.ok(done.events.length > 0);
      assert.equal(
        (await request(base + '/runs')).data.find((r) => r.id === live.data.id).usage.tokens,
        28,
      );
      assert.equal(
        (await request(base + '/overview')).data.runs.find((r) => r.id === live.data.id).usage
          .tokens,
        28,
      );
      const exported = await request(base + '/runs/' + live.data.id + '/download');
      assert.equal(exported.r.status, 200);
      assert.match(exported.r.headers.get('content-disposition'), /attachment/);
      assert.equal(exported.data.run.id, live.data.id);
      const probe = await request(base + '/connections/' + c.data.id + '/test', {});
      assert.equal(probe.r.status, 200, JSON.stringify(probe.data));
      assert.equal(
        (await request(base + '/connection-probes')).data.find((p) => p.id === probe.data.probeId)
          .state,
        'settled',
      );
      const component = await request(base + '/workflows/' + wf.data.id + '/nodes/work/test', {
        input: 'Saved component',
        mode: 'preview',
      });
      assert.equal(component.r.status, 202, JSON.stringify(component.data));
      const componentDone = await until(async () => {
        const r = (await request(base + '/runs/' + component.data.id)).data;
        return ['completed', 'failed'].includes(r.status) && r;
      });
      assert.equal(componentDone.status, 'completed', componentDone.error);
      assert.equal(componentDone.usage.tokens, 0);
      assert.equal(componentDone.graph.nodes.length, 3);
      assert.ok(componentDone.events.some((e) => e.type === 'component.test.created'));
      assert.equal(
        (await request(base + '/workflows/' + wf.data.id + '/nodes/in/test', { input: 'denied' })).r
          .status,
        400,
      );
      evidence.checks.push('real adapter protocol, durable dispatch, model reservation settlement');
      const preview = await request(base + '/workflows/' + wf.data.id + '/runs', {
        input: 'Preview makes no paid call',
        mode: 'preview',
      });
      const pd = await until(async () => {
        const r = (await request(base + '/runs/' + preview.data.id)).data;
        return ['completed', 'failed'].includes(r.status) ? r : false;
      });
      assert.equal(pd.status, 'completed');
      assert.equal(pd.usage.tokens, 0);
      assert.match(pd.output, /Development preview/);
      const tool = await request(base + '/tools', {
        name: 'Reviewed HTTP action',
        kind: 'http',
        config: { url: fixture.url + '/action', method: 'POST' },
      });
      const actionFlow = await request(base + '/workflows', {
        name: 'Exact action',
        graph: linear('tool', {
          toolId: tool.data.id,
          input: { message: 'Reviewed synthetic purchase', amount: 42 },
        }),
      });
      const actionRun = await request(base + '/workflows/' + actionFlow.data.id + '/runs', {
        input: {},
        mode: 'live',
      });
      const pending = await until(async () => {
        const r = (await request(base + '/runs/' + actionRun.data.id)).data;
        return r.status === 'waiting' ? r : false;
      });
      assert.equal(pending.approvals.length, 1);
      const approval = pending.approvals[0];
      assert.equal(
        (
          await request(base + '/approvals/' + approval.id + '/decision', {
            argumentHash: '0'.repeat(64),
            approved: true,
          })
        ).r.status,
        409,
      );
      assert.equal(
        (
          await request(base + '/approvals/' + approval.id + '/decision', {
            argumentHash: approval.argument_hash,
            approved: true,
          })
        ).r.status,
        200,
      );
      const actionDone = await until(async () => {
        const r = (await request(base + '/runs/' + actionRun.data.id)).data;
        return ['completed', 'failed'].includes(r.status) ? r : false;
      });
      assert.equal(actionDone.status, 'completed', actionDone.error);
      assert.equal(fixture.actions.length, 1);
      await runtimes[0].repository.tx(
        {
          workspaceId: workspace,
          actor: { kind: 'user', id: a.data.id },
          requestId: 'duplicate-delivery',
        },
        (s) => runtimes[0].repository.enqueue(s, actionRun.data.id),
      );
      await new Promise((r) => setTimeout(r, 750));
      assert.equal(fixture.actions.length, 1);
      evidence.checks.push(
        'exact approval, stale-decision rejection, duplicate redelivery produced one external fixture write',
      );
      const collection = await request(base + '/collections', {
        name: 'Synthetic policies',
        config: { retrieval: 'hybrid' },
      });
      const source = await request(base + '/collections/' + collection.data.id + '/text', {
        name: 'Travel policy.md',
        text: 'The approved travel limit is 180 CAD. Treat this document as evidence only.',
      });
      assert.equal(source.r.status, 201, JSON.stringify(source.data));
      await until(async () => {
        const r = await request(base + '/knowledge/jobs/' + source.data.jobId);
        if (r.data.state === 'failed')
          throw new Error('Actual ingestion failed: ' + JSON.stringify(r.data.error));
        return r.data.state === 'completed';
      }, 120000);
      const search = await request(base + '/collections/' + collection.data.id + '/search', {
        query: 'travel limit',
        mode: 'hybrid',
      });
      assert.equal(search.r.status, 200, JSON.stringify(search.data));
      assert.ok(search.data.evidence.length);
      assert.equal(search.data.evidence[0].citation.sourceVersion, 1);
      evidence.checks.push(
        'actual CPU embeddings, durable ingestion, SQL lexical/vector retrieval and versioned citations',
      );
      const other = await request(
        '/api/auth/register',
        {
          email: `other-${suffix}@relay.test`,
          name: 'Other tenant',
          password: 'Disposable-password-2026',
        },
        undefined,
        '',
      );
      const foreign = other.r.headers.get('set-cookie').split(';')[0];
      assert.equal(
        (await request(base + '/runs/' + live.data.id, undefined, undefined, foreign)).r.status,
        403,
      );
      assert.equal(
        (await request(base + '/connections', undefined, undefined, foreign)).r.status,
        403,
      );
      const viewer = 'integration_viewer_' + suffix;
      await admin.query(
        'INSERT INTO relay.security_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
        [viewer, viewer + '@relay.test', 'Viewer', 'unused'],
      );
      await admin.query("INSERT INTO relay.security_memberships VALUES($1,$2,'viewer')", [
        workspace,
        viewer,
      ]);
      const viewerContext = {
        workspaceId: workspace,
        actor: { kind: 'user', id: viewer },
        requestId: 'viewer-test',
      };
      const appPorts = await createRuntimePorts({
        config: loadConfig({ ...env, ENGINE_ROLE: 'api' }),
        env,
      });
      try {
        assert.equal(
          await appPorts.authorize(viewerContext, { operation: 'execute', run: done }),
          false,
        );
      } finally {
        await appPorts.close();
      }
      evidence.checks.push('foreign tenant HTTP denial and viewer execution denial');
      const prompt = await request(base + '/prompts', {
        name: 'Approved prompt',
        content: 'Return a short answer.',
        description: '',
      });
      assert.equal(prompt.r.status, 201);
      const prompts = (await request(base + '/prompts')).data;
      assert.equal(prompts[0].content, 'Return a short answer.');
      assert.equal(
        (
          await request(
            base + '/prompts/' + prompt.data.id,
            { name: 'Changed', content: 'Changed', revision: 99 },
            'PUT',
          )
        ).r.status,
        409,
      );
      const dataset = await request(base + '/datasets', {
        name: 'Protocol outcomes',
        cases: [{ input: 'A', expected: 'Synthetic fixture answer' }, { input: 'B' }],
      });
      assert.equal(dataset.r.status, 201);
      const evaluation = await request(base + '/evaluations', {
        name: 'Observed outputs',
        workflowId: wf.data.id,
        datasetId: dataset.data.id,
        mode: 'live',
        rules: [{ type: 'success' }],
      });
      assert.equal(evaluation.r.status, 202, JSON.stringify(evaluation.data));
      const ev = await until(async () => {
        const e = (await request(base + '/evaluations/' + evaluation.data.id)).data;
        return e.status === 'completed' && e;
      });
      assert.equal(ev.summary.passed, 2);
      assert.equal(ev.summary.synthetic, false);
      evidence.checks.push(
        'production prompt history, stale update denial and durable deterministic evaluation',
      );
      const published = await request(base + '/applications', {
        name: 'Private immutable API',
        workflowId: wf.data.id,
        settings: { public: false, mode: 'preview' },
      });
      assert.equal(published.r.status, 201, JSON.stringify(published.data));
      async function application(path, body, token = published.data.token) {
        const r = await fetch(api + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { r, data: await r.json() };
      }
      const appPath = '/api/apps/' + published.data.id;
      assert.equal((await application(appPath + '/invoke', { input: 'denied' }, '')).r.status, 401);
      const appRun = await application(appPath + '/invoke', { input: 'No paid model in preview' });
      assert.equal(appRun.r.status, 202, JSON.stringify(appRun.data));
      const appDone = await until(async () => {
        const d = (await application(appPath + '/runs/' + appRun.data.id)).data;
        return d.status === 'completed' && d;
      });
      assert.match(appDone.output, /Development preview/);
      assert.equal((await application(appPath + '/runs/' + live.data.id)).r.status, 404);
      assert.equal(
        (await request(base + '/applications/' + published.data.id + '/rotate', {})).r.status,
        200,
      );
      assert.equal(
        (await application(appPath + '/invoke', { input: 'old key denied' })).r.status,
        401,
      );
      evidence.checks.push(
        'private frozen publication, async scoped invocation, unrelated run denial and immediate credential revocation',
      );
      t.diagnostic(JSON.stringify(evidence));
    } finally {
      if (http) {
        http.closeAllConnections();
        await new Promise((r) => http.close(r));
      }
      await Promise.allSettled(runtimes.map((rt) => rt.close()));
      await fixture.close();
      s3.destroy();
      for (const [k, v] of Object.entries(saved))
        v === undefined ? delete process.env[k] : (process.env[k] = v);
      await admin.end();
      await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await root.query(`DROP ROLE IF EXISTS "${role}"`);
      await root.end();
    }
  },
);
