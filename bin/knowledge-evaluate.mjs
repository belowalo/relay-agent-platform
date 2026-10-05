import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { harness, ctx, input, fixtureEmbeddings } from '../tests/knowledge/helpers.js';
import { createLocalEmbeddings } from '../server/knowledge/local-embeddings.js';
import { createGroundedAnswer } from '../server/knowledge/grounded.js';

const corpus = JSON.parse(
  await fs.readFile(new URL('../tests/knowledge/corpus.json', import.meta.url), 'utf8'),
);
const useFixture = process.argv.includes('--fixture-embeddings');
const embeddings = useFixture
  ? fixtureEmbeddings
  : createLocalEmbeddings({
      cacheDir: process.env.EMBEDDING_CACHE_DIR || path.resolve('data/models'),
    });
let live;
if (process.env.KNOWLEDGE_EVAL_ADAPTER)
  live = await import(pathToFileURL(path.resolve(process.env.KNOWLEDGE_EVAL_ADAPTER)).href);
const h = await harness({ embeddings });
const ids = new Map(),
  cases = [];
const quoteFixture = async (c, p) => {
  const subject = p.question.match(/for (.*?)\?/i)?.[1]?.toLowerCase();
  const matching = p.evidence.filter(
    (e) => e.metadata.state === 'current' && (!subject || e.text.toLowerCase().includes(subject)),
  );
  if (!matching.length) return { insufficient: true, claims: [], conflict: false };
  const lines = matching.flatMap((e) =>
    e.text
      .split('\n')
      .filter((t) => t.startsWith('Policy: '))
      .map((t) => ({ text: t, references: [{ chunkId: e.chunkId, quote: t }] })),
  );
  return {
    insufficient: !lines.length,
    claims: lines.slice(0, 2),
    conflict: new Set(lines.map((l) => l.text)).size > 1,
  };
};
const answer = createGroundedAnswer({
  retrieve: h.retrieve,
  generate: live?.generate || quoteFixture,
  verifyClaim: live?.verifyClaim,
  security: h.security,
  repository: h.repository,
});
try {
  const start = performance.now();
  for (const d of corpus.documents) {
    const r = await h.add(
      ctx(d.workspace || 'alpha'),
      input(d.id, d.text, {
        metadata: d.metadata,
        access: d.access || { mode: 'workspace', principalIds: [] },
      }),
    );
    ids.set(d.id, r.sourceId);
  }
  const ingestionMs = performance.now() - start;
  for (const q of corpus.questions) {
    const c = ctx(q.workspace || 'alpha', q.actor || 'alice');
    const retrieval = await h.retrieve(c, 'manual', q.question, {
      mode: 'hybrid',
      topK: 5,
      maxPerSource: 1,
    });
    const expected = q.relevant.map((id) => ids.get(id));
    const ranked = retrieval.evidence.map((e) => e.citation.sourceId),
      hits = expected.filter((id) => ranked.includes(id)).length;
    let generated, error;
    try {
      generated = await answer(c, 'manual', q.question, {
        mode: 'hybrid',
        topK: 5,
        maxPerSource: 1,
      });
    } catch (e) {
      error = e.code || 'ERROR';
    }
    const correct =
      generated &&
      (q.insufficient
        ? generated.insufficient
        : q.expected.every((s) => generated.text.includes(s)) &&
          (!q.conflict || generated.conflict));
    const citations = generated?.claims.flatMap((cl) => cl.references) || [];
    const supported = citations.filter((ref) =>
      retrieval.evidence.some(
        (e) => e.citation.chunkId === ref.chunkId && e.citation.text.includes(ref.quote),
      ),
    ).length;
    const leaks = retrieval.evidence.filter(
      (e) =>
        e.citation.workspaceId !== c.workspaceId ||
        (e.citation.text.includes('RESTRICTED_CANARY') && c.actor.id !== 'alice'),
    ).length;
    const rank = ranked.findIndex((id) => expected.includes(id));
    cases.push({
      id: q.id,
      kind: q.kind,
      relevant: expected.length,
      hits,
      recallAt5: expected.length ? hits / expected.length : null,
      reciprocalRank: expected.length ? (rank < 0 ? 0 : 1 / (rank + 1)) : null,
      correct: !!correct,
      abstained: generated?.insufficient || false,
      conflict: generated?.conflict || false,
      citations: citations.length,
      supportedCitations: supported,
      leaks,
      latencyMs: retrieval.diagnostics.durationMs,
      ...(error ? { error } : {}),
    });
  }
  const relevant = cases.filter((c) => c.recallAt5 !== null),
    latencies = cases.map((c) => c.latencyMs).sort((a, b) => a - b);
  const summary = {
    corpusVersion: corpus.version,
    documents: corpus.documents.length,
    questions: cases.length,
    embeddingMode: useFixture ? 'fixture hash vectors' : 'actual local CPU MiniLM 384-dimensional',
    answerMode: live ? 'configured real model adapter' : 'fixture extractive model (no live model)',
    authorizationMode: 'fixture security against actual SQLite query filters',
    repository: 'actual SQLite development, exact cosine + FTS5; not PostgreSQL/HNSW qualification',
    ingestionMs,
    recallAt5: relevant.reduce((n, c) => n + c.recallAt5, 0) / relevant.length,
    mrr: relevant.reduce((n, c) => n + c.reciprocalRank, 0) / relevant.length,
    answerCorrectness: cases.filter((c) => c.correct).length / cases.length,
    citationAccuracy:
      cases.reduce((n, c) => n + c.supportedCitations, 0) /
      Math.max(
        1,
        cases.reduce((n, c) => n + c.citations, 0),
      ),
    insufficientBehavior: cases.filter((c) => c.kind === 'insufficient').every((c) => c.abstained),
    isolationLeaks: cases.reduce((n, c) => n + c.leaks, 0),
    retrievalP95Ms: latencies[Math.floor(latencies.length * 0.95)],
    liveHumanReview: 'not performed; K03 remains unqualified',
    capacityProfile: 'single process synthetic corpus',
  };
  const report = { summary, cases };
  const output =
    process.env.KNOWLEDGE_EVAL_OUTPUT || 'docs/production/evidence/knowledge-evaluation.json';
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await h.close();
  await embeddings.close?.();
  await live?.close?.();
}
