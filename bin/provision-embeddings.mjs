import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';
env.cacheDir = path.resolve(process.argv[2] || 'data/models');
env.allowRemoteModels = true;
const model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  dtype: 'q8',
  device: 'cpu',
});
const v = await model('Verify the provisioned embedding model.', {
  pooling: 'mean',
  normalize: true,
});
if (v.tolist()[0].length !== 384) throw new Error('Unexpected embedding dimension');
console.log(
  JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'q8',
    dimension: 384,
    cacheProvisioned: true,
  }),
);
