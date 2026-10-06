import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
import { writeAudit } from '../security/audit.js';

const actualSchema = z
  .object({
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    costMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
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
const resolutionSchema = z
  .object({ actual: actualSchema, evidence: z.string().min(10).max(1000) })
  .strict();
// Connection probes are billable calls too. Keep an addressable original actor
// and never replay a lost response or silently release its spend reservation.
export function createModelProbeAccounting({ database, security }) {
  return {
    async run(ctx, connectionId, invoke) {
      resourceId.parse(connectionId);
      await security.authorize(ctx, 'secret.manage', { kind: 'connection', id: connectionId });
      await security.authorize(ctx, 'run.execute');
      const id = crypto.randomUUID();
      await database.transaction(ctx, (s) =>
        s.query(
          "INSERT INTO relay.model_connection_probes(workspace_id,id,connection_id,actor,state) VALUES($1,$2,$3,$4,'started')",
          [ctx.workspaceId, id, connectionId, JSON.stringify(ctx.actor)],
        ),
      );
      try {
        const result = await invoke(async (bounds, fn) => {
          const held = await security.usage.reserve(ctx, { ...bounds, runId: id });
          try {
            const result = await fn();
            await security.usage.settle(ctx, held.id, {
              tokens: result.usage.tokens,
              costMicros: result.usage.costMicros,
              provider: result.provider,
              model: result.model,
            });
            return result;
          } catch (error) {
            await security.usage.markUncertain(ctx, held.id);
            throw error;
          }
        });
        await database.transaction(ctx, (s) =>
          s.query(
            "UPDATE relay.model_connection_probes SET state='settled',completed_at=now() WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, id],
          ),
        );
        return { ...result, probeId: id };
      } catch (error) {
        await database
          .transaction(ctx, (s) =>
            s.query(
              "UPDATE relay.model_connection_probes p SET state=CASE WHEN EXISTS(SELECT 1 FROM relay.security_usage u WHERE u.workspace_id=p.workspace_id AND u.run_id=p.id::text AND u.status IN('reserved','uncertain')) THEN 'uncertain' ELSE 'failed' END,completed_at=now() WHERE workspace_id=$1 AND id=$2",
              [ctx.workspaceId, id],
            ),
          )
          .catch(() => {});
        throw error;
      }
    },
    async list(ctx) {
      await security.authorize(ctx, 'secret.manage');
      return database.transaction(ctx, (s) =>
        s.all(
          'SELECT p.id,p.connection_id,p.state,p.created_at,p.completed_at,u.id AS reservation_id,u.status AS accounting_status,u.maximum_tokens,u.tokens,u.cost_micros,u.provider,u.model FROM relay.model_connection_probes p LEFT JOIN relay.security_usage u ON u.workspace_id=p.workspace_id AND u.run_id=p.id::text WHERE p.workspace_id=$1 ORDER BY p.created_at DESC LIMIT 1000',
          [ctx.workspaceId],
        ),
      );
    },
    async reconcile(ctx, id, input) {
      z.uuid().parse(id);
      const b = resolutionSchema.parse(input);
      await security.authorize(ctx, 'budget.manage');
      const hash = crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
      return database.transaction(ctx, async (s) => {
        const p = await s.one(
          'SELECT * FROM relay.model_connection_probes WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [ctx.workspaceId, id],
        );
        if (!p) throw new PlatformError('NOT_FOUND', 'Connection probe was not found.');
        if (p.state === 'reconciled') {
          if (p.resolution_hash !== hash)
            throw new PlatformError('CONFLICT', 'Reconciliation differs from recorded evidence.');
          return { id, state: 'reconciled' };
        }
        if (
          p.state !== 'uncertain' &&
          !(p.state === 'started' && Date.now() - Date.parse(p.created_at) > 300000)
        )
          throw new PlatformError(
            'CONFLICT',
            'Only an uncertain or expired connection probe can be reconciled.',
          );
        const u = await s.one(
          'SELECT * FROM relay.security_usage WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE',
          [ctx.workspaceId, id],
        );
        const actor = typeof p.actor === 'string' ? JSON.parse(p.actor) : p.actor;
        if (
          !u ||
          !['reserved', 'uncertain'].includes(u.status) ||
          u.actor_id !== actor.id ||
          u.actor_kind !== actor.kind
        )
          throw new PlatformError(
            'CONFLICT',
            'Probe accounting is unavailable or already settled.',
          );
        await s.query(
          "UPDATE relay.security_usage SET status='settled',tokens=$3,cost_micros=$4,provider=$5,model=$6,settled_at=now() WHERE workspace_id=$1 AND id=$2",
          [
            ctx.workspaceId,
            u.id,
            b.actual.tokens,
            b.actual.costMicros,
            b.actual.provider,
            b.actual.model,
          ],
        );
        await s.query(
          "UPDATE relay.model_connection_probes SET state='reconciled',resolution_hash=$3,completed_at=now() WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id, hash],
        );
        // Evidence is retained as a hash, avoiding secrets or provider bodies in audit logs.
        await writeAudit(s, ctx, 'model.probe.reconciled', id);
        if (
          b.actual.tokens > Number(u.maximum_tokens) ||
          (b.actual.costMicros !== null &&
            u.maximum_cost_micros !== null &&
            b.actual.costMicros > Number(u.maximum_cost_micros))
        )
          await writeAudit(s, ctx, 'usage.ceiling.exceeded', u.id, id);
        return { id, state: 'reconciled', evidenceHash: hash };
      });
    },
  };
}
