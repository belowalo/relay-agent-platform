import { uuid, clockSql } from './core.js';
// Round-robin one reference per tenant per sweep; claims and capacity remain authoritative in PG.
export function createDispatcher({
  repository,
  queue,
  listWorkspaces,
  ownerId = uuid(),
  leaseMs = 30000,
  onError = () => {},
}) {
  let stopping = false,
    active = null;
  async function tick() {
    if (stopping || active) return;
    active = (async () => {
      for (const workspaceId of await listWorkspaces()) {
        if (stopping) break;
        const context = {
          workspaceId,
          actor: { kind: 'service', id: 'runtime-dispatcher' },
          requestId: uuid(),
        };
        try {
          // Redis may lose jobs; a fresh reference bypasses transport completion retention.
          await repository.tx(context, async (s) => {
            const runs = await s.all(
              `SELECT r.id,r.request_id FROM relay.runs r WHERE r.workspace_id=$1 AND r.actor IS NOT NULL AND r.status IN ('queued','running') AND r.available_at<=now() AND coalesce(r.lease_until,0)<${clockSql} AND NOT EXISTS(SELECT 1 FROM relay.job_outbox o WHERE o.workspace_id=r.workspace_id AND o.resource_id=r.id AND o.kind='workflow.run' AND (o.state!='published' OR o.published_at>now()-interval '5 seconds')) ORDER BY r.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
              [workspaceId],
            );
            for (const run of runs)
              await repository.enqueue(
                { ...s, context: { ...context, requestId: run.request_id } },
                run.id,
              );
          });
          const entry = await repository.tx(context, (s) =>
            s.one(
              "WITH candidate AS (SELECT id FROM relay.job_outbox WHERE workspace_id=$1 AND available_at<=now() AND (state='pending' OR state='publishing' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE relay.job_outbox o SET state='publishing',lease_owner=$2,lease_until=now()+($3*interval '1 millisecond'),lease_generation=lease_generation+1,attempts=attempts+1 FROM candidate c WHERE o.id=c.id RETURNING o.*",
              [workspaceId, ownerId, leaseMs],
            ),
          );
          if (!entry) continue;
          const reference = {
            version: entry.version,
            id: entry.id,
            workspaceId: entry.workspace_id,
            kind: entry.kind,
            resourceId: entry.resource_id,
            requestId: entry.request_id,
          };
          await queue.publish(reference);
          await repository.tx(context, (s) =>
            s.query(
              "UPDATE relay.job_outbox SET state='published',published_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1 AND state='publishing' AND lease_owner=$2 AND lease_generation=$3 AND lease_until>now()",
              [entry.id, ownerId, entry.lease_generation],
            ),
          );
        } catch {
          onError('runtime.dispatch.failed');
        }
      }
    })();
    try {
      await active;
    } finally {
      active = null;
    }
  }
  return {
    tick,
    async close() {
      stopping = true;
      await active;
    },
  };
}
