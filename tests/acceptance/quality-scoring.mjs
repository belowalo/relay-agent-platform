import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export function scoreQuality(cases, review, benchmarkHash, thresholds) {
  const recallAt5 = cases.filter((c) => c.retrievedExpectedSource).length / cases.length;
  if (!review)
    return {
      verdict: 'blocked',
      recallAt5,
      citationSupportPrecision: null,
      answerCorrectness: null,
      reason:
        'An independent human review is required; execution success does not establish correctness',
    };
  assert.equal(review.benchmarkHash, benchmarkHash);
  assert.equal(
    review.resultsHash,
    createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    'Human review must refer to these exact answers and citations',
  );
  assert.ok(review.reviewer && review.reviewedAt);
  assert.equal(review.cases.length, cases.length);
  assert.equal(new Set(review.cases.map((c) => c.id)).size, cases.length);
  for (const item of cases) {
    const checked = review.cases.find((c) => c.id === item.id);
    assert.ok(checked);
    assert.equal(typeof checked.answerCorrect, 'boolean');
    assert.ok(Number.isInteger(checked.citationsTotal) && checked.citationsTotal >= 1);
    assert.ok(
      Number.isInteger(checked.citationsSupported) &&
        checked.citationsSupported >= 0 &&
        checked.citationsSupported <= checked.citationsTotal,
    );
  }
  const citationSupportPrecision =
    review.cases.reduce((sum, c) => sum + c.citationsSupported, 0) /
    review.cases.reduce((sum, c) => sum + c.citationsTotal, 0);
  const answerCorrectness = review.cases.filter((c) => c.answerCorrect).length / cases.length;
  return {
    verdict:
      recallAt5 >= thresholds.recallAt5 &&
      citationSupportPrecision >= thresholds.citationSupportPrecision &&
      answerCorrectness >= thresholds.answerCorrectness &&
      cases.every((c) => c.status === 'completed' && c.streamedTokens && c.usage.inputTokens > 0)
        ? 'passed'
        : 'failed',
    recallAt5,
    citationSupportPrecision,
    answerCorrectness,
  };
}
