import { z } from 'zod';
import { resourceId, tenantContextSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
export function createCapacityPort({ database, authorize }) {
  const lease = z
    .object({
      runId: resourceId,
      ownerId: resourceId,
      generation: z.number().int().positive(),
      ttlMs: z.number().int().min(1000).max(60000),
    })
    .strict();
  return Object.freeze({
    async acquire(context, input) {
      context = tenantContextSchema.parse(context);
      input = lease.parse(input);
      await authorize(context, 'run.execute');
      return database.transaction(context, async (s) => {
        const p = await s.one(
          'SELECT max_concurrent FROM relay.security_budget_policies WHERE workspace_id=$1 FOR UPDATE',
          [context.workspaceId],
        );
        if (!p) throw new PlatformError('BUDGET_EXCEEDED', 'Workspace capacity is unconfigured.');
        const old = await s.one(
          'SELECT * FROM relay.security_capacity WHERE workspace_id=$1 AND run_id=$2',
          [context.workspaceId, input.runId],
        );
        if (
          old &&
          (old.owner_id !== input.ownerId ||
            Number(old.generation) !== input.generation ||
            new Date(old.expires_at).getTime() <= Date.now())
        )
          throw new PlatformError('CONFLICT', 'Capacity requires reconciliation before takeover.');
        const count = await s.one(
          'SELECT count(*)::int AS n FROM relay.security_capacity WHERE workspace_id=$1',
          [context.workspaceId],
        );
        if (!old && count.n >= p.max_concurrent)
          throw new PlatformError('RATE_LIMITED', 'Workspace concurrency limit reached.');
        const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
        await s.query(
          `INSERT INTO relay.security_capacity VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(workspace_id,run_id) DO UPDATE SET expires_at=$5`,
          [context.workspaceId, input.runId, input.ownerId, input.generation, expiresAt],
        );
        return { ownerId: input.ownerId, generation: input.generation, expiresAt };
      });
    },
    async release(context, input) {
      context = tenantContextSchema.parse(context);
      const b = lease.omit({ ttlMs: true }).parse(input);
      return database.transaction(context, (s) =>
        s.query(
          'DELETE FROM relay.security_capacity WHERE workspace_id=$1 AND run_id=$2 AND owner_id=$3 AND generation=$4',
          [context.workspaceId, b.runId, b.ownerId, b.generation],
        ),
      );
    },
  });
}
