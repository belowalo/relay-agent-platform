import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribution, corpusDocument } from '../load/measure.mjs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scoreQuality } from './quality-scoring.mjs';
test('qualification profiles freeze production thresholds before measurement', async () => {
  const profiles = JSON.parse(await fs.readFile(new URL('../load/profiles.json', import.meta.url)));
  assert.equal(profiles.soak.durationSeconds, 3600);
  assert.equal(profiles.soak.workspaces * profiles.soak.usersPerWorkspace, 100);
  assert.equal(profiles.soak.concurrency, 25);
  assert.equal(profiles.soak.documents, 5000);
  assert.equal(profiles.soak.documents * profiles.soak.chunksPerDocument, 50000);
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null, p99: null, max: null });
  assert.equal(distribution(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
  assert.equal(profiles.thresholds.apiP95Ms, 300);
  assert.equal(profiles.thresholds.retrievalP95Ms, 1000);
  assert.equal(profiles.thresholds.dispatchP95Ms, 2000);
  assert.equal(corpusDocument(42, 10), corpusDocument(42, 10));
});
test('quality qualification requires review bound to the exact cases, counts unsupported citations and fails incorrect answers', () => {
  const cases = Array.from({ length: 50 }, (_, i) => ({
    id: `case-${i}`,
    retrievedExpectedSource: true,
    status: 'completed',
    streamedTokens: true,
    usage: { inputTokens: 20 },
  }));
  const thresholds = { recallAt5: 0.85, citationSupportPrecision: 0.95, answerCorrectness: 0.85 };
  assert.equal(scoreQuality(cases, null, 'benchmark', thresholds).verdict, 'blocked');
  const review = {
    benchmarkHash: 'benchmark',
    resultsHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    reviewer: 'Independent synthetic reviewer',
    reviewedAt: '2026-10-05',
    cases: cases.map((c) => ({
      id: c.id,
      answerCorrect: true,
      citationsTotal: 1,
      citationsSupported: 1,
    })),
  };
  assert.equal(scoreQuality(cases, review, 'benchmark', thresholds).verdict, 'passed');
  const unsupported = structuredClone(review);
  unsupported.cases[0].citationsSupported = 0;
  unsupported.cases[1].citationsSupported = 0;
  unsupported.cases[2].citationsSupported = 0;
  assert.equal(scoreQuality(cases, unsupported, 'benchmark', thresholds).verdict, 'failed');
  const stale = { ...review, resultsHash: 'old-output' };
  assert.throws(() => scoreQuality(cases, stale, 'benchmark', thresholds), /exact answers/);
});
