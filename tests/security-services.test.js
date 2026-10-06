import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../server/foundation/migrations.js';
import { createPostgresDatabase } from '../server/foundation/database.js';
import { loadConfig } from '../server/foundation/config.js';
import { createAuthorization } from '../server/security/authorization.js';
import { createUsagePort } from '../server/security/usage.js';
import { createCapacityPort } from '../server/security/capacity.js';
const url = process.env.SECURITY_TEST_DATABASE_URL;
test(
  'live PostgreSQL: two pools atomically enforce budgets/capacity and RLS survives connection reuse',
  { skip: !url, timeout: 60000 },
  async () => {
    const target = new URL(url);
    assert.match(target.pathname, /^\/relay_security_test(?:_[A-Za-z0-9]+)?$/);
    const admin = new pg.Pool({ connectionString: url });
    admin.on('error', () => {});
    const suffix = crypto.randomBytes(8).toString('hex'),
      role = 'relay_security_' + suffix,
      password = crypto.randomBytes(24).toString('hex');
    const workspaceId = 'workspace_' + suffix,
      userId = 'owner_' + suffix;
    let a,
      b,
      created = false;
    const context = {
      workspaceId,
      actor: { kind: 'user', id: userId },
      requestId: 'live-security-test',
    };
    try {
      await applyMigrations(admin);
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      created = true;
      await admin.query(`GRANT USAGE ON SCHEMA relay TO "${role}"`);
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON relay.security_workspaces,relay.security_memberships,relay.security_budget_policies,relay.security_usage,relay.security_capacity TO "${role}"`,
      );
      await admin.query(
        `GRANT SELECT(id,disabled_at,mfa_enabled) ON relay.security_accounts TO "${role}"`,
      );
      await admin.query(`GRANT INSERT,SELECT ON relay.security_audit TO "${role}"`);
      await admin.query(
        'INSERT INTO relay.security_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
        [userId, userId + '@relay.test', 'Fixture', 'unused-test-digest'],
      );
      await admin.query('INSERT INTO relay.workspaces(id,name,created_at) VALUES($1,$2,$3)', [
        workspaceId,
        'Security fixture',
        new Date().toISOString(),
      ]);
      await admin.query('INSERT INTO relay.security_workspaces(workspace_id) VALUES($1)', [
        workspaceId,
      ]);
      await admin.query('INSERT INTO relay.security_memberships VALUES($1,$2,$3)', [
        workspaceId,
        userId,
        'owner',
      ]);
      target.username = role;
      target.password = password;
      const config = loadConfig({ DATABASE_URL: target.toString() });
      a = createPostgresDatabase(config, {
        pool: new pg.Pool({ connectionString: target.toString(), max: 4 }),
      });
      b = createPostgresDatabase(config, {
        pool: new pg.Pool({ connectionString: target.toString(), max: 4 }),
      });
      await a.assertApplicationRole();
      await b.assertApplicationRole();
      const authA = createAuthorization({ database: a }).authorize,
        authB = createAuthorization({ database: b }).authorize;
      const usageA = createUsagePort({ database: a, authorize: authA }),
        usageB = createUsagePort({ database: b, authorize: authB });
      await usageA.configure(context, {
        periodId: 'period1',
        tokenLimit: 1000,
        costLimitMicros: 1000,
        allowUnknownCost: false,
        maxConcurrent: 2,
        maxReservedTokens: 100,
      });
      const reservations = await Promise.allSettled(
        Array.from({ length: 40 }, (_, i) =>
          (i % 2 ? usageA : usageB).reserve(context, {
            runId: 'run_' + i,
            maximumTokens: 60,
            maximumCostMicros: 60,
          }),
        ),
      );
      assert.equal(reservations.filter((r) => r.status === 'fulfilled').length, 16);
      assert.ok(
        reservations
          .filter((r) => r.status === 'rejected')
          .every((r) => r.reason.code === 'BUDGET_EXCEEDED'),
      );
      const capA = createCapacityPort({ database: a, authorize: authA }),
        capB = createCapacityPort({ database: b, authorize: authB });
      const leases = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? capA : capB).acquire(context, {
            runId: 'capacity_' + i,
            ownerId: 'worker_' + i,
            generation: 1,
            ttlMs: 30000,
          }),
        ),
      );
      assert.equal(leases.filter((r) => r.status === 'fulfilled').length, 2);
      const foreign = { ...context, workspaceId: 'foreign_' + suffix };
      assert.equal(
        (
          await a.transaction(foreign, (s) =>
            s.all('SELECT workspace_id FROM relay.security_memberships'),
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await a.transaction(context, (s) =>
            s.all('SELECT workspace_id FROM relay.security_memberships'),
          )
        ).length,
        1,
      );
      await admin.query(
        'DELETE FROM relay.security_memberships WHERE workspace_id=$1 AND user_id=$2',
        [workspaceId, userId],
      );
      await assert.rejects(() => authB(context, 'run.execute'), /Permission/);
    } finally {
      await Promise.all([a?.close(), b?.close()]);
      // Identifiers are generated locally and the database name was verified before any mutation.
      for (const table of [
        'security_audit',
        'security_capacity',
        'security_usage',
        'security_budget_policies',
        'security_memberships',
        'security_workspaces',
      ])
        await admin.query(`DELETE FROM relay.${table} WHERE workspace_id=$1`, [workspaceId]);
      await admin.query('DELETE FROM relay.security_accounts WHERE id=$1', [userId]);
      await admin.query('DELETE FROM relay.workspaces WHERE id=$1', [workspaceId]);
      if (created) {
        await admin.query(`DROP OWNED BY "${role}"`);
        await admin.query(`DROP ROLE "${role}"`);
      }
      await admin.end();
    }
  },
);
