import crypto from 'node:crypto';
import { tenantContextSchema, resourceId } from '../foundation/contracts.js';
import { z } from 'zod';
export async function writeAudit(session, context, action, target, runId = null) {
  context = tenantContextSchema.parse(context);
  z.string()
    .regex(/^[a-z][a-z0-9_.]{1,79}$/)
    .parse(action);
  resourceId.parse(target);
  if (runId !== null) resourceId.parse(runId);
  await session.query(
    `INSERT INTO relay.security_audit
    (id,workspace_id,actor_kind,actor_id,action,target,request_id,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      crypto.randomUUID(),
      context.workspaceId,
      context.actor.kind,
      context.actor.id,
      action,
      target,
      context.requestId,
      runId,
    ],
  );
}
