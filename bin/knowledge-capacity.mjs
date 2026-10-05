import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harness, ctx, input } from '../tests/knowledge/helpers.js';
import { createRetriever } from '../server/knowledge/retrieval.js';
import { embeddedPostgres } from '../tests/knowledge/embedded-postgres.js';

const count = Number(process.env.KNOWLEDGE_CAPACITY_CHUNKS || 50000);
if (!Number.isInteger(count) || count < 100 || count > 100000)
  throw Error('Capacity size must be 100–100000.');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-knowledge-capacity-'));
const pgMode = process.env.KNOWLEDGE_CAPACITY_BACKEND === 'pglite';
const filename = path.join(dir, 'capacity.sqlite');
const h = pgMode ? await embeddedPostgres() : await harness({ filename });
const vector = Array(384).fill(0);
vector[0] = 1;
function fixtureVector(n) {
  const result = [...vector];
  let seed = n + 1;
  for (let i = 1; i < 8; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    result[i] = seed / 4294967296 - 0.5;
  }
  const norm = Math.hypot(...result);
  return result.map((v) => v / norm);
}
const embeddings = {
  model: 'capacity-fixture-384',
  async embed(c, texts) {
    return texts.map(() => vector);
  },
};
const retrieve = createRetriever({ repository: h.repository, security: h.security, embeddings });
try {
  const start = performance.now();
  for (let offset = 0; offset < count; offset += 1000) {
    const document = await h.pipeline.upsert(
      ctx(),
      input('capacity_' + offset, 'Capacity storage benchmark.'),
    );
    const lease = await h.repository.claim(ctx(), document.jobId, 'capacity-worker');
    const chunks = Array.from({ length: Math.min(1000, count - offset) }, (_, i) => ({
      id: 'cap_' + (offset + i),
      ordinal: i,
      content:
        `Capacity document passage ${offset + i}. UniqueTerm${offset + i} defines a synthetic operating policy. `.repeat(
          8,
        ),
      location: { start: i * 800, end: i * 800 + 800 },
      vector: pgMode ? fixtureVector(offset + i) : vector,
    }));
    if (!(await h.repository.finish(ctx(), lease, chunks, embeddings.model)))
      throw Error('Capacity publication failed');
  }
  const indexingMs = performance.now() - start;
  if (pgMode)
    await h.pg.exec(
      'ANALYZE relay.knowledge_sources; ANALYZE relay.knowledge_chunks; ANALYZE relay.knowledge_vectors;',
    );
  const modes = {};
  for (const mode of ['keyword', 'vector', 'hybrid']) {
    await retrieve(ctx(), 'manual', 'UniqueTerm17', { mode });
    const times = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await retrieve(ctx(), 'manual', 'UniqueTerm' + i * 997, { mode });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    modes[mode] = {
      requests: times.length,
      p50Ms: times[5],
      p95Ms: times[9],
      maximumMs: times.at(-1),
    };
  }
  let databaseBytes, annRecallAt5, vectorPlan;
  if (pgMode) {
    databaseBytes = Number(
      (
        await h.pg.query(
          "SELECT pg_total_relation_size('relay.knowledge_vectors')+pg_total_relation_size('relay.knowledge_chunks') AS bytes",
        )
      ).rows[0].bytes,
    );
    let hits = 0,
      total = 0;
    for (let i = 0; i < 10; i++) {
      const q = fixtureVector(i * 997),
        options = { mode: 'vector', topK: 5, metadata: {} };
      const approximate = await h.repository.candidates(
        ctx(),
        'manual',
        '',
        q,
        options,
        ['user:alice'],
        embeddings.model,
      );
      if (i === 0) {
        const plan = await h.explainVector(ctx());
        const nodes = [],
          indexes = [];
        function walk(p) {
          if (p['Node Type']) nodes.push(p['Node Type']);
          if (p['Index Name']) indexes.push(p['Index Name']);
          for (const child of p.Plans || []) walk(child);
        }
        walk(plan[0].Plan);
        vectorPlan = { nodes, indexes, hnswUsed: indexes.includes('knowledge_vectors_ann') };
      }
      const exact = await h.repository.candidates(
        ctx(),
        'manual',
        '',
        q,
        { ...options, exact: true },
        ['user:alice'],
        embeddings.model,
      );
      const ids = new Set(approximate.semantic.slice(0, 5).map((r) => r.id));
      total += 5;
      hits += exact.semantic.slice(0, 5).filter((r) => ids.has(r.id)).length;
    }
    annRecallAt5 = hits / total;
  } else {
    const stat = await fs.stat(filename);
    const wal = await fs.stat(filename + '-wal').catch(() => ({ size: 0 }));
    databaseBytes = stat.size + wal.size;
  }
  const report = {
    profile: pgMode
      ? 'embedded actual PostgreSQL/pgvector 0.8.1 WASM, restricted role, single connection; not networked/concurrent production qualification'
      : 'single-process SQLite development adapter; exact vector scan, not PostgreSQL/HNSW or concurrent production qualification',
    embeddingMode: 'fixture precomputed unit vectors; excludes model/extraction time',
    chunks: count,
    dimensions: 384,
    indexingMs,
    chunksPerSecond: count / (indexingMs / 1000),
    databaseBytes,
    rssBytes: process.memoryUsage().rss,
    cpu: os.cpus()[0]?.model,
    cpuCount: os.availableParallelism(),
    node: process.version,
    modes,
    ...(pgMode
      ? {
          sampledVectorSearchRecallAt5: annRecallAt5,
          sampleQueries: 10,
          vectorPlan,
          statistics: 'ANALYZE before retrieval',
        }
      : {}),
  };
  const output =
    process.env.KNOWLEDGE_CAPACITY_OUTPUT ||
    (pgMode
      ? 'docs/production/evidence/knowledge-pgvector-capacity.json'
      : 'docs/production/evidence/knowledge-capacity.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await h.close();
  await fs.rm(dir, { recursive: true, force: true });
}
