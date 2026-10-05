import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId, tenantContextSchema } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { writeAudit } from './audit.js';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const requestSchema = z
  .object({ runId: resourceId, maximumTokens: integer, maximumCostMicros: integer.nullable() })
  .strict();
const resultSchema = z
  .object({
    tokens: integer,
    costMicros: integer.nullable(),
    provider: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[\w .:/-]+$/),
    model: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w .:/-]+$/),
  })
  .strict();
const denied = () => {
  throw new PlatformError(
    'BUDGET_EXCEEDED',
    'Workspace resource budget is unavailable or exceeded.',
  );
};
export function createUsagePort({ database, authorize }) {
  async function locked(context, fn) {
    context = tenantContextSchema.parse(context);
    await authorize(context, 'run.execute');
    return database.transaction(context, async (session) => {
      const policy = await session.one(
        'SELECT * FROM relay.security_budget_policies WHERE workspace_id=$1 FOR UPDATE',
        [context.workspaceId],
      );
      if (!policy) denied();
      return fn(session, policy);
    });
  }
  return Object.freeze({
    async reserve(context, input) {
      input = requestSchema.parse(input);
      return locked(context, async (s, policy) => {
        if (
          input.maximumTokens > Number(policy.max_reserved_tokens) ||
          (input.maximumCostMicros === null &&
            (!policy.allow_unknown_cost || policy.cost_limit_micros !== null))
        )
          denied();
        // Uncertain calls retain their full ceiling. Unknown actual costs retain the ceiling too.
        const sums = await s.one(
          `SELECT
          COALESCE(SUM(CASE WHEN status='settled' THEN tokens ELSE maximum_tokens END),0)::text AS tokens,
          COALESCE(SUM(CASE WHEN status='settled' AND cost_micros IS NOT NULL THEN cost_micros ELSE maximum_cost_micros END),0)::text AS cost,
          count(*) FILTER (WHERE maximum_cost_micros IS NULL AND (status IN ('reserved','uncertain') OR cost_micros IS NULL))::text AS unknown
          FROM relay.security_usage WHERE workspace_id=$1 AND period_id=$2 AND status!='released'`,
          [context.workspaceId, policy.period_id],
        );
        if (
          BigInt(sums.tokens) + BigInt(input.maximumTokens) > BigInt(policy.token_limit) ||
          (policy.cost_limit_micros !== null &&
            (BigInt(sums.unknown) > 0n ||
              BigInt(sums.cost) + BigInt(input.maximumCostMicros) >
                BigInt(policy.cost_limit_micros)))
        )
          denied();
        const id = crypto.randomUUID();
        await s.query(
          `INSERT INTO relay.security_usage
          (id,workspace_id,period_id,run_id,actor_kind,actor_id,maximum_tokens,maximum_cost_micros,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved')`,
          [
            id,
            context.workspaceId,
            policy.period_id,
            input.runId,
            context.actor.kind,
            context.actor.id,
            input.maximumTokens,
            input.maximumCostMicros,
          ],
        );
        return { id, workspaceId: context.workspaceId, ...input };
      });
    },
    async settle(context, reservationId, input) {
      context = tenantContextSchema.parse(context);
      z.uuid().parse(reservationId);
      input = resultSchema.parse(input);
      // Settlement must remain possible after actor revocation: trusted worker calls only.
      return database.transaction(context, async (s) => {
        const row = await s.one(
          'SELECT * FROM relay.security_usage WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [context.workspaceId, reservationId],
        );
        if (!row || row.actor_kind !== context.actor.kind || row.actor_id !== context.actor.id)
          throw new PlatformError('FORBIDDEN', 'Reservation is outside actor scope.');
        if (row.status === 'settled') {
          if (
            Number(row.tokens) === input.tokens &&
            (row.cost_micros === null ? null : Number(row.cost_micros)) === input.costMicros &&
            row.provider === input.provider &&
            row.model === input.model
          )
            return;
          throw new PlatformError('CONFLICT', 'Settlement differs from recorded usage.');
        }
        if (row.status === 'released')
          throw new PlatformError('CONFLICT', 'Reservation was released.');
        await s.query(
          `UPDATE relay.security_usage SET status='settled',tokens=$3,cost_micros=$4,provider=$5,model=$6,settled_at=now()
          WHERE workspace_id=$1 AND id=$2`,
          [
            context.workspaceId,
            reservationId,
            input.tokens,
            input.costMicros,
            input.provider,
            input.model,
          ],
        );
        if (
          input.tokens > Number(row.maximum_tokens) ||
          (input.costMicros !== null &&
            row.maximum_cost_micros !== null &&
            input.costMicros > Number(row.maximum_cost_micros))
        )
          await writeAudit(s, context, 'usage.ceiling.exceeded', reservationId, row.run_id);
      });
    },
    async release(context, reservationId) {
      context = tenantContextSchema.parse(context);
      z.uuid().parse(reservationId);
      return database.transaction(context, async (s) => {
        const row = await s.one(
          'SELECT * FROM relay.security_usage WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [context.workspaceId, reservationId],
        );
        if (!row || row.actor_kind !== context.actor.kind || row.actor_id !== context.actor.id)
          throw new PlatformError('FORBIDDEN', 'Reservation is outside actor scope.');
        if (row.status === 'released') return;
        if (row.status !== 'reserved')
          throw new PlatformError('CONFLICT', 'Executed or uncertain usage cannot be released.');
        await s.query(
          "UPDATE relay.security_usage SET status='released',settled_at=now() WHERE workspace_id=$1 AND id=$2",
          [context.workspaceId, reservationId],
        );
      });
    },
    async markUncertain(context, reservationId) {
      context = tenantContextSchema.parse(context);
      z.uuid().parse(reservationId);
      return database.transaction(context, async (s) => {
        await s.query(
          `UPDATE relay.security_usage SET status='uncertain' WHERE workspace_id=$1 AND id=$2
          AND actor_kind=$3 AND actor_id=$4 AND status='reserved'`,
          [context.workspaceId, reservationId, context.actor.kind, context.actor.id],
        );
      });
    },
    async report(context) {
      await authorize(context, 'workspace.read');
      return database.transaction(context, (s) =>
        s.all(
          `SELECT period_id,status,provider,model,
        SUM(tokens)::text AS tokens,SUM(cost_micros)::text AS known_cost_micros,
        COUNT(*) FILTER (WHERE status='settled' AND cost_micros IS NULL)::text AS unknown_cost_calls,
        SUM(maximum_tokens) FILTER (WHERE status IN ('reserved','uncertain'))::text AS held_tokens,
        SUM(maximum_cost_micros) FILTER (WHERE status IN ('reserved','uncertain') OR (status='settled' AND cost_micros IS NULL))::text AS held_cost_micros
        FROM relay.security_usage WHERE workspace_id=$1 GROUP BY period_id,status,provider,model`,
          [context.workspaceId],
        ),
      );
    },
    async configure(context, input) {
      await authorize(context, 'budget.manage');
      const b = z
        .object({
          periodId: resourceId,
          tokenLimit: integer,
          costLimitMicros: integer.nullable(),
          allowUnknownCost: z.boolean(),
          maxConcurrent: z.number().int().min(1).max(128),
          maxReservedTokens: integer.refine((v) => v > 0),
        })
        .strict()
        .parse(input);
      if (b.costLimitMicros !== null && b.allowUnknownCost)
        throw new PlatformError('VALIDATION_ERROR', 'Unknown costs cannot have a dollar cap.');
      await database.transaction(context, async (s) => {
        // Period rollover cannot strand outstanding reservations in an uncounted old period.
        await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'budget:' + context.workspaceId,
        ]);
        const existing = await s.one(
          'SELECT period_id FROM relay.security_budget_policies WHERE workspace_id=$1 FOR UPDATE',
          [context.workspaceId],
        );
        const held = await s.one(
          "SELECT count(*)::text AS n FROM relay.security_usage WHERE workspace_id=$1 AND status IN ('reserved','uncertain')",
          [context.workspaceId],
        );
        if (existing && existing.period_id !== b.periodId && BigInt(held.n) > 0n)
          throw new PlatformError('CONFLICT', 'Reconcile outstanding work before budget rollover.');
        await s.query(
          `INSERT INTO relay.security_budget_policies VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(workspace_id) DO UPDATE SET period_id=$2,token_limit=$3,cost_limit_micros=$4,allow_unknown_cost=$5,max_concurrent=$6,max_reserved_tokens=$7`,
          [
            context.workspaceId,
            b.periodId,
            b.tokenLimit,
            b.costLimitMicros,
            b.allowUnknownCost,
            b.maxConcurrent,
            b.maxReservedTokens,
          ],
        );
        await writeAudit(s, context, 'budget.updated', context.workspaceId);
      });
    },
  });
}
