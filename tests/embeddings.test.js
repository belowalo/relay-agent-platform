import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-embeddings-'));
process.env.DATA_DIR = dir;
process.env.EMBEDDING_CACHE_DIR = path.resolve('data/models');
after(async () => {
  const { db } = await import('../server/db.js');
  db.close();
  if (
    !path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(dir).startsWith('relay-embeddings-')
  )
    throw new Error('Unexpected test path');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('local CPU embeddings rank a medical paraphrase above an unrelated passage without API credentials', async () => {
  const { embed, similarity } = await import('../server/embeddings.js');
  const vectors = await embed(
    'local-embedding-test',
    [
      'A physician treats patients with illness.',
      'A doctor helps people who are sick.',
      'A mechanic repairs a broken car engine.',
    ],
    {},
  );
  assert.equal(vectors.length, 3);
  assert.equal(vectors[0].length, 384);
  const medical = similarity(vectors[0], vectors[1]),
    unrelated = similarity(vectors[0], vectors[2]);
  assert.ok(
    medical > unrelated + 0.15,
    `Paraphrase similarity ${medical} vs unrelated ${unrelated}`,
  );
  assert.ok(Math.abs(similarity(vectors[0], vectors[0]) - 1) < 0.001);
});
