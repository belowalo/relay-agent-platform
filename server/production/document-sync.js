import crypto from 'node:crypto';
import { z } from 'zod';
import { resourceId, jobSchema } from '../foundation/contracts.js';
import { enqueueInTransaction } from '../foundation/outbox.js';
import { PlatformError } from '../foundation/errors.js';
import { accessSchema } from '../knowledge/contracts.js';
import {
  connectorFor,
  createDocumentSource,
  createSyncState,
  synchronizeDocuments,
} from '../connectors/index.js';
import { stableHash } from '../connectors/core.js';
const specification = z
  .object({
    collectionId: resourceId,
    access: accessSchema,
    repository: z.string().max(200).optional(),
    paths: z.array(z.string().min(1).max(1000)).min(1).max(100).optional(),
    ref: z.string().min(1).max(200).optional(),
  })
  .strict();
export function createProductionDocumentSync({
  database,
  security,
  connections,
  connectorPorts,
  outbound,
  pipeline,
  knowledgeRepository,
  blobs,
}) {
  const tx = (ctx, fn) => database.transaction(ctx, fn);
  async function check(ctx, row) {
    await security.authorize(ctx, 'document.write', { kind: 'collection', id: row.collection_id });
    const c = await connections.get(ctx, row.connection_id);
    if (Number(c.generation) !== Number(row.connection_generation))
      throw new PlatformError('FORBIDDEN', 'Connection changed; create a new synchronization job.');
    return c;
  }
  const state = createSyncState(database, {
    authorize: async (ctx, { sourceId }) => {
      const r = await tx(ctx, (s) =>
        s.one('SELECT connection_id FROM relay.connector_sync WHERE workspace_id=$1 AND id=$2', [
          ctx.workspaceId,
          sourceId,
        ]),
      );
      if (!r) throw new PlatformError('NOT_FOUND', 'Synchronization was not found.');
      await connections.get(ctx, r.connection_id);
      await security.authorize(ctx, 'document.write');
    },
  });
  async function load(ctx, id) {
    const r = await tx(ctx, (s) =>
      s.one(
        'SELECT j.*,c.connection_id FROM relay.document_sync_jobs j JOIN relay.connector_sync c ON c.workspace_id=j.workspace_id AND c.id=j.sync_id WHERE j.workspace_id=$1 AND j.id=$2',
        [ctx.workspaceId, id],
      ),
    );
    if (!r) throw new PlatformError('NOT_FOUND', 'Synchronization job was not found.');
    return r;
  }
  async function enqueue(ctx, connectionId, input, syncId = crypto.randomUUID()) {
    input = specification.parse(input);
    const c = await connections.get(ctx, connectionId);
    if (!['github', 'google-drive', 's3'].includes(c.kind))
      throw new PlatformError('VALIDATION_ERROR', 'This connector has no document source loader.');
    if (c.kind !== 'github' && (input.repository || input.paths || input.ref))
      throw new PlatformError('VALIDATION_ERROR', 'Repository selections apply to GitHub only.');
    createDocumentSource(
      c.kind,
      { ...input, bucket: c.config.bucket },
      { blobs, collectionId: input.collectionId, access: input.access },
    );
    await security.authorize(ctx, 'document.write', { kind: 'collection', id: input.collectionId });
    await connections.initializeSync(ctx, syncId, connectionId);
    const id = crypto.randomUUID();
    await tx(ctx, async (s) => {
      // Cursor identity includes destination and ACL. A resume cannot silently
      // reuse checkpoints for another collection or widen imported access.
      const prior = await s.one(
        'SELECT specification FROM relay.document_sync_jobs WHERE workspace_id=$1 AND sync_id=$2 ORDER BY created_at DESC LIMIT 1',
        [ctx.workspaceId, syncId],
      );
      if (prior && stableHash(prior.specification) !== stableHash(input))
        throw new PlatformError(
          'CONFLICT',
          'Resume must retain the original collection and access policy.',
        );
      await s.query(
        'INSERT INTO relay.document_sync_jobs(workspace_id,id,sync_id,collection_id,context,specification,connection_generation) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          ctx.workspaceId,
          id,
          syncId,
          input.collectionId,
          JSON.stringify(ctx),
          JSON.stringify(input),
          c.generation,
        ],
      );
      await enqueueInTransaction(s, {
        version: 1,
        id,
        workspaceId: ctx.workspaceId,
        kind: 'connector.sync',
        resourceId: id,
        requestId: ctx.requestId,
      });
    });
    return { id, syncId, state: 'queued' };
  }
  async function handle(job) {
    job = jobSchema.parse(job);
    const scope = {
        workspaceId: job.workspaceId,
        actor: { kind: 'service', id: 'sync-discovery' },
        requestId: job.requestId,
      },
      row = await load(scope, job.resourceId);
    if (row.id !== job.id || job.kind !== 'connector.sync')
      throw new PlatformError('FORBIDDEN', 'Invalid synchronization reference.');
    if (['completed', 'failed'].includes(row.state)) return;
    const ctx = { ...row.context, requestId: job.requestId },
      claim = crypto.randomUUID();
    const claimed = await tx(ctx, (s) =>
      s.one(
        "UPDATE relay.document_sync_jobs SET state='running',claim=$3,attempts=attempts+1,deadline=now()+interval '360 seconds' WHERE workspace_id=$1 AND id=$2 AND (state='queued' OR state='running' AND deadline<now()) RETURNING id",
        [ctx.workspaceId, row.id, claim],
      ),
    );
    if (!claimed) return;
    const finish = async (state, result, errorCode = null) =>
      tx(ctx, (s) =>
        s.query(
          'UPDATE relay.document_sync_jobs SET state=$4,result=$5,error_code=$6,deadline=NULL WHERE workspace_id=$1 AND id=$2 AND claim=$3',
          [
            ctx.workspaceId,
            row.id,
            claim,
            state,
            result ? JSON.stringify(result) : null,
            errorCode,
          ],
        ),
      );
    try {
      const c = await check(ctx, row),
        input = row.specification,
        signal = AbortSignal.timeout(300000);
      const connector = connectorFor(c.kind, c.config, connectorPorts(ctx, c), {
        fetchImpl: outbound.fetch,
      });
      const loader = createDocumentSource(
        c.kind,
        { ...input, bucket: c.config.bucket },
        { blobs, collectionId: input.collectionId, access: input.access },
      );
      const discard = async (ctx, input) => {
        if (input.blob) await blobs.delete(ctx, input.blob.key);
      };
      const documents = {
        discard,
        async upsert(ctx, input) {
          await check(ctx, row);
          const prior = await knowledgeRepository.getExternal(
            ctx,
            input.collectionId,
            input.externalId,
          );
          if (
            prior &&
            !prior.deleted &&
            input.metadata.revision &&
            prior.metadata.revision === input.metadata.revision &&
            stableHash(prior.access) === stableHash(input.access)
          ) {
            await security.authorize(ctx, 'document.write', { kind: 'document', id: prior.id });
            await discard(ctx, input);
            return { sourceId: prior.id };
          }
          return pipeline.upsert(ctx, input);
        },
        async delete(ctx, id) {
          await check(ctx, row);
          return pipeline.delete(ctx, id);
        },
      };
      const result = await synchronizeDocuments(ctx, {
        connector,
        secretRef: c.secretRef,
        documents,
        state,
        sourceId: row.sync_id,
        signal,
        maxPages: 10,
        maxItems: 1000,
        ...loader,
      });
      await finish('completed', result);
    } catch (error) {
      // Never persist vendor messages, document contents or credentials.
      await finish(
        'failed',
        null,
        [
          'FORBIDDEN',
          'NOT_FOUND',
          'CONFLICT',
          'RATE_LIMITED',
          'VALIDATION_ERROR',
          'BUDGET_EXCEEDED',
          'DEPENDENCY_UNAVAILABLE',
        ].includes(error.code)
          ? error.code
          : 'DEPENDENCY_UNAVAILABLE',
      );
      throw error;
    }
  }
  async function recover(ctx) {
    await tx(ctx, async (s) => {
      await s.query(
        "UPDATE relay.document_sync_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,claim=NULL,deadline=NULL,error_code=CASE WHEN attempts>=3 THEN 'RECOVERY_LIMIT' ELSE NULL END WHERE workspace_id=$1 AND state='running' AND deadline<now()",
        [ctx.workspaceId],
      );
      await s.query(
        "UPDATE relay.job_outbox o SET state='pending',available_at=now(),lease_owner=NULL,lease_until=NULL WHERE o.workspace_id=$1 AND o.kind='connector.sync' AND o.state='published' AND o.published_at<now()-interval '5 seconds' AND EXISTS(SELECT 1 FROM relay.document_sync_jobs j WHERE j.workspace_id=o.workspace_id AND j.id::text=o.resource_id AND j.state='queued')",
        [ctx.workspaceId],
      );
    });
  }
  function register(router) {
    const route = (fn) => async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        next(e);
      }
    };
    router.post(
      '/connectors/:connectionId/sync',
      route(async (req, res) =>
        res
          .status(202)
          .json(await enqueue(req.context, resourceId.parse(req.params.connectionId), req.body)),
      ),
    );
    router.get(
      '/connector-sync/:id',
      route(async (req, res) => {
        const row = await load(req.context, z.uuid().parse(req.params.id));
        await check(req.context, row);
        res.json({
          id: row.id,
          syncId: row.sync_id,
          collectionId: row.collection_id,
          state: row.state,
          attempts: row.attempts,
          result: row.result,
          errorCode: row.error_code,
        });
      }),
    );
    router.post(
      '/connector-sync/:id/resume',
      route(async (req, res) => {
        if (req.body && Object.keys(req.body).length)
          throw new PlatformError('VALIDATION_ERROR', 'Resume accepts no configuration overrides.');
        const row = await load(req.context, z.uuid().parse(req.params.id));
        await check(req.context, row);
        if (!['completed', 'failed'].includes(row.state))
          throw new PlatformError('CONFLICT', 'Job is still active.');
        res
          .status(202)
          .json(await enqueue(req.context, row.connection_id, row.specification, row.sync_id));
      }),
    );
  }
  return { enqueue, handle, recover, register };
}
