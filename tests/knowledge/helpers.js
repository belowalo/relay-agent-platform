import { createSqliteKnowledge } from '../../server/knowledge/sqlite.js';
import { createKnowledgePipeline } from '../../server/knowledge/pipeline.js';
import { createRetriever } from '../../server/knowledge/retrieval.js';
import { failure } from '../../server/knowledge/contracts.js';
import { hash } from '../../server/knowledge/chunks.js';
export const ctx = (workspaceId = 'alpha', id = 'alice') => ({
  workspaceId,
  actor: { kind: 'user', id },
  requestId: 'test-request',
});
export const input = (externalId, text, extra = {}) => ({
  collectionId: 'manual',
  externalId,
  name: externalId + '.txt',
  text,
  metadata: {},
  access: { mode: 'workspace', principalIds: [] },
  ...extra,
});
// Fixture security only. Production uses createKnowledgeSecurity and security-owned authorization.
export function fixtureSecurity() {
  let revoked = false;
  return {
    async authorizeCleanup(c) {
      await this.authorize(c, {});
    },
    revoke() {
      revoked = true;
    },
    async authorize(c, r) {
      if (
        revoked ||
        c.actor.id === 'outsider' ||
        (r.access?.mode === 'restricted' && !r.access.principalIds.includes(`user:${c.actor.id}`))
      )
        throw failure('FORBIDDEN', 'Fixture permission denied.');
    },
    async documentPrincipals(c) {
      return [`user:${c.actor.id}`];
    },
  };
}
export const fixtureEmbeddings = {
  model: 'fixture-hash-384',
  async embed(c, texts) {
    return texts.map((t) => {
      const v = Array(384).fill(0);
      for (const word of t.toLowerCase().match(/[a-z0-9]+/g) || [])
        v[parseInt(hash(word).slice(0, 8), 16) % 384]++;
      return v;
    });
  },
};
export async function harness({
  embeddings = fixtureEmbeddings,
  outbound,
  filename,
  ocr,
  transcribe,
  budgets,
  chunking,
} = {}) {
  const repository = createSqliteKnowledge(filename),
    security = fixtureSecurity(),
    store = new Map();
  const blobs = {
    async put(c, key, data, contentType) {
      store.set(c.workspaceId + ':' + key, Buffer.from(data));
      return {
        workspaceId: c.workspaceId,
        key,
        bytes: data.length,
        sha256: hash(data),
        contentType,
      };
    },
    async get(c, key) {
      const b = store.get(c.workspaceId + ':' + key);
      if (!b) throw failure('NOT_FOUND', 'Blob not found.');
      return b;
    },
    async delete(c, key) {
      store.delete(c.workspaceId + ':' + key);
    },
  };
  outbound ||= {
    async fetch() {
      throw new Error('Network not configured in fixture');
    },
  };
  const pipeline = createKnowledgePipeline({
    repository,
    security,
    blobs,
    outbound,
    embeddings,
    ocr,
    transcribe,
    budgets,
    chunking,
  });
  const retrieve = createRetriever({ repository, security, embeddings });
  return {
    repository,
    security,
    blobs,
    store,
    pipeline,
    retrieve,
    async add(c, d) {
      const result = await pipeline.upsert(c, d);
      await pipeline.ingest(c, result.jobId);
      return result;
    },
    close: () => repository.close(),
  };
}
