import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { applyMigrations } from '../server/foundation/migrations.js';
import { createUsagePort } from '../server/security/usage.js';
import { createModelProbeAccounting } from '../server/production/model-probes.js';
test('lost connection-test responses retain spend and are reconciled once by a current tenant owner, without another model call', async () => {
  const pg = new PGlite({ extensions: { vector } });
  const query = async (s, a) =>
    a?.length ? pg.query(s, a) : { rows: (await pg.exec(s)).at(-1)?.rows || [] };
  try {
    await applyMigrations({ connect: async () => ({ query, release() {} }) });
    await pg.query(
      "INSERT INTO relay.workspaces(id,name,created_at) VALUES('tenant','Tenant','now'),('other','Other','now')",
    );
    await pg.query(
      "INSERT INTO relay.security_workspaces(workspace_id) VALUES('tenant'),('other')",
    );
    const database = {
      transaction: (ctx, fn) =>
        pg.transaction((t) =>
          fn({
            query: (s, a) => t.query(s, a),
            one: async (s, a) => (await t.query(s, a)).rows[0],
            all: async (s, a) => (await t.query(s, a)).rows,
          }),
        ),
    };
    let owner = true;
    const authorize = async (ctx, p) => {
      if (p === 'budget.manage' && (!owner || ctx.actor.id !== 'owner'))
        throw new Error('owner permission required');
    };
    const usage = createUsagePort({ database, authorize }),
      security = { usage, authorize };
    const ctx = {
      workspaceId: 'tenant',
      actor: { kind: 'user', id: 'owner' },
      requestId: 'probe-test',
    };
    await usage.configure(ctx, {
      periodId: 'test',
      tokenLimit: 1000,
      costLimitMicros: null,
      allowUnknownCost: true,
      maxConcurrent: 4,
      maxReservedTokens: 1000,
    });
    const probes = createModelProbeAccounting({ database, security });
    let calls = 0;
    await assert.rejects(
      probes.run(ctx, 'connection', (meter) =>
        meter({ maximumTokens: 500, maximumCostMicros: null }, async () => {
          calls++;
          throw new Error('provider response lost');
        }),
      ),
      /response lost/,
    );
    const [p] = await probes.list(ctx);
    assert.equal(p.state, 'uncertain');
    assert.equal(p.accounting_status, 'uncertain');
    assert.equal(Number((await usage.report(ctx))[0].held_tokens), 500);
    const resolution = {
      actual: { tokens: 42, costMicros: null, provider: 'groq', model: 'openai/gpt-oss-20b' },
      evidence: 'Provider usage export: private incident ticket 42',
    };
    owner = false;
    await assert.rejects(probes.reconcile(ctx, p.id, resolution), /owner permission/);
    owner = true;
    await assert.rejects(probes.reconcile({ ...ctx, workspaceId: 'other' }, p.id, resolution), {
      code: 'NOT_FOUND',
    });
    await probes.reconcile(ctx, p.id, resolution);
    await probes.reconcile(ctx, p.id, resolution);
    await assert.rejects(
      probes.reconcile(ctx, p.id, { ...resolution, actual: { ...resolution.actual, tokens: 0 } }),
      { code: 'CONFLICT' },
    );
    assert.equal(calls, 1);
    assert.equal(Number((await usage.report(ctx))[0].tokens), 42);
    assert.equal((await usage.reportRuns(ctx, [p.id]))[p.id].tokens, 42);
    assert.equal(
      (await usage.reportRuns({ ...ctx, workspaceId: 'other' }, [p.id]))[p.id].tokens,
      0,
    );
    assert.equal(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM relay.security_audit WHERE action='model.probe.reconciled'",
        )
      ).rows[0].n,
      1,
    );
    await probes.run(ctx, 'connection', (meter) =>
      meter({ maximumTokens: 30, maximumCostMicros: null }, async () => ({
        provider: 'groq',
        model: 'fixture',
        usage: { tokens: 20, costMicros: null },
      })),
    );
    const settled = (await probes.list(ctx)).find((v) => v.state === 'settled');
    await assert.rejects(probes.reconcile(ctx, settled.id, resolution), { code: 'CONFLICT' });
  } finally {
    await pg.close();
  }
});
