import { invalid } from './core.js';
import { documentFromResult } from './sync.js';

const pack = (v) => JSON.stringify(v);
function unpack(cursor) {
  if (!cursor) return {};
  try {
    return JSON.parse(cursor);
  } catch {
    throw invalid('Source cursor is invalid; reset synchronization explicitly.');
  }
}
/** Ready-to-compose DocumentPort loaders. Folder selection is direct children; no implicit recursive expansion. */
export function createDocumentSource(kind, spec, { blobs, collectionId, access }) {
  if (
    !access ||
    !['workspace', 'restricted'].includes(access.mode) ||
    !Array.isArray(access.principalIds)
  )
    throw invalid('An explicit ingestion access policy is required.');
  if (kind === 'github' && (!spec.repository || !Array.isArray(spec.paths) || !spec.paths.length))
    throw invalid('Select repository document paths.');
  return {
    async loadPage({ context, connector, secretRef, cursor, signal }) {
      if (kind === 'github')
        return {
          items: spec.paths.map((path) => ({
            externalId: `github:${spec.repository}:${path}`,
            path,
            revision: undefined,
          })),
          checkpoint: true,
        };
      if (kind === 's3') {
        const r = await connector.invoke(context, {
          action: 'objects',
          input: { cursor },
          secretRef,
          signal,
        });
        return {
          items: r.data.map((o) => ({
            externalId: `s3:${spec.bucket}:${o.Key}`,
            key: o.Key,
            revision: o.ETag,
          })),
          nextCursor: r.nextCursor,
        };
      }
      if (kind === 'google-drive') {
        const saved = unpack(cursor);
        if (saved.phase === 'changes') {
          const r = await connector.invoke(context, {
            action: 'changes',
            input: { cursor: saved.token },
            secretRef,
            signal,
          });
          return {
            items: r.data.map((v) => ({
              externalId: 'drive:' + v.fileId,
              fileId: v.fileId,
              revision: String(v.file?.version || ''),
              removed: v.removed || v.file?.trashed,
            })),
            nextCursor: pack({ phase: 'changes', token: r.nextCursor }),
            checkpoint: r.checkpoint,
          };
        }
        const token =
          saved.token ||
          (
            await connector.invoke(context, {
              action: 'start_cursor',
              input: {},
              secretRef,
              signal,
            })
          ).nextCursor;
        const r = await connector.invoke(context, {
          action: 'files',
          input: { cursor: saved.page },
          secretRef,
          signal,
        });
        return {
          items: r.data
            .filter(
              (v) =>
                v.mimeType !== 'application/vnd.google-apps.folder' &&
                v.mimeType !== 'application/vnd.google-apps.shortcut',
            )
            .map((v) => ({
              externalId: 'drive:' + v.id,
              fileId: v.id,
              revision: String(v.version),
            })),
          nextCursor: pack(
            r.nextCursor
              ? { phase: 'initial', token, page: r.nextCursor }
              : { phase: 'changes', token },
          ),
          checkpoint: !r.nextCursor,
        };
      }
      throw invalid('This connector does not provide a document source loader.');
    },
    async loadDocument(item, { context, connector, secretRef, signal }) {
      const input =
        kind === 'github'
          ? { repository: spec.repository, path: item.path, ref: spec.ref }
          : kind === 's3'
            ? { key: item.key, etag: item.revision }
            : { fileId: item.fileId };
      const r = await connector.invoke(context, { action: 'document', input, secretRef, signal });
      // GitHub contents SHA is discovered at download; no inaccurate timestamp watermark.
      item.revision = String(r.data.revision || item.revision || '');
      return documentFromResult(context, r, { blobs, collectionId, access });
    },
  };
}
