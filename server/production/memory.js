import crypto from 'node:crypto';
import { tenantContextSchema, resourceId } from '../foundation/contracts.js';
import { PlatformError } from '../foundation/errors.js';
export function createProductionMemory({ database, security }) {
  async function authorize(ctx, q) {
    tenantContextSchema.parse(ctx);
    resourceId.parse(q.agentId);
    if (q.conversationId) resourceId.parse(q.conversationId);
    await security.authorize(ctx, 'run.execute');
    return `${ctx.actor.kind}:${ctx.actor.id}`;
  }
  return {
    async read(ctx, q) {
      const principal = await authorize(ctx, q);
      return database.transaction(ctx, (s) =>
        s.all(
          'SELECT content FROM relay.memories WHERE workspace_id=$1 AND agent_id=$2 AND principal=$3 AND ($4::text IS NULL OR conversation_id=$4) ORDER BY created_at DESC LIMIT $5',
          [
            ctx.workspaceId,
            q.agentId,
            principal,
            q.conversationId || null,
            Math.max(1, Math.min(30, q.limit || 6)),
          ],
        ),
      );
    },
    async write(ctx, q) {
      const principal = await authorize(ctx, q),
        content = JSON.stringify(q.messages || q.content);
      if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000)
        throw new PlatformError('BUDGET_EXCEEDED', 'Memory exceeds its storage budget.');
      await database.transaction(ctx, (s) =>
        s.query(
          'INSERT INTO relay.memories(id,workspace_id,agent_id,conversation_id,content,created_at,principal) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            crypto.randomUUID(),
            ctx.workspaceId,
            q.agentId,
            q.conversationId || null,
            content,
            new Date().toISOString(),
            principal,
          ],
        ),
      );
    },
  };
}
