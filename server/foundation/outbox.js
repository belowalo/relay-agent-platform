import { jobSchema } from './contracts.js';
import { assertWorkspace } from './context.js';

export async function enqueueInTransaction(session, job) {
  job = jobSchema.parse(job);
  assertWorkspace(job.workspaceId, session.context);
  await session.query(
    'INSERT INTO relay.job_outbox(id,workspace_id,kind,resource_id,request_id,version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
    [job.id, job.workspaceId, job.kind, job.resourceId, job.requestId, job.version],
  );
  const stored = await session.one(
    'SELECT workspace_id,kind,resource_id,request_id,version FROM relay.job_outbox WHERE id=$1',
    [job.id],
  );
  if (
    !stored ||
    stored.workspace_id !== job.workspaceId ||
    stored.kind !== job.kind ||
    stored.resource_id !== job.resourceId ||
    stored.request_id !== job.requestId ||
    stored.version !== job.version
  ) {
    const { PlatformError } = await import('./errors.js');
    throw new PlatformError('CONFLICT', 'Job identity was reused with different data.');
  }
  return job.id;
}
