import crypto from 'node:crypto';
import { invalid, ConnectorError } from './core.js';

/** Convert native document results through BlobPort; never mutate knowledge chunks. */
export async function documentFromResult(context, result, { blobs, collectionId, access }) {
  const d = result.data;
  if (!d?.externalId || !d.name || (!d.bytes && typeof d.text !== 'string'))
    throw invalid('Connector did not return a document.');
  const input = {
    collectionId,
    externalId: d.externalId,
    name: d.name,
    metadata: { revision: d.revision || '', ...(d.url ? { url: d.url } : {}) },
    access: structuredClone(access),
  };
  if (d.bytes) {
    if (!blobs?.put) throw invalid('Binary documents require BlobPort.');
    input.blob = await blobs.put(
      context,
      crypto.randomUUID(),
      d.bytes,
      d.contentType || 'application/octet-stream',
    );
  } else input.text = d.text;
  return input;
}

/** StatePort must implement fenced exclusive leases + durable per-item revision/tombstone records.
 * Commit only after DocumentPort succeeds. Document upsert must deduplicate externalId + revision.
 * Page checkpoints alone are unsafe after an interruption mid-page.
 */
export async function synchronizeDocuments(
  context,
  {
    connector,
    secretRef,
    documents,
    state,
    sourceId,
    signal,
    maxPages = 100,
    maxItems = 10000,
    loadPage,
    loadDocument,
  },
) {
  if (
    !documents?.upsert ||
    !documents?.delete ||
    !state?.withLease ||
    !loadPage ||
    !loadDocument ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000 ||
    !Number.isInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 100000
  )
    throw invalid('Synchronization requires DocumentPort, fenced state and bounded page loaders.');
  return state.withLease(context, sourceId, async (checkpoint) => {
    let cursor = checkpoint.cursor,
      items = 0,
      pages = 0;
    const seen = new Set();
    while (pages < maxPages) {
      signal.throwIfAborted();
      await checkpoint.assertCurrent();
      const page = await loadPage({ context, connector, secretRef, cursor, signal });
      if (!Array.isArray(page.items)) throw invalid('Synchronization page must contain items.');
      for (const item of page.items) {
        if (++items > maxItems)
          throw invalid(
            'Synchronization item budget exceeded; resume from the persisted checkpoint.',
          );
        signal.throwIfAborted();
        await checkpoint.assertCurrent();
        const previous = await checkpoint.getItem(item.externalId);
        if (item.removed) {
          if (previous?.sourceId && !previous.removed) {
            await documents.delete(context, previous.sourceId);
            await checkpoint.recordItem(item.externalId, { ...previous, removed: true });
          }
          continue;
        }
        if (
          previous &&
          item.revision !== undefined &&
          previous.revision === item.revision &&
          !previous.removed
        )
          continue;
        const input = await loadDocument(item, { context, connector, secretRef, signal });
        signal.throwIfAborted();
        await checkpoint.assertCurrent();
        if (
          previous &&
          item.revision !== undefined &&
          previous.revision === item.revision &&
          !previous.removed
        )
          continue;
        const result = await documents.upsert(context, input);
        await checkpoint.recordItem(item.externalId, {
          sourceId: result.sourceId,
          revision: item.revision,
          removed: false,
        });
      }
      pages++;
      await checkpoint.assertCurrent();
      await checkpoint.commitCursor(page.nextCursor ?? cursor);
      cursor = page.nextCursor;
      if (!cursor || page.checkpoint) return { items, pages, cursor, complete: true };
      if (seen.has(cursor))
        throw new ConnectorError(
          'DEPENDENCY_UNAVAILABLE',
          'Provider repeated a synchronization cursor.',
        );
      seen.add(cursor);
    }
    return { items, pages, cursor, complete: false };
  });
}
