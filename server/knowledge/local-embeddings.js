import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { failure, checkSignal, normalizeVectors } from './contracts.js';
export function createLocalEmbeddings({
  cacheDir,
  allowDownload = false,
  timeoutMs = 120000,
  maxPending = 64,
} = {}) {
  if (!cacheDir) throw failure('VALIDATION_ERROR', 'Configure a local embedding cache directory.');
  if (allowDownload)
    throw failure(
      'FORBIDDEN',
      'Production embeddings operate offline; provision model files before starting workers.',
    );
  if (
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 64 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    throw failure('VALIDATION_ERROR', 'Local embedding queue/time budgets are invalid.');
  let worker,
    sequence = 0,
    closed = false;
  const pending = new Map();
  // Cancelled requests still occupy the worker's serialized queue until it acknowledges them.
  const inFlight = new Set();
  function start() {
    if (worker) return;
    const instance = new Worker(new URL('../embedding-worker.js', import.meta.url), {
      workerData: { cacheDir: path.resolve(cacheDir), allowRemoteModels: allowDownload },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    worker = instance;
    worker.on('message', (m) => {
      if (worker !== instance) return;
      inFlight.delete(m.id);
      const entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      entry.finish();
      m.error
        ? entry.reject(
            failure(
              'DEPENDENCY_UNAVAILABLE',
              'Local embeddings unavailable; prefetch the configured model into the cache.',
            ),
          )
        : entry.resolve(m.vectors);
      if (!pending.size) worker?.unref();
    });
    worker.on('error', () => {
      if (worker !== instance) return;
      for (const p of pending.values()) {
        p.finish();
        p.reject(failure('DEPENDENCY_UNAVAILABLE', 'Local embedding worker failed.'));
      }
      pending.clear();
      inFlight.clear();
      worker = null;
    });
    worker.unref();
  }
  return {
    model: 'Xenova/all-MiniLM-L6-v2',
    async embed(ctx, texts, { signal } = {}) {
      if (closed) throw failure('DEPENDENCY_UNAVAILABLE', 'Embedding adapter is closed.');
      checkSignal(signal);
      if (
        !Array.isArray(texts) ||
        !texts.length ||
        texts.length > 16 ||
        texts.some((t) => typeof t !== 'string' || t.length > 8000)
      )
        throw failure(
          'VALIDATION_ERROR',
          'Embedding batches must contain 1–16 bounded text inputs.',
        );
      if (inFlight.size >= maxPending)
        throw failure('RATE_LIMITED', 'Local embedding queue is full; retry later.', true);
      start();
      worker.ref();
      const id = ++sequence;
      const vectors = await new Promise((resolve, reject) => {
        const cancel = () => {
          pending.delete(id);
          finish();
          reject(
            signal?.reason || failure('BUDGET_EXCEEDED', 'Local embedding time budget exceeded.'),
          );
          if (!pending.size) {
            const old = worker;
            worker = null;
            inFlight.clear();
            old?.terminate();
          }
        };
        const timer = setTimeout(cancel, timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        };
        pending.set(id, { resolve, reject, finish });
        inFlight.add(id);
        signal?.addEventListener('abort', cancel, { once: true });
        worker.postMessage({ id, texts });
      });
      return normalizeVectors(vectors, texts.length);
    },
    async close() {
      closed = true;
      const old = worker;
      worker = null;
      for (const p of pending.values()) {
        p.finish();
        p.reject(failure('DEPENDENCY_UNAVAILABLE', 'Embedding adapter closed.'));
      }
      pending.clear();
      inFlight.clear();
      await old?.terminate();
    },
  };
}
