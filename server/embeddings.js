import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { one, decode, decrypt, dataDir } from './db.js';
import { safeFetch, responseText } from './network.js';
let worker,
  sequence = 0;
const pending = new Map();
export const localEmbeddingModel = 'Xenova/all-MiniLM-L6-v2';
function local(texts) {
  if (!worker) {
    worker = new Worker(new URL('./embedding-worker.js', import.meta.url), {
      workerData: {
        cacheDir: path.resolve(process.env.EMBEDDING_CACHE_DIR || path.join(dataDir, 'models')),
      },
      execArgv: [],
    });
    worker.on('message', (message) => {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id);
      message.error ? p.reject(new Error(message.error)) : p.resolve(message.vectors);
      if (!pending.size) worker?.unref();
    });
    worker.on('error', (error) => {
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      worker = null;
    });
    worker.unref();
  }
  worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, texts });
  });
}
export function embeddingIdentity(config) {
  return config.embeddingConnectionId
    ? `${config.embeddingConnectionId}:${config.embeddingModel}`
    : localEmbeddingModel;
}
export async function embed(wid, texts, config = {}) {
  let vectors;
  if (!config.embeddingConnectionId) vectors = await local(texts);
  else {
    const c = one(
      'SELECT * FROM connections WHERE id=? AND workspace_id=?',
      config.embeddingConnectionId,
      wid,
    );
    if (!c) throw new Error('Embedding connection was not found in this workspace');
    if (!config.embeddingModel) throw new Error('Choose an embedding model identifier');
    const r = await safeFetch(
      c.endpoint.replace(/\/$/, '') + '/embeddings',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${decrypt(c.secret)}`,
        },
        body: JSON.stringify({ model: config.embeddingModel, input: texts }),
        signal: AbortSignal.timeout(60000),
        noRedirect: true,
      },
      !!decode(c.config).allowPrivate,
    );
    if (!r.ok) throw new Error(`Embedding provider returned HTTP ${r.status}`);
    const data = JSON.parse(await responseText(r));
    vectors = data.data?.sort((a, b) => a.index - b.index).map((row) => row.embedding);
  }
  if (
    !Array.isArray(vectors) ||
    vectors.length !== texts.length ||
    vectors.some(
      (v) =>
        !Array.isArray(v) || !v.length || v.length > 8192 || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw new Error('Embedding provider returned invalid vectors');
  const dimension = vectors[0].length;
  if (vectors.some((v) => v.length !== dimension))
    throw new Error('Embedding dimensions do not match');
  return vectors.map((v) => {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}
export function similarity(a, b) {
  if (a.length !== b.length)
    throw new Error('Embedding model dimensions changed; reindex this collection');
  return a.reduce((s, x, i) => s + x * b[i], 0);
}
