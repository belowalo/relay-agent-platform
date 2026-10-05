import { randomUUID } from 'node:crypto';
import {
  context,
  documentSchema,
  limits,
  failure,
  checkSignal,
  normalizeVectors,
  processingBudgets,
} from './contracts.js';
import { resourceId, jobSchema } from '../foundation/contracts.js';
import { chunksFor, hash } from './chunks.js';
import { parseFile } from './extract.js';

export function createKnowledgePipeline({
  repository,
  blobs,
  security,
  outbound,
  embeddings,
  ocr,
  transcribe,
  budgets = limits,
  chunking,
} = {}) {
  budgets = processingBudgets(budgets);
  if (
    !repository ||
    !blobs ||
    !security?.authorize ||
    !security?.authorizeCleanup ||
    !security?.documentPrincipals ||
    !outbound?.fetch ||
    !embeddings?.embed ||
    !embeddings.model
  )
    throw failure(
      'VALIDATION_ERROR',
      'Knowledge requires repository, BlobPort, security authorization/principals, outbound, and embedding adapters.',
    );
  async function authorize(ctx, action, resource = {}) {
    ctx = context(ctx);
    await security.authorize(ctx, { action, ...resource });
    return ctx;
  }
  async function document(ctx, sid, action) {
    resourceId.parse(sid);
    const source = await repository.getSource(ctx, sid);
    if (!source || source.deleted) throw failure('NOT_FOUND', 'Document not found.');
    await authorize(ctx, action, {
      collectionId: source.collection_id,
      sourceId: sid,
      access: source.access,
    });
    return source;
  }
  async function gc(ctx) {
    ctx = context(ctx);
    await security.authorizeCleanup(ctx);
    for (const { key } of await repository.pendingBlobs(ctx)) {
      if (await repository.blobReferenced(ctx, key)) continue;
      try {
        await security.authorizeCleanup(ctx);
        await blobs.delete(ctx, key);
        await repository.blobDeleted(ctx, key);
      } catch {
        /* Durable pending record; retry through maintenance. */
      }
    }
  }
  const pipeline = {
    repository,
    security,
    embeddings,
    async upsert(ctx, input) {
      ctx = context(ctx);
      input = documentSchema.parse(input);
      if (input.blob && input.blob.workspaceId !== ctx.workspaceId)
        throw failure('FORBIDDEN', 'Blob belongs to another workspace.');
      if (input.url) {
        const url = new URL(input.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw failure('VALIDATION_ERROR', 'Use a public HTTP(S) URL without credentials.');
      }
      await authorize(ctx, 'documents.write', {
        collectionId: input.collectionId,
        access: input.access,
      });
      const prior = await repository.getExternal(ctx, input.collectionId, input.externalId);
      if (prior)
        await authorize(ctx, 'documents.write', {
          collectionId: prior.collection_id,
          sourceId: prior.id,
          access: prior.access,
        });
      let blobSources;
      if (input.blob) {
        const referenced = await repository.blobSources(ctx, input.blob.key);
        for (const source of referenced)
          await authorize(ctx, 'documents.write', {
            collectionId: source.collection_id,
            sourceId: source.id,
            access: source.access,
          });
        blobSources = JSON.stringify(
          referenced.map((s) => ({ id: s.id, fingerprint: s.fingerprint })),
        );
      }
      return repository.upsert(ctx, input, prior?.fingerprint || null, blobSources);
    },
    async upload(ctx, input, bytes, contentType) {
      ctx = context(ctx);
      const draft = documentSchema.parse({ ...input, text: '' });
      await authorize(ctx, 'documents.write', {
        collectionId: draft.collectionId,
        access: draft.access,
      });
      if (!(bytes instanceof Uint8Array) || bytes.length > budgets.bytes)
        throw failure('BUDGET_EXCEEDED', 'Upload exceeds the processing budget.');
      const blob = await blobs.put(ctx, randomUUID(), bytes, contentType);
      try {
        return await pipeline.upsert(ctx, { ...input, blob });
      } catch (e) {
        await blobs.delete(ctx, blob.key).catch(() => {});
        throw e;
      }
    },
    async delete(ctx, sid) {
      ctx = context(ctx);
      resourceId.parse(sid);
      const source = await repository.getSource(ctx, sid);
      if (!source) throw failure('NOT_FOUND', 'Document not found.');
      await authorize(ctx, 'documents.delete', {
        collectionId: source.collection_id,
        sourceId: sid,
        access: source.access,
      });
      await repository.delete(ctx, sid, source.fingerprint);
      await gc(ctx);
    },
    async reindex(ctx, sid) {
      ctx = context(ctx);
      const source = await document(ctx, sid, 'documents.write');
      return repository.reindex(ctx, sid, source.fingerprint);
    },
    async cancel(ctx, jid) {
      ctx = context(ctx);
      resourceId.parse(jid);
      const job = await repository.getJob(ctx, jid);
      if (!job) throw failure('NOT_FOUND', 'Ingestion job not found.');
      await document(ctx, job.source_id, 'documents.write');
      await repository.cancel(ctx, jid);
    },
    async status(ctx, jid) {
      ctx = context(ctx);
      resourceId.parse(jid);
      const job = await repository.getJob(ctx, jid);
      if (!job) throw failure('NOT_FOUND', 'Ingestion job not found.');
      await document(ctx, job.source_id, 'documents.read');
      return {
        id: job.id,
        sourceId: job.source_id,
        version: job.version,
        state: job.state,
        progress: job.progress,
        phase: job.phase,
        error: job.error,
        diagnostics: job.diagnostics,
      };
    },
    cleanup: gc,
    async ingest(ctx, jid, { signal, ownerId = randomUUID() } = {}) {
      ctx = context(ctx);
      const existing = await repository.getJob(ctx, jid);
      if (!existing || ['completed', 'failed', 'cancelled'].includes(existing.state)) return;
      await document(ctx, existing.source_id, 'documents.write');
      const lease = await repository.claim(ctx, jid, ownerId);
      if (!lease) return;
      const abort = new AbortController();
      const combined = signal
        ? AbortSignal.any([signal, abort.signal, AbortSignal.timeout(budgets.jobMs)])
        : AbortSignal.any([abort.signal, AbortSignal.timeout(budgets.jobMs)]);
      let heartbeatBusy = false;
      async function live(progress, phase) {
        checkSignal(combined);
        await document(ctx, lease.source_id, 'documents.write');
        if (!(await repository.progress(ctx, lease, progress, phase))) {
          abort.abort(failure('CONFLICT', 'Ingestion was cancelled or superseded.'));
          checkSignal(combined);
        }
        lease.progress = progress;
        lease.phase = phase;
      }
      const heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        live(lease.progress, lease.phase)
          .catch((e) => abort.abort(e))
          .finally(() => (heartbeatBusy = false));
      }, 3000);
      try {
        const input = lease.source.input;
        let extraction;
        if (input.text !== undefined)
          extraction = { segments: [{ text: input.text }], method: 'text', warnings: [] };
        else if (input.blob) {
          await live(5, 'reading');
          const bytes = await blobs.get(ctx, input.blob.key);
          if (bytes.length !== input.blob.bytes || hash(bytes) !== input.blob.sha256)
            throw failure(
              'VALIDATION_ERROR',
              'Blob integrity failed; upload the original file again.',
            );
          extraction = await parseFile(bytes, input.name, {
            signal: combined,
            ocr,
            transcribe: transcribe
              ? async (b, o) => {
                  await live(10, 'transcribing');
                  return transcribe(ctx, b, o);
                }
              : undefined,
            budgets,
            contentType: input.blob.contentType,
          });
        } else {
          const { robotsPolicy } = await import('./website.js');
          const robots = await outbound.fetch(ctx, new URL('/robots.txt', input.url).href, {
            signal: combined,
            maximumBytes: 200000,
            redirect: 'error',
          });
          if (robots.status >= 500 || robots.status === 429)
            throw failure(
              'DEPENDENCY_UNAVAILABLE',
              'Robots policy is unavailable; retry ingestion later.',
              true,
            );
          const policy = robotsPolicy(
            [401, 403].includes(robots.status)
              ? 'User-agent: *\nDisallow: /'
              : robots.ok
                ? await boundedText(robots, 200000, combined)
                : '',
          );
          if (!policy.allowed(input.url))
            throw failure('FORBIDDEN', 'Website robots policy disallows this page.');
          await live(5, 'fetching');
          const response = await outbound.fetch(ctx, input.url, {
            signal: combined,
            maximumBytes: budgets.bytes,
            redirect: 'error',
          });
          if (!response.ok)
            throw failure(
              'DEPENDENCY_UNAVAILABLE',
              'Website could not be fetched; verify its availability and outbound policy.',
              response.status >= 500,
            );
          if (!/^text\/html\b/i.test(response.headers.get('content-type') || ''))
            throw failure('VALIDATION_ERROR', 'Website ingestion requires an HTML response.');
          const html = await boundedText(response, budgets.bytes, combined);
          extraction = await parseFile(Buffer.from(html), 'website.html', {
            signal: combined,
            budgets,
          });
        }
        if (extraction.segments.reduce((n, s) => n + s.text.length, 0) > budgets.characters)
          throw failure('BUDGET_EXCEEDED', 'Extracted text exceeds the processing budget.');
        await live(20, 'chunking');
        lease.version = await repository.snapshot(ctx, lease, extraction);
        lease.source.version = lease.version;
        const chunks = chunksFor(lease.source, extraction, chunking);
        if (chunks.length > budgets.chunks)
          throw failure('BUDGET_EXCEEDED', 'Document exceeds the configured chunk budget.');
        for (let i = 0; i < chunks.length; i += budgets.batchSize) {
          await live(Math.round(20 + (70 * i) / chunks.length), 'embedding');
          const batch = chunks.slice(i, i + budgets.batchSize);
          const vectors = normalizeVectors(
            await embeddings.embed(
              ctx,
              batch.map((c) => c.content),
              { signal: combined },
            ),
            batch.length,
          );
          batch.forEach((c, j) => (c.vector = vectors[j]));
        }
        let crawl;
        if (input.url && Number(input.metadata.crawlMaxPages) > 1) {
          await live(90, 'crawling');
          const { createWebsiteCrawler } = await import('./website.js');
          crawl = await createWebsiteCrawler({ pipeline, outbound })(
            ctx,
            input.collectionId,
            input.url,
            {
              maxPages: Number(input.metadata.crawlMaxPages),
              access: input.access,
              signal: combined,
              skipSourceId: lease.source_id,
              onProgress: () => live(90, 'crawling'),
            },
          );
        }
        await repository.details(ctx, lease, {
          chunks: chunks.length,
          method: extraction.method,
          characters: extraction.segments.reduce((n, s) => n + s.text.length, 0),
          embeddingModel: embeddings.model,
          ...(crawl ? { crawl } : {}),
        });
        await live(95, 'publishing');
        checkSignal(combined);
        const published = await repository.finish(ctx, lease, chunks, embeddings.model);
        return { published, chunks: chunks.length, method: extraction.method };
      } catch (error) {
        const known = error?.name === 'PlatformError';
        await repository.fail(ctx, lease, {
          code: known ? error.code : 'DEPENDENCY_UNAVAILABLE',
          message: known
            ? error.message
            : 'Processing failed; verify parser/provider configuration and retry ingestion.',
          retryable: known ? error.retryable : true,
        });
        // Queue stores only its own generic failure. Detailed authorized diagnostics are in the DB.
        throw failure('DEPENDENCY_UNAVAILABLE', 'Document ingestion failed.');
      } finally {
        clearInterval(heartbeat);
        abort.abort();
      }
    },
    async handleJob(job, { resolveContext, signal } = {}) {
      job = jobSchema.parse(job);
      if (job.kind !== 'source.ingest')
        throw failure('VALIDATION_ERROR', 'Unsupported knowledge job kind.');
      if (!resolveContext)
        throw failure('FORBIDDEN', 'Worker requires security context revalidation.');
      const ctx = await resolveContext(job);
      context(ctx);
      if (ctx.workspaceId !== job.workspaceId)
        throw failure('FORBIDDEN', 'Worker context does not match job workspace.');
      const stored = await repository.getJob(ctx, job.resourceId);
      if (
        !stored ||
        stored.id !== job.id ||
        stored.context.actor.id !== ctx.actor.id ||
        stored.context.actor.kind !== ctx.actor.kind
      )
        throw failure('FORBIDDEN', 'Worker identity must match the persisted ingestion actor.');
      return pipeline.ingest(ctx, job.resourceId, { signal });
    },
  };
  return pipeline;
}
export async function boundedText(response, max, signal) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      checkSignal(signal);
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > max)
        throw failure('BUDGET_EXCEEDED', 'Website response exceeds the crawl byte budget.');
      chunks.push(Buffer.from(r.value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
