import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = workerData.cacheDir;
const model = 'Xenova/all-MiniLM-L6-v2';
let extractor;
let queue = Promise.resolve();
parentPort.on('message', ({ id, texts }) => {
  queue = queue.then(async () => {
    try {
      extractor ||= await pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu' });
      const result = await extractor(texts, { pooling: 'mean', normalize: true });
      parentPort.postMessage({ id, vectors: result.tolist() });
    } catch (error) {
      parentPort.postMessage({ id, error: `Local embedding model failed: ${error.message}` });
    }
  });
});
